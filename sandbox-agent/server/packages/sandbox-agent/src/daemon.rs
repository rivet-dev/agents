use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::time::{Duration, Instant};

use reqwest::blocking::Client as HttpClient;

use crate::cli::{CliConfig, CliError};

mod build_id {
    include!(concat!(env!("OUT_DIR"), "/build_id.rs"));
}
pub use build_id::BUILD_ID;

const DAEMON_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_CHECK_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const HEALTH_CHECK_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

pub fn daemon_state_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("daemon"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("daemon"))
}

pub fn sanitize_host(host: &str) -> String {
    host.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

pub fn daemon_pid_path(host: &str, port: u16) -> PathBuf {
    let name = format!("daemon-{}-{}.pid", sanitize_host(host), port);
    daemon_state_dir().join(name)
}

pub fn daemon_log_path(host: &str, port: u16) -> PathBuf {
    let name = format!("daemon-{}-{}.log", sanitize_host(host), port);
    daemon_state_dir().join(name)
}

pub fn daemon_version_path(host: &str, port: u16) -> PathBuf {
    let name = format!("daemon-{}-{}.version", sanitize_host(host), port);
    daemon_state_dir().join(name)
}

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

pub fn read_pid(path: &Path) -> Option<u32> {
    let text = fs::read_to_string(path).ok()?;
    text.trim().parse::<u32>().ok()
}

pub fn write_pid(path: &Path, pid: u32) -> Result<(), CliError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, pid.to_string())?;
    Ok(())
}

pub fn remove_pid(path: &Path) -> Result<(), CliError> {
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

pub fn read_daemon_version(host: &str, port: u16) -> Option<String> {
    let path = daemon_version_path(host, port);
    let text = fs::read_to_string(path).ok()?;
    Some(text.trim().to_string())
}

pub fn write_daemon_version(host: &str, port: u16) -> Result<(), CliError> {
    let path = daemon_version_path(host, port);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, BUILD_ID)?;
    Ok(())
}

pub fn remove_version_file(host: &str, port: u16) -> Result<(), CliError> {
    let path = daemon_version_path(host, port);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn is_version_current(host: &str, port: u16) -> bool {
    match read_daemon_version(host, port) {
        Some(v) => v == BUILD_ID,
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

#[cfg(unix)]
pub fn is_process_running(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return true;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(code) if code == libc::EPERM => true,
        _ => false,
    }
}

#[cfg(windows)]
pub fn is_process_running(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return false,
        };
        let mut exit_code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut exit_code).is_ok();
        let _ = CloseHandle(handle);
        ok && exit_code == 259
    }
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

pub fn check_health(base_url: &str, token: Option<&str>) -> Result<bool, CliError> {
    let url = format!("{base_url}/v1/health");
    let started_at = Instant::now();
    let client = HttpClient::builder()
        .connect_timeout(HEALTH_CHECK_CONNECT_TIMEOUT)
        .timeout(HEALTH_CHECK_REQUEST_TIMEOUT)
        .build()?;
    let mut request = client.get(url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    match request.send() {
        Ok(response) if response.status().is_success() => {
            tracing::info!(
                elapsed_ms = started_at.elapsed().as_millis(),
                "daemon health check succeeded"
            );
            Ok(true)
        }
        Ok(response) => {
            tracing::warn!(
                status = %response.status(),
                elapsed_ms = started_at.elapsed().as_millis(),
                "daemon health check returned non-success status"
            );
            Ok(false)
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                elapsed_ms = started_at.elapsed().as_millis(),
                "daemon health check request failed"
            );
            Ok(false)
        }
    }
}

pub fn wait_for_health(
    mut server_child: Option<&mut Child>,
    base_url: &str,
    token: Option<&str>,
    timeout: Duration,
) -> Result<(), CliError> {
    let client = HttpClient::builder()
        .connect_timeout(HEALTH_CHECK_CONNECT_TIMEOUT)
        .timeout(HEALTH_CHECK_REQUEST_TIMEOUT)
        .build()?;
    let deadline = Instant::now() + timeout;
    let mut attempts: u32 = 0;

    while Instant::now() < deadline {
        attempts += 1;
        if let Some(child) = server_child.as_mut() {
            if let Some(status) = child.try_wait()? {
                return Err(CliError::Server(format!(
                    "sandbox-agent exited before becoming healthy ({status})"
                )));
            }
        }

        let url = format!("{base_url}/v1/health");
        let mut request = client.get(&url);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        match request.send() {
            Ok(response) if response.status().is_success() => {
                tracing::info!(
                    attempts,
                    elapsed_ms =
                        (timeout - deadline.saturating_duration_since(Instant::now())).as_millis(),
                    "daemon became healthy while waiting"
                );
                return Ok(());
            }
            Ok(response) => {
                if attempts % 10 == 0 {
                    tracing::info!(
                        attempts,
                        status = %response.status(),
                        "daemon still not healthy; waiting"
                    );
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(err) => {
                if attempts % 10 == 0 {
                    tracing::warn!(
                        attempts,
                        error = %err,
                        "daemon health poll request failed; still waiting"
                    );
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }

    tracing::error!(
        attempts,
        timeout_ms = timeout.as_millis(),
        "timed out waiting for daemon health"
    );
    Err(CliError::Server(
        "timed out waiting for sandbox-agent health".to_string(),
    ))
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

pub fn spawn_sandbox_agent_daemon(
    _cli: &CliConfig,
    host: &str,
    port: u16,
    token: Option<&str>,
    log_path: &Path,
) -> Result<Child, CliError> {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let log_file = fs::File::create(log_path)?;
    let log_file_err = log_file.try_clone()?;

    let exe = std::env::current_exe()?;
    let mut cmd = ProcessCommand::new(exe);
    cmd.arg("server")
        .arg("--host")
        .arg(host)
        .arg("--port")
        .arg(port.to_string())
        .env("SANDBOX_AGENT_LOG_STDOUT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    if let Some(token) = token {
        cmd.arg("--token").arg(token);
    }

    cmd.spawn().map_err(CliError::from)
}

// ---------------------------------------------------------------------------
// DaemonStatus
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum DaemonStatus {
    Running {
        pid: u32,
        version: Option<String>,
        version_current: bool,
        log_path: PathBuf,
    },
    NotRunning,
}

impl std::fmt::Display for DaemonStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DaemonStatus::Running {
                pid,
                version,
                version_current,
                log_path,
            } => {
                let version_str = version.as_deref().unwrap_or("unknown");
                let outdated = if *version_current {
                    ""
                } else {
                    " [outdated, restart recommended]"
                };
                write!(
                    f,
                    "Daemon running (PID {pid}, build {version_str}, logs: {}){}",
                    log_path.display(),
                    outdated
                )
            }
            DaemonStatus::NotRunning => write!(f, "Daemon not running"),
        }
    }
}

// ---------------------------------------------------------------------------
// High-level commands
// ---------------------------------------------------------------------------

pub fn status(host: &str, port: u16, token: Option<&str>) -> Result<DaemonStatus, CliError> {
    let pid_path = daemon_pid_path(host, port);
    let log_path = daemon_log_path(host, port);

    if let Some(pid) = read_pid(&pid_path) {
        if is_process_running(pid) {
            let version = read_daemon_version(host, port);
            let version_current = is_version_current(host, port);
            return Ok(DaemonStatus::Running {
                pid,
                version,
                version_current,
                log_path,
            });
        }
        // Stale PID file
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
    }

    // Also try a health check in case the daemon is running but we lost the PID file
    let base_url = format!("http://{host}:{port}");
    if check_health(&base_url, token)? {
        return Ok(DaemonStatus::Running {
            pid: 0,
            version: read_daemon_version(host, port),
            version_current: is_version_current(host, port),
            log_path,
        });
    }

    Ok(DaemonStatus::NotRunning)
}

pub fn start(cli: &CliConfig, host: &str, port: u16, token: Option<&str>) -> Result<(), CliError> {
    let base_url = format!("http://{host}:{port}");
    let pid_path = daemon_pid_path(host, port);
    let log_path = daemon_log_path(host, port);

    // Already healthy?
    if check_health(&base_url, token)? {
        eprintln!("daemon already running at {base_url}");
        return Ok(());
    }

    // Stale PID?
    if let Some(pid) = read_pid(&pid_path) {
        if is_process_running(pid) {
            eprintln!("daemon process {pid} exists; waiting for health");
            return wait_for_health(None, &base_url, token, DAEMON_HEALTH_TIMEOUT);
        }
        let _ = remove_pid(&pid_path);
    }

    eprintln!(
        "starting daemon at {base_url} (logs: {})",
        log_path.display()
    );

    let mut child = spawn_sandbox_agent_daemon(cli, host, port, token, &log_path)?;
    let pid = child.id();
    write_pid(&pid_path, pid)?;
    write_daemon_version(host, port)?;

    let result = wait_for_health(Some(&mut child), &base_url, token, DAEMON_HEALTH_TIMEOUT);
    if result.is_err() {
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
        return result;
    }

    eprintln!("daemon started (PID {pid}, logs: {})", log_path.display());
    Ok(())
}

/// Find the PID of a process listening on the given port using lsof.
#[cfg(unix)]
fn find_process_on_port(port: u16) -> Option<u32> {
    let output = std::process::Command::new("lsof")
        .args(["-i", &format!(":{port}"), "-t", "-sTCP:LISTEN"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // lsof -t returns just the PID(s), one per line
    stdout.lines().next()?.trim().parse::<u32>().ok()
}

/// Stop a process by PID with SIGTERM then SIGKILL if needed.
#[cfg(unix)]
fn stop_process(pid: u32, host: &str, port: u16, pid_path: &Path) -> Result<(), CliError> {
    eprintln!("stopping daemon (PID {pid})...");

    // SIGTERM
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }

    // Wait up to 5 seconds for graceful exit
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        if !is_process_running(pid) {
            let _ = remove_pid(pid_path);
            let _ = remove_version_file(host, port);
            eprintln!("daemon stopped");
            return Ok(());
        }
    }

    // SIGKILL
    eprintln!("daemon did not stop gracefully, sending SIGKILL...");
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    std::thread::sleep(Duration::from_millis(100));
    let _ = remove_pid(pid_path);
    let _ = remove_version_file(host, port);
    eprintln!("daemon killed");
    Ok(())
}

#[cfg(unix)]
pub fn stop(host: &str, port: u16) -> Result<(), CliError> {
    let base_url = format!("http://{host}:{port}");
    let pid_path = daemon_pid_path(host, port);

    let pid = match read_pid(&pid_path) {
        Some(pid) => pid,
        None => {
            // No PID file - but check if daemon is actually running via health check
            // This can happen if PID file was deleted but daemon is still running
            if check_health(&base_url, None)? {
                eprintln!(
                    "daemon is running but PID file missing; finding process on port {port}..."
                );
                if let Some(pid) = find_process_on_port(port) {
                    eprintln!("found daemon process {pid}");
                    return stop_process(pid, host, port, &pid_path);
                } else {
                    return Err(CliError::Server(format!(
                        "daemon is running on port {port} but cannot find PID"
                    )));
                }
            }
            eprintln!("daemon is not running (no PID file)");
            return Ok(());
        }
    };

    if !is_process_running(pid) {
        eprintln!("daemon is not running (stale PID file)");
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
        return Ok(());
    }

    stop_process(pid, host, port, &pid_path)
}

#[cfg(windows)]
pub fn stop(host: &str, port: u16) -> Result<(), CliError> {
    let pid_path = daemon_pid_path(host, port);

    let pid = match read_pid(&pid_path) {
        Some(pid) => pid,
        None => {
            eprintln!("daemon is not running (no PID file)");
            return Ok(());
        }
    };

    if !is_process_running(pid) {
        eprintln!("daemon is not running (stale PID file)");
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
        return Ok(());
    }

    eprintln!("stopping daemon (PID {pid})...");

    // Use taskkill on Windows
    let _ = ProcessCommand::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status();

    std::thread::sleep(Duration::from_millis(500));
    let _ = remove_pid(&pid_path);
    let _ = remove_version_file(host, port);
    eprintln!("daemon stopped");
    Ok(())
}

pub fn ensure_running(
    cli: &CliConfig,
    host: &str,
    port: u16,
    token: Option<&str>,
) -> Result<(), CliError> {
    let base_url = format!("http://{host}:{port}");
    let pid_path = daemon_pid_path(host, port);
    eprintln!(
        "checking daemon health at {base_url} (token: {})...",
        if token.is_some() { "set" } else { "unset" }
    );

    // Check if daemon is already healthy
    if check_health(&base_url, token)? {
        // Check build version
        if !is_version_current(host, port) {
            let old = read_daemon_version(host, port).unwrap_or_else(|| "unknown".to_string());
            eprintln!(
                "daemon outdated (build {old} -> {}), restarting...",
                BUILD_ID
            );
            stop(host, port)?;
            return start(cli, host, port, token);
        }
        let log_path = daemon_log_path(host, port);
        if let Some(pid) = read_pid(&pid_path) {
            eprintln!(
                "daemon already running at {base_url} (PID {pid}, logs: {})",
                log_path.display()
            );
        } else {
            eprintln!("daemon already running at {base_url}");
        }
        return Ok(());
    }

    // Not healthy — check for stale PID
    if let Some(pid) = read_pid(&pid_path) {
        if is_process_running(pid) {
            eprintln!("daemon process {pid} running; waiting for health");
            return wait_for_health(None, &base_url, token, DAEMON_HEALTH_TIMEOUT);
        }
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
    }

    start(cli, host, port, token)
}
