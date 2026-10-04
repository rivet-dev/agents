use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::response::sse::Event;
use futures::{stream, Stream, StreamExt};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio_stream::wrappers::BroadcastStream;

use crate::registry::LaunchSpec;

const RING_BUFFER_SIZE: usize = 1024;
const STDERR_TAIL_SIZE: usize = 16;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("failed to spawn subprocess: {0}")]
    Spawn(std::io::Error),
    #[error("failed to capture subprocess stdin")]
    MissingStdin,
    #[error("failed to capture subprocess stdout")]
    MissingStdout,
    #[error("failed to capture subprocess stderr")]
    MissingStderr,
    #[error("invalid json-rpc envelope")]
    InvalidEnvelope,
    #[error("failed to serialize json-rpc message: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to write subprocess stdin: {0}")]
    Write(std::io::Error),
    #[error("agent process exited before responding")]
    Exited {
        exit_code: Option<i32>,
        stderr: Option<String>,
    },
    #[error("timeout waiting for response")]
    Timeout,
}

#[derive(Debug)]
pub enum PostOutcome {
    Response(Value),
    Accepted,
}

#[derive(Debug, Clone)]
struct StreamMessage {
    sequence: u64,
    payload: Value,
}

#[derive(Debug)]
pub struct AdapterRuntime {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    sender: broadcast::Sender<StreamMessage>,
    ring: Arc<Mutex<VecDeque<StreamMessage>>>,
    sequence: Arc<AtomicU64>,
    request_timeout: Duration,
    shutting_down: AtomicBool,
    spawned_at: Instant,
    first_stdout: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl AdapterRuntime {
    pub async fn start(
        launch: LaunchSpec,
        request_timeout: Duration,
    ) -> Result<Self, AdapterError> {
        let spawn_start = Instant::now();

        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (key, value) in &launch.env {
            command.env(key, value);
        }

        tracing::info!(
            program = ?launch.program,
            args = ?launch.args,
            "spawning agent process"
        );

        let mut child = command.spawn().map_err(|err| {
            tracing::error!(
                program = ?launch.program,
                error = %err,
                "failed to spawn agent process"
            );
            AdapterError::Spawn(err)
        })?;

        let pid = child.id().unwrap_or(0);
        let spawn_elapsed = spawn_start.elapsed();
        tracing::info!(
            pid = pid,
            elapsed_ms = spawn_elapsed.as_millis() as u64,
            "agent process spawned"
        );

        let stdin = child.stdin.take().ok_or(AdapterError::MissingStdin)?;
        let stdout = child.stdout.take().ok_or(AdapterError::MissingStdout)?;
        let stderr = child.stderr.take().ok_or(AdapterError::MissingStderr)?;

        let (sender, _rx) = broadcast::channel(512);
        let runtime = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            sender,
            ring: Arc::new(Mutex::new(VecDeque::with_capacity(RING_BUFFER_SIZE))),
            sequence: Arc::new(AtomicU64::new(0)),
            request_timeout,
            shutting_down: AtomicBool::new(false),
            spawned_at: spawn_start,
            first_stdout: Arc::new(AtomicBool::new(false)),
            stderr_tail: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_SIZE))),
        };

        runtime.spawn_stdout_loop(stdout);
        runtime.spawn_stderr_loop(stderr);
        runtime.spawn_exit_watcher();

        Ok(runtime)
    }

    pub async fn post(&self, payload: Value) -> Result<PostOutcome, AdapterError> {
        if !payload.is_object() {
            return Err(AdapterError::InvalidEnvelope);
        }

        let method: String = payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>")
            .to_string();
        let has_method = payload.get("method").is_some();
        let id = payload.get("id");

        if has_method && id.is_some() {
            let id_value = id.expect("checked");
            let key = id_key(id_value);
            let (tx, rx) = oneshot::channel();

            let pending_count = self.pending.lock().await.len();
            tracing::info!(
                method = %method,
                id = %key,
                pending_count = pending_count,
                "post: request → agent (awaiting response)"
            );

            self.pending.lock().await.insert(key.clone(), tx);

            let write_start = Instant::now();
            if let Err(err) = self.send_to_subprocess(&payload).await {
                tracing::error!(
                    method = %method,
                    id = %key,
                    error = %err,
                    "post: failed to write to agent stdin"
                );
                self.pending.lock().await.remove(&key);
                return Err(err);
            }
            let write_ms = write_start.elapsed().as_millis() as u64;
            tracing::debug!(
                method = %method,
                id = %key,
                write_ms = write_ms,
                "post: stdin write complete, waiting for response"
            );

            let wait_start = Instant::now();
            match tokio::time::timeout(self.request_timeout, rx).await {
                Ok(Ok(response)) => {
                    let wait_ms = wait_start.elapsed().as_millis() as u64;
                    tracing::info!(
                        method = %method,
                        id = %key,
                        response_ms = wait_ms,
                        total_ms = write_ms + wait_ms,
                        "post: got response from agent"
                    );
                    Ok(PostOutcome::Response(response))
                }
                Ok(Err(_)) => {
                    let wait_ms = wait_start.elapsed().as_millis() as u64;
                    tracing::error!(
                        method = %method,
                        id = %key,
                        wait_ms = wait_ms,
                        "post: response channel dropped (agent process may have exited)"
                    );
                    self.pending.lock().await.remove(&key);
                    if let Some((exit_code, stderr)) = self.try_process_exit_info().await {
                        tracing::error!(
                            method = %method,
                            id = %key,
                            exit_code = ?exit_code,
                            stderr = ?stderr,
                            "post: agent process exited before response channel completed"
                        );
                        return Err(AdapterError::Exited { exit_code, stderr });
                    }
                    Err(AdapterError::Timeout)
                }
                Err(_) => {
                    let pending_keys: Vec<String> =
                        self.pending.lock().await.keys().cloned().collect();
                    tracing::error!(
                        method = %method,
                        id = %key,
                        timeout_ms = self.request_timeout.as_millis() as u64,
                        age_ms = self.spawned_at.elapsed().as_millis() as u64,
                        pending_keys = ?pending_keys,
                        first_stdout_seen = self.first_stdout.load(Ordering::Relaxed),
                        "post: TIMEOUT waiting for agent response"
                    );
                    self.pending.lock().await.remove(&key);
                    if let Some((exit_code, stderr)) = self.try_process_exit_info().await {
                        tracing::error!(
                            method = %method,
                            id = %key,
                            exit_code = ?exit_code,
                            stderr = ?stderr,
                            "post: agent process exited before timeout completed"
                        );
                        return Err(AdapterError::Exited { exit_code, stderr });
                    }
                    Err(AdapterError::Timeout)
                }
            }
        } else {
            tracing::debug!(
                method = %method,
                "post: notification → agent (fire-and-forget)"
            );
            self.send_to_subprocess(&payload).await?;
            Ok(PostOutcome::Accepted)
        }
    }

    async fn subscribe(
        &self,
        last_event_id: Option<u64>,
    ) -> (Vec<(u64, Value)>, broadcast::Receiver<StreamMessage>) {
        let replay = {
            let ring = self.ring.lock().await;
            ring.iter()
                .filter(|message| {
                    if let Some(last_event_id) = last_event_id {
                        message.sequence > last_event_id
                    } else {
                        true
                    }
                })
                .map(|message| (message.sequence, message.payload.clone()))
                .collect::<Vec<_>>()
        };
        (replay, self.sender.subscribe())
    }

    pub async fn sse_stream(
        self: Arc<Self>,
        last_event_id: Option<u64>,
    ) -> impl Stream<Item = Result<Event, Infallible>> + Send + 'static {
        let (replay, rx) = self.subscribe(last_event_id).await;
        let replay_stream = stream::iter(replay.into_iter().map(|(sequence, payload)| {
            let event = Event::default()
                .event("message")
                .id(sequence.to_string())
                .data(payload.to_string());
            Ok(event)
        }));

        let live_stream = BroadcastStream::new(rx).filter_map(|item| async move {
            match item {
                Ok(message) => {
                    let event = Event::default()
                        .event("message")
                        .id(message.sequence.to_string())
                        .data(message.payload.to_string());
                    Some(Ok(event))
                }
                Err(_) => None,
            }
        });

        replay_stream.chain(live_stream)
    }

    /// Stream of raw JSON-RPC `Value` payloads (without SSE framing).
    /// Useful for consumers that need to inspect the payload contents
    /// rather than forward them as SSE events.
    pub async fn value_stream(
        self: Arc<Self>,
        last_event_id: Option<u64>,
    ) -> impl Stream<Item = Value> + Send + 'static {
        let (replay, rx) = self.subscribe(last_event_id).await;
        let replay_stream = stream::iter(replay.into_iter().map(|(_sequence, payload)| payload));
        let live_stream = BroadcastStream::new(rx).filter_map(|item| async move {
            match item {
                Ok(message) => Some(message.payload),
                Err(_) => None,
            }
        });
        replay_stream.chain(live_stream)
    }

    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }

        tracing::info!(
            age_ms = self.spawned_at.elapsed().as_millis() as u64,
            "shutting down agent process"
        );

        self.pending.lock().await.clear();
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            Err(_) => {
                let _ = child.kill().await;
            }
        }
    }

    fn spawn_stdout_loop(&self, stdout: tokio::process::ChildStdout) {
        let pending = self.pending.clone();
        let sender = self.sender.clone();
        let ring = self.ring.clone();
        let sequence = self.sequence.clone();
        let spawned_at = self.spawned_at;
        let first_stdout = self.first_stdout.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut line_count: u64 = 0;

            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                line_count += 1;

                if !first_stdout.swap(true, Ordering::Relaxed) {
                    tracing::info!(
                        first_stdout_ms = spawned_at.elapsed().as_millis() as u64,
                        line_bytes = trimmed.len(),
                        "agent process: first stdout line received"
                    );
                }

                let payload = match serde_json::from_str::<Value>(trimmed) {
                    Ok(payload) => payload,
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            line_number = line_count,
                            raw = %if trimmed.len() > 200 {
                                format!("{}...", &trimmed[..200])
                            } else {
                                trimmed.to_string()
                            },
                            "agent stdout: invalid JSON"
                        );
                        json!({
                            "jsonrpc": "2.0",
                            "method": "_adapter/invalid_stdout",
                            "params": {
                                "error": err.to_string(),
                                "raw": trimmed,
                            }
                        })
                    }
                };

                let is_response = payload.get("id").is_some() && payload.get("method").is_none();
                if is_response {
                    let key = id_key(payload.get("id").expect("checked"));
                    let has_error = payload.get("error").is_some();
                    if let Some(tx) = pending.lock().await.remove(&key) {
                        tracing::debug!(
                            id = %key,
                            has_error = has_error,
                            age_ms = spawned_at.elapsed().as_millis() as u64,
                            "agent stdout: response matched to pending request"
                        );
                        let _ = tx.send(payload.clone());
                        // Also broadcast the response so SSE/notification subscribers
                        // see it in order after preceding notifications. This lets the
                        // SSE translation task detect turn completion after all
                        // session/update events have been processed.
                        let seq = sequence.fetch_add(1, Ordering::SeqCst) + 1;
                        let message = StreamMessage {
                            sequence: seq,
                            payload,
                        };
                        {
                            let mut guard = ring.lock().await;
                            guard.push_back(message.clone());
                            while guard.len() > RING_BUFFER_SIZE {
                                guard.pop_front();
                            }
                        }
                        let _ = sender.send(message);
                        continue;
                    } else {
                        tracing::warn!(
                            id = %key,
                            has_error = has_error,
                            "agent stdout: response has no matching pending request (orphan)"
                        );
                    }
                }

                let method = payload
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<none>");
                tracing::debug!(
                    method = method,
                    line_number = line_count,
                    "agent stdout: notification/event → SSE broadcast"
                );

                let seq = sequence.fetch_add(1, Ordering::SeqCst) + 1;
                let message = StreamMessage {
                    sequence: seq,
                    payload,
                };

                {
                    let mut guard = ring.lock().await;
                    guard.push_back(message.clone());
                    while guard.len() > RING_BUFFER_SIZE {
                        guard.pop_front();
                    }
                }

                let _ = sender.send(message);
            }

            tracing::info!(
                total_lines = line_count,
                age_ms = spawned_at.elapsed().as_millis() as u64,
                "agent stdout: stream ended"
            );
        });
    }

    fn spawn_stderr_loop(&self, stderr: tokio::process::ChildStderr) {
        let spawned_at = self.spawned_at;
        let stderr_tail = self.stderr_tail.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut line_count: u64 = 0;

            while let Ok(Some(line)) = lines.next_line().await {
                line_count += 1;
                {
                    let mut tail = stderr_tail.lock().await;
                    tail.push_back(line.clone());
                    while tail.len() > STDERR_TAIL_SIZE {
                        tail.pop_front();
                    }
                }
                tracing::info!(
                    line_number = line_count,
                    age_ms = spawned_at.elapsed().as_millis() as u64,
                    "agent stderr: {}",
                    line
                );
            }

            tracing::debug!(
                total_lines = line_count,
                age_ms = spawned_at.elapsed().as_millis() as u64,
                "agent stderr: stream ended"
            );
        });
    }

    fn spawn_exit_watcher(&self) {
        let child = self.child.clone();
        let sender = self.sender.clone();
        let ring = self.ring.clone();
        let sequence = self.sequence.clone();
        let spawned_at = self.spawned_at;
        let pending = self.pending.clone();

        tokio::spawn(async move {
            let status = {
                let mut guard = child.lock().await;
                guard.wait().await.ok()
            };

            let age_ms = spawned_at.elapsed().as_millis() as u64;
            let pending_count = pending.lock().await.len();

            if let Some(status) = status {
                tracing::warn!(
                    success = status.success(),
                    code = status.code(),
                    age_ms = age_ms,
                    pending_requests = pending_count,
                    "agent process exited"
                );

                let payload = json!({
                    "jsonrpc": "2.0",
                    "method": "_adapter/agent_exited",
                    "params": {
                        "success": status.success(),
                        "code": status.code(),
                    }
                });

                let seq = sequence.fetch_add(1, Ordering::SeqCst) + 1;
                let message = StreamMessage {
                    sequence: seq,
                    payload,
                };

                {
                    let mut guard = ring.lock().await;
                    guard.push_back(message.clone());
                    while guard.len() > RING_BUFFER_SIZE {
                        guard.pop_front();
                    }
                }

                let _ = sender.send(message);
            } else {
                tracing::error!(
                    age_ms = age_ms,
                    pending_requests = pending_count,
                    "agent process: failed to get exit status"
                );
            }
        });
    }

    async fn send_to_subprocess(&self, payload: &Value) -> Result<(), AdapterError> {
        let method = payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>");
        let id = payload.get("id").map(|v| v.to_string()).unwrap_or_default();

        tracing::debug!(
            method = method,
            id = %id,
            bytes = serde_json::to_vec(payload).map(|b| b.len()).unwrap_or(0),
            "stdin: writing message to agent"
        );

        let mut stdin = self.stdin.lock().await;
        let bytes = serde_json::to_vec(payload).map_err(AdapterError::Serialize)?;
        stdin.write_all(&bytes).await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: write_all failed");
            AdapterError::Write(err)
        })?;
        stdin.write_all(b"\n").await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: newline write failed");
            AdapterError::Write(err)
        })?;
        stdin.flush().await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: flush failed");
            AdapterError::Write(err)
        })?;

        tracing::debug!(method = method, id = %id, "stdin: write+flush complete");
        Ok(())
    }

    async fn try_process_exit_info(&self) -> Option<(Option<i32>, Option<String>)> {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(status)) => {
                let exit_code = status.code();
                drop(child);
                let stderr = self.stderr_tail_summary().await;
                Some((exit_code, stderr))
            }
            Ok(None) => None,
            Err(_) => None,
        }
    }

    pub async fn stderr_tail_summary(&self) -> Option<String> {
        let tail = self.stderr_tail.lock().await;
        if tail.is_empty() {
            return None;
        }
        Some(tail.iter().cloned().collect::<Vec<_>>().join("\n"))
    }
}

fn id_key(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}
