use std::fs::{self, OpenOptions};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use reqwest::Client;
use sandbox_agent_agent_management::agents::{AgentId, AgentManager};
use tokio::sync::Mutex;
use tokio::time::sleep;
use tracing::warn;

const HEALTH_ENDPOINTS: [&str; 4] = ["health", "healthz", "app/agents", "agents"];
const HEALTH_ATTEMPTS: usize = 20;
const HEALTH_DELAY_MS: u64 = 150;
const MONITOR_DELAY_MS: u64 = 500;

#[derive(Debug, Clone)]
pub struct OpenCodeServerManagerConfig {
    pub log_dir: PathBuf,
    pub auto_restart: bool,
}

impl Default for OpenCodeServerManagerConfig {
    fn default() -> Self {
        Self {
            log_dir: default_log_dir(),
            auto_restart: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct OpenCodeServerManager {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    agent_manager: Arc<AgentManager>,
    http_client: Client,
    config: OpenCodeServerManagerConfig,
    ensure_lock: Mutex<()>,
    state: Mutex<ManagerState>,
}

#[derive(Debug, Default)]
struct ManagerState {
    server: Option<RunningServer>,
    restart_count: u64,
    shutdown_requested: bool,
    last_error: Option<String>,
}

#[derive(Debug, Clone)]
struct RunningServer {
    base_url: String,
    child: Arc<StdMutex<Option<Child>>>,
    instance_id: u64,
}

impl OpenCodeServerManager {
    pub fn new(agent_manager: Arc<AgentManager>, config: OpenCodeServerManagerConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                agent_manager,
                http_client: Client::new(),
                config,
                ensure_lock: Mutex::new(()),
                state: Mutex::new(ManagerState::default()),
            }),
        }
    }

    pub async fn ensure_server(&self) -> Result<String, String> {
        let _guard = self.inner.ensure_lock.lock().await;

        if let Some(base_url) = self.running_base_url().await {
            return Ok(base_url);
        }

        let (base_url, child) = self.spawn_http_server().await?;

        if let Err(err) = self.wait_for_http_server(&base_url).await {
            kill_child(&child);
            let mut state = self.inner.state.lock().await;
            state.last_error = Some(err.clone());
            return Err(err);
        }

        let instance_id = {
            let mut state = self.inner.state.lock().await;
            state.shutdown_requested = false;
            state.restart_count += 1;
            let instance_id = state.restart_count;
            state.server = Some(RunningServer {
                base_url: base_url.clone(),
                child: child.clone(),
                instance_id,
            });
            state.last_error = None;
            instance_id
        };

        self.spawn_monitor_task(instance_id, child);

        Ok(base_url)
    }

    pub async fn shutdown(&self) {
        let _guard = self.inner.ensure_lock.lock().await;

        let child = {
            let mut state = self.inner.state.lock().await;
            state.shutdown_requested = true;
            state.server.take().map(|server| server.child)
        };

        if let Some(child) = child {
            kill_child(&child);
        }
    }

    async fn running_base_url(&self) -> Option<String> {
        let running = {
            let state = self.inner.state.lock().await;
            state.server.clone()
        }?;

        if child_is_alive(&running.child) {
            return Some(running.base_url);
        }

        let mut state = self.inner.state.lock().await;
        if state
            .server
            .as_ref()
            .map(|server| server.instance_id == running.instance_id)
            .unwrap_or(false)
        {
            state.server = None;
        }

        None
    }

    async fn wait_for_http_server(&self, base_url: &str) -> Result<(), String> {
        for _ in 0..HEALTH_ATTEMPTS {
            for endpoint in HEALTH_ENDPOINTS {
                let url = format!("{base_url}/{endpoint}");
                match self.inner.http_client.get(&url).send().await {
                    Ok(response) if response.status().is_success() => return Ok(()),
                    Ok(_) | Err(_) => {}
                }
            }
            sleep(Duration::from_millis(HEALTH_DELAY_MS)).await;
        }

        Err("OpenCode server health check failed".to_string())
    }

    async fn spawn_http_server(&self) -> Result<(String, Arc<StdMutex<Option<Child>>>), String> {
        let agent_manager = self.inner.agent_manager.clone();
        let log_dir = self.inner.config.log_dir.clone();

        let (base_url, child) = tokio::task::spawn_blocking(move || {
            let path = agent_manager
                .resolve_binary(AgentId::Opencode)
                .map_err(|err| err.to_string())?;
            let port = find_available_port()?;
            let mut command = Command::new(path);
            let stderr = open_opencode_log(&log_dir).unwrap_or_else(|_| Stdio::null());
            command
                .arg("serve")
                .arg("--port")
                .arg(port.to_string())
                .stdout(Stdio::null())
                .stderr(stderr);

            let child = command.spawn().map_err(|err| err.to_string())?;
            Ok::<(String, Child), String>((format!("http://127.0.0.1:{port}"), child))
        })
        .await
        .map_err(|err| err.to_string())??;

        Ok((base_url, Arc::new(StdMutex::new(Some(child)))))
    }

    fn spawn_monitor_task(&self, instance_id: u64, child: Arc<StdMutex<Option<Child>>>) {
        let manager = self.clone();
        tokio::spawn(async move {
            loop {
                let status = {
                    let mut guard = match child.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    match guard.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(status) => status,
                            Err(_) => None,
                        },
                        None => return,
                    }
                };

                if let Some(status) = status {
                    manager.handle_process_exit(instance_id, status).await;
                    return;
                }

                sleep(Duration::from_millis(MONITOR_DELAY_MS)).await;
            }
        });
    }

    async fn handle_process_exit(&self, instance_id: u64, status: ExitStatus) {
        let (should_restart, error_message) = {
            let mut state = self.inner.state.lock().await;
            let Some(server) = state.server.as_ref() else {
                return;
            };
            if server.instance_id != instance_id {
                return;
            }

            let message = format!("OpenCode server exited with status {:?}", status);
            let shutdown_requested = state.shutdown_requested;
            if !shutdown_requested {
                state.last_error = Some(message.clone());
            }
            state.server = None;

            (
                !shutdown_requested && self.inner.config.auto_restart,
                message,
            )
        };

        if !should_restart {
            return;
        }

        let manager = self.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(MONITOR_DELAY_MS)).await;
            if let Err(err) = manager.ensure_server().await {
                warn!(
                    error = ?err,
                    prior_exit = %error_message,
                    "failed to restart OpenCode compat sidecar"
                );
            }
        });
    }
}

fn default_log_dir() -> PathBuf {
    let mut base = dirs::data_local_dir().unwrap_or_else(|| std::env::temp_dir());
    base.push("sandbox-agent");
    base.push("agent-logs");
    base
}

fn open_opencode_log(log_dir: &Path) -> Result<Stdio, String> {
    let directory = log_dir.join("opencode");
    fs::create_dir_all(&directory).map_err(|err| err.to_string())?;
    let path = directory.join("opencode-compat.log");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    Ok(file.into())
}

fn find_available_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|err| err.to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    drop(listener);
    Ok(port)
}

fn child_is_alive(child: &Arc<StdMutex<Option<Child>>>) -> bool {
    let mut guard = match child.lock() {
        Ok(guard) => guard,
        Err(_) => return false,
    };
    let Some(child) = guard.as_mut() else {
        return false;
    };
    match child.try_wait() {
        Ok(Some(_)) => {
            *guard = None;
            false
        }
        Ok(None) => true,
        Err(_) => false,
    }
}

fn kill_child(child: &Arc<StdMutex<Option<Child>>>) {
    if let Ok(mut guard) = child.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
        *guard = None;
    }
}
