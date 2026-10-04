use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use sandbox_agent_error::SandboxError;

use crate::desktop_types::{DesktopProcessInfo, DesktopResolution, DesktopStreamStatusResponse};
use crate::process_runtime::{ProcessOwner, ProcessRuntime, ProcessStartSpec};

/// Internal port where neko listens for HTTP/WS traffic.
const NEKO_INTERNAL_PORT: u16 = 18100;

/// UDP ephemeral port range for WebRTC media.
const NEKO_EPR: &str = "59050-59070";

/// How long to wait for neko to become ready.
const NEKO_READY_TIMEOUT: Duration = Duration::from_secs(15);

/// How long between readiness polls.
const NEKO_READY_POLL: Duration = Duration::from_millis(300);

#[derive(Debug, Clone)]
pub struct StreamingConfig {
    pub video_codec: String,
    pub audio_codec: String,
    pub frame_rate: u32,
    pub webrtc_port_range: String,
}

impl Default for StreamingConfig {
    fn default() -> Self {
        Self {
            video_codec: "vp8".to_string(),
            audio_codec: "opus".to_string(),
            frame_rate: 30,
            webrtc_port_range: NEKO_EPR.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DesktopStreamingManager {
    inner: Arc<Mutex<DesktopStreamingState>>,
    process_runtime: Arc<ProcessRuntime>,
}

#[derive(Debug)]
struct DesktopStreamingState {
    active: bool,
    process_id: Option<String>,
    /// Base URL for neko's internal HTTP server (e.g. "http://127.0.0.1:18100").
    neko_base_url: Option<String>,
    /// Session cookie obtained from neko login, used for WS auth.
    neko_session_cookie: Option<String>,
    display: Option<String>,
    resolution: Option<DesktopResolution>,
    streaming_config: StreamingConfig,
    window_id: Option<String>,
}

impl Default for DesktopStreamingState {
    fn default() -> Self {
        Self {
            active: false,
            process_id: None,
            neko_base_url: None,
            neko_session_cookie: None,
            display: None,
            resolution: None,
            streaming_config: StreamingConfig::default(),
            window_id: None,
        }
    }
}

impl DesktopStreamingManager {
    pub fn new(process_runtime: Arc<ProcessRuntime>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DesktopStreamingState::default())),
            process_runtime,
        }
    }

    /// Start the neko streaming subprocess targeting the given display.
    pub async fn start(
        &self,
        display: &str,
        resolution: DesktopResolution,
        environment: &HashMap<String, String>,
        config: Option<StreamingConfig>,
        window_id: Option<String>,
    ) -> Result<DesktopStreamStatusResponse, SandboxError> {
        let config = config.unwrap_or_default();
        let mut state = self.inner.lock().await;

        if state.active {
            return Ok(DesktopStreamStatusResponse {
                active: true,
                window_id: state.window_id.clone(),
                process_id: state.process_id.clone(),
            });
        }

        // Stop any stale process.
        if let Some(ref old_id) = state.process_id {
            let _ = self.process_runtime.stop_process(old_id, Some(2000)).await;
            state.process_id = None;
            state.neko_base_url = None;
            state.neko_session_cookie = None;
        }

        let mut env = environment.clone();
        env.insert("DISPLAY".to_string(), display.to_string());

        let bind_addr = format!("0.0.0.0:{}", NEKO_INTERNAL_PORT);
        let screen = format!(
            "{}x{}@{}",
            resolution.width, resolution.height, config.frame_rate
        );

        let snapshot = self
            .process_runtime
            .start_process(ProcessStartSpec {
                command: "neko".to_string(),
                args: vec![
                    "serve".to_string(),
                    "--server.bind".to_string(),
                    bind_addr,
                    "--desktop.screen".to_string(),
                    screen,
                    "--desktop.display".to_string(),
                    display.to_string(),
                    "--capture.video.display".to_string(),
                    display.to_string(),
                    "--capture.video.codec".to_string(),
                    config.video_codec.clone(),
                    "--capture.audio.codec".to_string(),
                    config.audio_codec.clone(),
                    "--webrtc.epr".to_string(),
                    config.webrtc_port_range.clone(),
                    "--webrtc.icelite".to_string(),
                    "--webrtc.nat1to1".to_string(),
                    "127.0.0.1".to_string(),
                    "--member.provider".to_string(),
                    "noauth".to_string(),
                    // Disable the custom xf86-input-neko driver (defaults to true
                    // in neko v3). The driver socket is not available outside
                    // neko's official Docker images; XTEST is used instead.
                    "--desktop.input.enabled=false".to_string(),
                ],
                cwd: None,
                env,
                tty: false,
                interactive: false,
                owner: ProcessOwner::Desktop,
                restart_policy: None,
            })
            .await
            .map_err(|e| SandboxError::Conflict {
                message: format!("failed to start neko streaming process: {e}"),
            })?;

        let neko_base = format!("http://127.0.0.1:{}", NEKO_INTERNAL_PORT);
        let process_id_clone = snapshot.id.clone();
        state.process_id = Some(snapshot.id.clone());
        state.neko_base_url = Some(neko_base.clone());
        state.display = Some(display.to_string());
        state.resolution = Some(resolution);
        state.streaming_config = config;
        state.window_id = window_id;
        state.active = true;

        // Drop the lock before waiting for readiness.
        drop(state);

        // Wait for neko to be ready by polling its login endpoint.
        let deadline = tokio::time::Instant::now() + NEKO_READY_TIMEOUT;
        let login_url = format!("{}/api/login", neko_base);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let mut session_cookie = None;

        loop {
            match client
                .post(&login_url)
                .json(&serde_json::json!({"username": "admin", "password": "admin"}))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    // Extract NEKO_SESSION cookie from Set-Cookie header.
                    if let Some(set_cookie) = resp.headers().get("set-cookie") {
                        if let Ok(cookie_str) = set_cookie.to_str() {
                            // Extract just the cookie value (before the first ';').
                            if let Some(cookie_part) = cookie_str.split(';').next() {
                                session_cookie = Some(cookie_part.to_string());
                            }
                        }
                    }
                    tracing::info!("neko streaming process ready, session obtained");

                    // Take control so the connected client can send input.
                    let control_url = format!("{}/api/room/control/take", neko_base);
                    if let Some(ref cookie) = session_cookie {
                        let _ = client
                            .post(&control_url)
                            .header("Cookie", cookie.as_str())
                            .send()
                            .await;
                        tracing::info!("neko control taken");
                    }
                    break;
                }
                _ => {}
            }

            if tokio::time::Instant::now() >= deadline {
                tracing::warn!("neko did not become ready within timeout, proceeding anyway");
                break;
            }
            tokio::time::sleep(NEKO_READY_POLL).await;
        }

        // Store the session cookie.
        if let Some(ref cookie) = session_cookie {
            let mut state = self.inner.lock().await;
            state.neko_session_cookie = Some(cookie.clone());
        }

        let state = self.inner.lock().await;
        let state_window_id = state.window_id.clone();
        drop(state);

        Ok(DesktopStreamStatusResponse {
            active: true,
            window_id: state_window_id,
            process_id: Some(process_id_clone),
        })
    }

    /// Stop streaming and tear down neko subprocess.
    pub async fn stop(&self) -> DesktopStreamStatusResponse {
        let mut state = self.inner.lock().await;
        if let Some(ref process_id) = state.process_id.take() {
            let _ = self
                .process_runtime
                .stop_process(process_id, Some(3000))
                .await;
        }
        state.active = false;
        state.neko_base_url = None;
        state.neko_session_cookie = None;
        state.display = None;
        state.resolution = None;
        state.window_id = None;
        DesktopStreamStatusResponse {
            active: false,
            window_id: None,
            process_id: None,
        }
    }

    pub async fn status(&self) -> DesktopStreamStatusResponse {
        let state = self.inner.lock().await;
        DesktopStreamStatusResponse {
            active: state.active,
            window_id: state.window_id.clone(),
            process_id: state.process_id.clone(),
        }
    }

    pub async fn ensure_active(&self) -> Result<(), SandboxError> {
        if self.inner.lock().await.active {
            Ok(())
        } else {
            Err(SandboxError::Conflict {
                message: "desktop streaming is not active".to_string(),
            })
        }
    }

    /// Get the neko WebSocket URL for signaling proxy, including session cookie.
    pub async fn neko_ws_url(&self) -> Option<String> {
        self.inner
            .lock()
            .await
            .neko_base_url
            .as_ref()
            .map(|base| base.replace("http://", "ws://") + "/api/ws")
    }

    /// Get the neko base HTTP URL (e.g. `http://127.0.0.1:18100`).
    pub async fn neko_base_url(&self) -> Option<String> {
        self.inner.lock().await.neko_base_url.clone()
    }

    /// Create a fresh neko login session and return the session cookie.
    /// Each WebSocket proxy connection should call this to get its own
    /// session, avoiding conflicts when multiple clients connect.
    /// Uses a unique username per connection so neko treats them as
    /// separate members (noauth provider allows any credentials).
    pub async fn create_neko_session(&self) -> Option<String> {
        let base_url = self.neko_base_url().await?;
        let client = reqwest::Client::new();
        let login_url = format!("{}/api/login", base_url);
        let username = format!(
            "user-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        tracing::debug!(
            "creating neko session: username={}, url={}",
            username,
            login_url
        );
        let resp = match client
            .post(&login_url)
            .json(&serde_json::json!({"username": username, "password": "admin"}))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("neko login request failed: {e}");
                return None;
            }
        };
        if !resp.status().is_success() {
            tracing::warn!("neko login returned status {}", resp.status());
            return None;
        }
        let cookie = resp
            .headers()
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or(v).to_string());
        let cookie = match cookie {
            Some(c) => c,
            None => {
                tracing::warn!("neko login response missing set-cookie header");
                return None;
            }
        };
        tracing::debug!("neko session created: {}", username);

        // Take control for this session.
        let control_url = format!("{}/api/room/control/take", base_url);
        let _ = client
            .post(&control_url)
            .header("Cookie", &cookie)
            .send()
            .await;

        Some(cookie)
    }

    /// Get the shared neko session cookie (used during startup).
    pub async fn neko_session_cookie(&self) -> Option<String> {
        self.inner.lock().await.neko_session_cookie.clone()
    }

    pub async fn resolution(&self) -> Option<DesktopResolution> {
        self.inner.lock().await.resolution.clone()
    }

    pub async fn is_active(&self) -> bool {
        self.inner.lock().await.active
    }

    /// Return process diagnostics for the neko streaming subprocess, if one
    /// has been started.  The returned info mirrors the shape used by
    /// `DesktopRuntime::processes_locked` for xvfb/openbox/dbus.
    pub async fn process_info(&self) -> Option<DesktopProcessInfo> {
        let state = self.inner.lock().await;
        let process_id = state.process_id.as_ref()?;
        let snapshot = self.process_runtime.snapshot(process_id).await.ok()?;
        Some(DesktopProcessInfo {
            name: "neko".to_string(),
            pid: snapshot.pid,
            running: snapshot.status == crate::process_runtime::ProcessStatus::Running,
            log_path: None,
        })
    }
}
