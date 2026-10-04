use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, Mutex, RwLock};

use sandbox_agent_error::SandboxError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStream {
    Stdout,
    Stderr,
    Pty,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessOwner {
    User,
    Desktop,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RestartPolicy {
    Never,
    Always,
    OnFailure,
}

#[derive(Debug, Clone)]
pub struct ProcessStartSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub tty: bool,
    pub interactive: bool,
    pub owner: ProcessOwner,
    pub restart_policy: Option<RestartPolicy>,
}

#[derive(Debug, Clone)]
pub struct RunSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
    pub max_output_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogLine {
    pub sequence: u64,
    pub stream: ProcessStream,
    pub timestamp_ms: i64,
    pub data: String,
    pub encoding: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub tty: bool,
    pub interactive: bool,
    pub owner: ProcessOwner,
    pub status: ProcessStatus,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub created_at_ms: i64,
    pub exited_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRuntimeConfig {
    pub max_concurrent_processes: usize,
    pub default_run_timeout_ms: u64,
    pub max_run_timeout_ms: u64,
    pub max_output_bytes: usize,
    pub max_log_bytes_per_process: usize,
    pub max_input_bytes_per_request: usize,
}

impl Default for ProcessRuntimeConfig {
    fn default() -> Self {
        Self {
            max_concurrent_processes: 64,
            default_run_timeout_ms: 30_000,
            max_run_timeout_ms: 300_000,
            max_output_bytes: 1_048_576,
            max_log_bytes_per_process: 10_485_760,
            max_input_bytes_per_request: 65_536,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProcessRuntime {
    config: Arc<RwLock<ProcessRuntimeConfig>>,
    inner: Arc<ProcessRuntimeInner>,
}

#[derive(Debug)]
struct ProcessRuntimeInner {
    next_id: AtomicU64,
    processes: RwLock<HashMap<String, Arc<ManagedProcess>>>,
}

#[derive(Debug)]
struct ManagedProcess {
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    tty: bool,
    interactive: bool,
    owner: ProcessOwner,
    #[allow(dead_code)]
    restart_policy: RestartPolicy,
    spec: ProcessStartSpec,
    created_at_ms: i64,
    max_log_bytes: usize,
    runtime: Mutex<ManagedRuntime>,
    status: RwLock<ManagedStatus>,
    sequence: AtomicU64,
    logs: Mutex<VecDeque<StoredLog>>,
    total_log_bytes: Mutex<usize>,
    log_tx: broadcast::Sender<ProcessLogLine>,
    stop_requested: AtomicBool,
}

#[derive(Debug)]
struct ManagedRuntime {
    pid: Option<u32>,
    stdin: Option<ProcessStdin>,
    #[cfg(unix)]
    pty_resize_fd: Option<std::fs::File>,
}

#[derive(Debug)]
enum ProcessStdin {
    Pipe(ChildStdin),
    Pty(tokio::fs::File),
}

#[derive(Debug, Clone)]
struct StoredLog {
    line: ProcessLogLine,
    byte_len: usize,
}

#[derive(Debug, Clone)]
struct ManagedStatus {
    status: ProcessStatus,
    exit_code: Option<i32>,
    exited_at_ms: Option<i64>,
}

struct SpawnedPipeProcess {
    child: Child,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    runtime: ManagedRuntime,
}

#[cfg(unix)]
struct SpawnedTtyProcess {
    child: Child,
    reader: tokio::fs::File,
    runtime: ManagedRuntime,
}

impl ProcessRuntime {
    pub fn new() -> Self {
        Self {
            config: Arc::new(RwLock::new(ProcessRuntimeConfig::default())),
            inner: Arc::new(ProcessRuntimeInner {
                next_id: AtomicU64::new(1),
                processes: RwLock::new(HashMap::new()),
            }),
        }
    }

    pub async fn get_config(&self) -> ProcessRuntimeConfig {
        self.config.read().await.clone()
    }

    pub async fn set_config(
        &self,
        mut value: ProcessRuntimeConfig,
    ) -> Result<ProcessRuntimeConfig, SandboxError> {
        if value.max_concurrent_processes == 0 {
            return Err(SandboxError::InvalidRequest {
                message: "maxConcurrentProcesses must be greater than 0".to_string(),
            });
        }
        if value.default_run_timeout_ms == 0 || value.max_run_timeout_ms == 0 {
            return Err(SandboxError::InvalidRequest {
                message: "timeouts must be greater than 0".to_string(),
            });
        }
        if value.default_run_timeout_ms > value.max_run_timeout_ms {
            value.default_run_timeout_ms = value.max_run_timeout_ms;
        }
        if value.max_output_bytes == 0
            || value.max_log_bytes_per_process == 0
            || value.max_input_bytes_per_request == 0
        {
            return Err(SandboxError::InvalidRequest {
                message: "byte limits must be greater than 0".to_string(),
            });
        }

        *self.config.write().await = value.clone();
        Ok(value)
    }

    pub async fn start_process(
        &self,
        spec: ProcessStartSpec,
    ) -> Result<ProcessSnapshot, SandboxError> {
        if spec.command.trim().is_empty() {
            return Err(SandboxError::InvalidRequest {
                message: "command must not be empty".to_string(),
            });
        }

        let config = self.get_config().await;
        if self.running_process_count().await >= config.max_concurrent_processes {
            return Err(SandboxError::Conflict {
                message: format!(
                    "max concurrent process limit reached ({})",
                    config.max_concurrent_processes
                ),
            });
        }

        let id_num = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let id = format!("proc_{id_num}");
        let process = Arc::new(ManagedProcess {
            id: id.clone(),
            command: spec.command.clone(),
            args: spec.args.clone(),
            cwd: spec.cwd.clone(),
            tty: spec.tty,
            interactive: spec.interactive,
            owner: spec.owner,
            restart_policy: spec.restart_policy.unwrap_or(RestartPolicy::Never),
            spec,
            created_at_ms: now_ms(),
            max_log_bytes: config.max_log_bytes_per_process,
            runtime: Mutex::new(ManagedRuntime {
                pid: None,
                stdin: None,
                #[cfg(unix)]
                pty_resize_fd: None,
            }),
            status: RwLock::new(ManagedStatus {
                status: ProcessStatus::Running,
                exit_code: None,
                exited_at_ms: None,
            }),
            sequence: AtomicU64::new(1),
            logs: Mutex::new(VecDeque::new()),
            total_log_bytes: Mutex::new(0),
            log_tx: broadcast::channel(512).0,
            stop_requested: AtomicBool::new(false),
        });

        self.spawn_existing_process(process.clone()).await?;
        self.inner
            .processes
            .write()
            .await
            .insert(id, process.clone());
        Ok(process.snapshot().await)
    }

    pub async fn run_once(&self, spec: RunSpec) -> Result<RunOutput, SandboxError> {
        if spec.command.trim().is_empty() {
            return Err(SandboxError::InvalidRequest {
                message: "command must not be empty".to_string(),
            });
        }

        let config = self.get_config().await;
        let mut timeout_ms = spec.timeout_ms.unwrap_or(config.default_run_timeout_ms);
        if timeout_ms == 0 {
            timeout_ms = config.default_run_timeout_ms;
        }
        timeout_ms = timeout_ms.min(config.max_run_timeout_ms);

        let max_output_bytes = spec
            .max_output_bytes
            .unwrap_or(config.max_output_bytes)
            .min(config.max_output_bytes);

        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }

        if !spec.env.contains_key("TERM") {
            cmd.env("TERM", "xterm-256color");
        }
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|err| SandboxError::StreamError {
            message: format!("failed to spawn process: {err}"),
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to capture stdout".to_string(),
            })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to capture stderr".to_string(),
            })?;

        let started = Instant::now();
        let stdout_task = tokio::spawn(capture_output(stdout, max_output_bytes));
        let stderr_task = tokio::spawn(capture_output(stderr, max_output_bytes));

        let wait_result =
            tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), child.wait()).await;

        let (exit_code, timed_out) = match wait_result {
            Ok(Ok(status)) => (status.code(), false),
            Ok(Err(err)) => {
                let _ = child.kill().await;
                return Err(SandboxError::StreamError {
                    message: format!("failed to wait on process: {err}"),
                });
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                (None, true)
            }
        };

        let (stdout, stdout_truncated) = match stdout_task.await {
            Ok(Ok(captured)) => captured,
            _ => (Vec::new(), false),
        };
        let (stderr, stderr_truncated) = match stderr_task.await {
            Ok(Ok(captured)) => captured,
            _ => (Vec::new(), false),
        };

        Ok(RunOutput {
            exit_code,
            timed_out,
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            stdout_truncated,
            stderr_truncated,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn list_processes(&self, owner: Option<ProcessOwner>) -> Vec<ProcessSnapshot> {
        let processes = self.inner.processes.read().await;
        let mut items = Vec::with_capacity(processes.len());
        for process in processes.values() {
            if owner.is_none_or(|expected| process.owner == expected) {
                items.push(process.snapshot().await);
            }
        }
        items.sort_by(|a, b| a.id.cmp(&b.id));
        items
    }

    pub async fn snapshot(&self, id: &str) -> Result<ProcessSnapshot, SandboxError> {
        Ok(self.lookup_process(id).await?.snapshot().await)
    }

    pub async fn is_tty(&self, id: &str) -> Result<bool, SandboxError> {
        Ok(self.lookup_process(id).await?.tty)
    }

    pub async fn max_input_bytes(&self) -> usize {
        self.get_config().await.max_input_bytes_per_request
    }

    pub async fn delete_process(&self, id: &str) -> Result<(), SandboxError> {
        let process = self.lookup_process(id).await?;
        let status = process.status.read().await.clone();
        if status.status == ProcessStatus::Running {
            return Err(SandboxError::Conflict {
                message: "process is still running; stop or kill it before delete".to_string(),
            });
        }

        self.inner.processes.write().await.remove(id);
        Ok(())
    }

    pub async fn stop_process(
        &self,
        id: &str,
        wait_ms: Option<u64>,
    ) -> Result<ProcessSnapshot, SandboxError> {
        let process = self.lookup_process(id).await?;
        process.stop_requested.store(true, Ordering::SeqCst);
        process.send_signal(SIGTERM).await?;
        maybe_wait_for_exit(process.clone(), wait_ms.unwrap_or(2_000)).await;
        Ok(process.snapshot().await)
    }

    pub async fn kill_process(
        &self,
        id: &str,
        wait_ms: Option<u64>,
    ) -> Result<ProcessSnapshot, SandboxError> {
        let process = self.lookup_process(id).await?;
        process.stop_requested.store(true, Ordering::SeqCst);
        process.send_signal(SIGKILL).await?;
        maybe_wait_for_exit(process.clone(), wait_ms.unwrap_or(1_000)).await;
        Ok(process.snapshot().await)
    }

    pub async fn write_input(&self, id: &str, data: &[u8]) -> Result<usize, SandboxError> {
        self.lookup_process(id).await?.write_input(data).await
    }

    pub async fn resize_terminal(
        &self,
        id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), SandboxError> {
        let process = self.lookup_process(id).await?;
        if !process.tty {
            return Err(SandboxError::Conflict {
                message: "process is not running in tty mode".to_string(),
            });
        }

        process.resize_pty(cols, rows).await?;
        process.send_signal(SIGWINCH).await
    }

    pub async fn logs(
        &self,
        id: &str,
        filter: ProcessLogFilter,
    ) -> Result<Vec<ProcessLogLine>, SandboxError> {
        self.lookup_process(id).await?.read_logs(filter).await
    }

    pub async fn subscribe_logs(
        &self,
        id: &str,
    ) -> Result<broadcast::Receiver<ProcessLogLine>, SandboxError> {
        let process = self.lookup_process(id).await?;
        Ok(process.log_tx.subscribe())
    }

    async fn running_process_count(&self) -> usize {
        let processes = self.inner.processes.read().await;
        let mut running = 0usize;
        for process in processes.values() {
            if process.status.read().await.status == ProcessStatus::Running {
                running += 1;
            }
        }
        running
    }

    async fn lookup_process(&self, id: &str) -> Result<Arc<ManagedProcess>, SandboxError> {
        let process = self.inner.processes.read().await.get(id).cloned();
        process.ok_or_else(|| SandboxError::NotFound {
            resource: "process".to_string(),
            id: id.to_string(),
        })
    }

    async fn spawn_existing_process(
        &self,
        process: Arc<ManagedProcess>,
    ) -> Result<(), SandboxError> {
        process.stop_requested.store(false, Ordering::SeqCst);
        let mut runtime_guard = process.runtime.lock().await;
        let mut status_guard = process.status.write().await;

        if process.tty {
            #[cfg(unix)]
            {
                let SpawnedTtyProcess {
                    child,
                    reader,
                    runtime,
                } = self.spawn_tty_process(&process.spec)?;
                *runtime_guard = runtime;
                status_guard.status = ProcessStatus::Running;
                status_guard.exit_code = None;
                status_guard.exited_at_ms = None;
                drop(status_guard);
                drop(runtime_guard);

                let process_for_output = process.clone();
                tokio::spawn(async move {
                    pump_output(process_for_output, reader, ProcessStream::Pty).await;
                });

                let runtime = self.clone();
                tokio::spawn(async move {
                    watch_exit(runtime, process, child).await;
                });

                return Ok(());
            }
            #[cfg(not(unix))]
            {
                return Err(SandboxError::StreamError {
                    message: "tty process mode is not supported on this platform".to_string(),
                });
            }
        }

        let SpawnedPipeProcess {
            child,
            stdout,
            stderr,
            runtime,
        } = self.spawn_pipe_process(&process.spec)?;
        *runtime_guard = runtime;
        status_guard.status = ProcessStatus::Running;
        status_guard.exit_code = None;
        status_guard.exited_at_ms = None;
        drop(status_guard);
        drop(runtime_guard);

        let process_for_stdout = process.clone();
        tokio::spawn(async move {
            pump_output(process_for_stdout, stdout, ProcessStream::Stdout).await;
        });

        let process_for_stderr = process.clone();
        tokio::spawn(async move {
            pump_output(process_for_stderr, stderr, ProcessStream::Stderr).await;
        });

        let runtime = self.clone();
        tokio::spawn(async move {
            watch_exit(runtime, process, child).await;
        });

        Ok(())
    }

    fn spawn_pipe_process(
        &self,
        spec: &ProcessStartSpec,
    ) -> Result<SpawnedPipeProcess, SandboxError> {
        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }

        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|err| SandboxError::StreamError {
            message: format!("failed to spawn process: {err}"),
        })?;

        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to capture stdout".to_string(),
            })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to capture stderr".to_string(),
            })?;

        Ok(SpawnedPipeProcess {
            runtime: ManagedRuntime {
                pid: child.id(),
                stdin: stdin.map(ProcessStdin::Pipe),
                #[cfg(unix)]
                pty_resize_fd: None,
            },
            child,
            stdout,
            stderr,
        })
    }

    #[cfg(unix)]
    fn spawn_tty_process(
        &self,
        spec: &ProcessStartSpec,
    ) -> Result<SpawnedTtyProcess, SandboxError> {
        use std::os::fd::AsRawFd;
        use std::process::Stdio;

        let (master_fd, slave_fd) = open_pty(80, 24)?;
        let slave_raw = slave_fd.as_raw_fd();

        let stdin_fd = dup_fd(slave_raw)?;
        let stdout_fd = dup_fd(slave_raw)?;
        let stderr_fd = dup_fd(slave_raw)?;

        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args)
            .stdin(Stdio::from(std::fs::File::from(stdin_fd)))
            .stdout(Stdio::from(std::fs::File::from(stdout_fd)))
            .stderr(Stdio::from(std::fs::File::from(stderr_fd)));

        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }

        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        unsafe {
            cmd.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(slave_raw, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let child = cmd.spawn().map_err(|err| SandboxError::StreamError {
            message: format!("failed to spawn tty process: {err}"),
        })?;
        let pid = child.id();

        drop(slave_fd);

        let master_raw = master_fd.as_raw_fd();
        let writer_fd = dup_fd(master_raw)?;
        let resize_fd = dup_fd(master_raw)?;

        let reader_file = tokio::fs::File::from_std(std::fs::File::from(master_fd));
        let writer_file = tokio::fs::File::from_std(std::fs::File::from(writer_fd));
        let resize_file = std::fs::File::from(resize_fd);

        Ok(SpawnedTtyProcess {
            runtime: ManagedRuntime {
                pid,
                stdin: Some(ProcessStdin::Pty(writer_file)),
                pty_resize_fd: Some(resize_file),
            },
            child,
            reader: reader_file,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ProcessLogFilterStream {
    Stdout,
    Stderr,
    Combined,
    Pty,
}

#[derive(Debug, Clone, Copy)]
pub struct ProcessLogFilter {
    pub stream: ProcessLogFilterStream,
    pub tail: Option<usize>,
    pub since: Option<u64>,
}

impl ManagedProcess {
    async fn snapshot(&self) -> ProcessSnapshot {
        let status = self.status.read().await.clone();
        let pid = self.runtime.lock().await.pid;
        ProcessSnapshot {
            id: self.id.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            cwd: self.cwd.clone(),
            tty: self.tty,
            interactive: self.interactive,
            owner: self.owner,
            status: status.status,
            pid,
            exit_code: status.exit_code,
            created_at_ms: self.created_at_ms,
            exited_at_ms: status.exited_at_ms,
        }
    }

    async fn append_log(&self, stream: ProcessStream, data: &[u8]) {
        if data.is_empty() {
            return;
        }

        let stream = if self.tty { ProcessStream::Pty } else { stream };
        let line = ProcessLogLine {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            stream,
            timestamp_ms: now_ms(),
            data: BASE64.encode(data),
            encoding: "base64",
        };
        let stored = StoredLog {
            line: line.clone(),
            byte_len: data.len(),
        };

        {
            let mut logs = self.logs.lock().await;
            let mut total = self.total_log_bytes.lock().await;
            logs.push_back(stored);
            *total += data.len();

            while *total > self.max_log_bytes {
                if let Some(front) = logs.pop_front() {
                    *total = total.saturating_sub(front.byte_len);
                } else {
                    break;
                }
            }
        }

        let _ = self.log_tx.send(line);
    }

    async fn write_input(&self, data: &[u8]) -> Result<usize, SandboxError> {
        if self.status.read().await.status != ProcessStatus::Running {
            return Err(SandboxError::Conflict {
                message: "process is not running".to_string(),
            });
        }

        let mut runtime = self.runtime.lock().await;
        let stdin = runtime
            .stdin
            .as_mut()
            .ok_or_else(|| SandboxError::Conflict {
                message: "process does not accept stdin".to_string(),
            })?;

        match stdin {
            ProcessStdin::Pipe(pipe) => {
                pipe.write_all(data)
                    .await
                    .map_err(|err| SandboxError::StreamError {
                        message: format!("failed to write stdin: {err}"),
                    })?;
                pipe.flush()
                    .await
                    .map_err(|err| SandboxError::StreamError {
                        message: format!("failed to flush stdin: {err}"),
                    })?;
            }
            ProcessStdin::Pty(pty_writer) => {
                pty_writer
                    .write_all(data)
                    .await
                    .map_err(|err| SandboxError::StreamError {
                        message: format!("failed to write PTY input: {err}"),
                    })?;
                pty_writer
                    .flush()
                    .await
                    .map_err(|err| SandboxError::StreamError {
                        message: format!("failed to flush PTY input: {err}"),
                    })?;
            }
        }

        Ok(data.len())
    }

    async fn read_logs(
        &self,
        filter: ProcessLogFilter,
    ) -> Result<Vec<ProcessLogLine>, SandboxError> {
        let logs = self.logs.lock().await;

        let mut entries: Vec<ProcessLogLine> = logs
            .iter()
            .filter_map(|entry| {
                if let Some(since) = filter.since {
                    if entry.line.sequence <= since {
                        return None;
                    }
                }
                if stream_matches(entry.line.stream, filter.stream) {
                    Some(entry.line.clone())
                } else {
                    None
                }
            })
            .collect();

        if let Some(tail) = filter.tail {
            if entries.len() > tail {
                let start = entries.len() - tail;
                entries = entries.split_off(start);
            }
        }

        Ok(entries)
    }

    async fn send_signal(&self, signal: i32) -> Result<(), SandboxError> {
        if self.status.read().await.status != ProcessStatus::Running {
            return Ok(());
        }
        let Some(pid) = self.runtime.lock().await.pid else {
            return Ok(());
        };

        send_signal(pid, signal)
    }

    async fn resize_pty(&self, cols: u16, rows: u16) -> Result<(), SandboxError> {
        if !self.tty {
            return Ok(());
        }

        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;

            let runtime = self.runtime.lock().await;
            let Some(fd) = runtime.pty_resize_fd.as_ref() else {
                return Err(SandboxError::Conflict {
                    message: "PTY resize handle unavailable".to_string(),
                });
            };
            resize_pty(fd.as_raw_fd(), cols, rows)?;
        }

        #[cfg(not(unix))]
        {
            let _ = cols;
            let _ = rows;
        }

        Ok(())
    }

    #[allow(dead_code)]
    fn should_restart(&self, exit_code: Option<i32>) -> bool {
        match self.restart_policy {
            RestartPolicy::Never => false,
            RestartPolicy::Always => true,
            RestartPolicy::OnFailure => exit_code.unwrap_or(1) != 0,
        }
    }

    async fn mark_exited(&self, exit_code: Option<i32>, exited_at_ms: Option<i64>) {
        {
            let mut status = self.status.write().await;
            status.status = ProcessStatus::Exited;
            status.exit_code = exit_code;
            status.exited_at_ms = exited_at_ms;
        }

        let mut runtime = self.runtime.lock().await;
        runtime.pid = None;
        let _ = runtime.stdin.take();
        #[cfg(unix)]
        {
            let _ = runtime.pty_resize_fd.take();
        }
    }
}

fn stream_matches(stream: ProcessStream, filter: ProcessLogFilterStream) -> bool {
    match filter {
        ProcessLogFilterStream::Stdout => stream == ProcessStream::Stdout,
        ProcessLogFilterStream::Stderr => stream == ProcessStream::Stderr,
        ProcessLogFilterStream::Combined => {
            stream == ProcessStream::Stdout || stream == ProcessStream::Stderr
        }
        ProcessLogFilterStream::Pty => stream == ProcessStream::Pty,
    }
}

async fn maybe_wait_for_exit(process: Arc<ManagedProcess>, wait_ms: u64) {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(wait_ms);
    while tokio::time::Instant::now() < deadline {
        if process.status.read().await.status == ProcessStatus::Exited {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
    }
}

async fn pump_output<R>(process: Arc<ManagedProcess>, mut reader: R, stream: ProcessStream)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                process.append_log(stream, &buffer[..n]).await;
            }
            Err(err) => {
                let msg = format!("\n[process stream error: {err}]\n");
                process
                    .append_log(
                        if process.tty {
                            ProcessStream::Pty
                        } else {
                            ProcessStream::Stderr
                        },
                        msg.as_bytes(),
                    )
                    .await;
                break;
            }
        }
    }
}

async fn watch_exit(runtime: ProcessRuntime, process: Arc<ManagedProcess>, mut child: Child) {
    let _ = runtime;
    let wait = child.wait().await;
    let (exit_code, exited_at_ms) = match wait {
        Ok(status) => (status.code(), Some(now_ms())),
        Err(_) => (None, Some(now_ms())),
    };

    let _ = process.stop_requested.swap(false, Ordering::SeqCst);
    process.mark_exited(exit_code, exited_at_ms).await;
}

async fn capture_output<R>(mut reader: R, max_bytes: usize) -> std::io::Result<(Vec<u8>, bool)>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;

    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            break;
        }

        if output.len() < max_bytes {
            let remaining = max_bytes - output.len();
            let to_copy = remaining.min(n);
            output.extend_from_slice(&buffer[..to_copy]);
            if to_copy < n {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }

    Ok((output, truncated))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
const SIGTERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const SIGKILL: i32 = libc::SIGKILL;
#[cfg(unix)]
const SIGWINCH: i32 = libc::SIGWINCH;

#[cfg(unix)]
fn send_signal(pid: u32, signal: i32) -> Result<(), SandboxError> {
    let result = unsafe { libc::kill(pid as libc::pid_t, signal) };
    if result == 0 {
        return Ok(());
    }

    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }

    Err(SandboxError::StreamError {
        message: format!("failed to signal process {pid}: {err}"),
    })
}

#[cfg(not(unix))]
const SIGTERM: i32 = 15;
#[cfg(not(unix))]
const SIGKILL: i32 = 9;
#[cfg(not(unix))]
const SIGWINCH: i32 = 28;

#[cfg(not(unix))]
fn send_signal(_pid: u32, _signal: i32) -> Result<(), SandboxError> {
    Err(SandboxError::StreamError {
        message: "process signaling not supported on this platform".to_string(),
    })
}

#[cfg(unix)]
fn open_pty(
    cols: u16,
    rows: u16,
) -> Result<(std::os::fd::OwnedFd, std::os::fd::OwnedFd), SandboxError> {
    use std::os::fd::FromRawFd;

    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let mut winsize = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut winsize,
        )
    };

    if rc != 0 {
        return Err(SandboxError::StreamError {
            message: format!(
                "failed to allocate PTY: {}",
                std::io::Error::last_os_error()
            ),
        });
    }

    let master_fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(master) };
    let slave_fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(slave) };
    Ok((master_fd, slave_fd))
}

#[cfg(unix)]
fn dup_fd(fd: std::os::fd::RawFd) -> Result<std::os::fd::OwnedFd, SandboxError> {
    use std::os::fd::FromRawFd;

    let duplicated = unsafe { libc::dup(fd) };
    if duplicated == -1 {
        return Err(SandboxError::StreamError {
            message: format!("failed to dup fd: {}", std::io::Error::last_os_error()),
        });
    }

    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(duplicated) })
}

#[cfg(unix)]
fn resize_pty(fd: std::os::fd::RawFd, cols: u16, rows: u16) -> Result<(), SandboxError> {
    let winsize = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let rc = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ as _, &winsize) };
    if rc == -1 {
        return Err(SandboxError::StreamError {
            message: format!("failed to resize PTY: {}", std::io::Error::last_os_error()),
        });
    }

    Ok(())
}

pub fn decode_input_bytes(data: &str, encoding: &str) -> Result<Vec<u8>, SandboxError> {
    match encoding {
        "base64" => BASE64
            .decode(data)
            .map_err(|err| SandboxError::InvalidRequest {
                message: format!("invalid base64 input: {err}"),
            }),
        "utf8" | "text" => Ok(data.as_bytes().to_vec()),
        _ => Err(SandboxError::InvalidRequest {
            message: "encoding must be one of: base64, utf8, text".to_string(),
        }),
    }
}
