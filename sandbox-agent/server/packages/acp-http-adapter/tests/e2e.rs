use std::io;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures::StreamExt;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

struct AdapterHandle {
    child: Child,
    base_url: String,
}

impl Drop for AdapterHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test]
async fn health_and_request_response_round_trip() {
    let adapter = spawn_adapter().expect("spawn adapter");
    wait_for_health(&adapter.base_url)
        .await
        .expect("wait for health");

    let client = Client::new();
    let health = client
        .get(format!("{}/v1/health", adapter.base_url))
        .send()
        .await
        .expect("health request");
    assert_eq!(health.status(), StatusCode::OK);
    let health_json: Value = health.json().await.expect("health json");
    assert_eq!(health_json["ok"], true);

    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "mock/ping",
        "params": {
            "text": "hello"
        }
    });

    let response = client
        .post(format!("{}/v1/rpc", adapter.base_url))
        .json(&payload)
        .send()
        .await
        .expect("post rpc");
    assert_eq!(response.status(), StatusCode::OK);

    let body: Value = response.json().await.expect("response json");
    assert_eq!(body["jsonrpc"], "2.0");
    assert_eq!(body["id"], 1);
    assert_eq!(body["result"]["echoed"]["method"], "mock/ping");
    assert_eq!(body["result"]["echoed"]["params"]["text"], "hello");
}

#[tokio::test]
async fn sse_request_and_client_response_flow() {
    let adapter = spawn_adapter().expect("spawn adapter");
    wait_for_health(&adapter.base_url)
        .await
        .expect("wait for health");

    let client = Client::new();

    let sse_response = client
        .get(format!("{}/v1/rpc", adapter.base_url))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("open sse");
    assert_eq!(sse_response.status(), StatusCode::OK);

    let mut sse = SseReader::new(sse_response);

    let request = json!({
        "jsonrpc": "2.0",
        "id": 42,
        "method": "mock/ask_client",
        "params": {
            "need": "input"
        }
    });

    let initial = client
        .post(format!("{}/v1/rpc", adapter.base_url))
        .json(&request)
        .send()
        .await
        .expect("post ask_client");
    assert_eq!(initial.status(), StatusCode::OK);

    let initial_body: Value = initial.json().await.expect("initial body");
    assert_eq!(initial_body["id"], 42);

    let mut agent_request_id = None;
    for _ in 0..10 {
        let event = sse
            .next_json(Duration::from_secs(3))
            .await
            .expect("sse event");
        if event["method"] == "mock/request" {
            agent_request_id = event.get("id").cloned();
            break;
        }
    }

    let agent_request_id = agent_request_id.expect("agent request id");

    let client_response = json!({
        "jsonrpc": "2.0",
        "id": agent_request_id,
        "result": {
            "approved": true
        }
    });

    let response = client
        .post(format!("{}/v1/rpc", adapter.base_url))
        .json(&client_response)
        .send()
        .await
        .expect("post client response");
    assert_eq!(response.status(), StatusCode::ACCEPTED);

    let mut saw_client_response = false;
    for _ in 0..10 {
        let event = sse
            .next_json(Duration::from_secs(3))
            .await
            .expect("sse follow-up");
        if event["method"] == "mock/client_response" {
            assert_eq!(event["params"]["result"]["approved"], true);
            saw_client_response = true;
            break;
        }
    }

    assert!(
        saw_client_response,
        "expected mock/client_response over SSE"
    );
}

struct SseReader {
    stream: futures::stream::BoxStream<'static, Result<bytes::Bytes, reqwest::Error>>,
    buffer: Vec<u8>,
}

impl SseReader {
    fn new(response: reqwest::Response) -> Self {
        Self {
            stream: response.bytes_stream().boxed(),
            buffer: Vec::new(),
        }
    }

    async fn next_json(&mut self, timeout: Duration) -> io::Result<Value> {
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(event) = self.try_parse_event()? {
                return Ok(event);
            }

            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for sse event",
                ));
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            let chunk = tokio::time::timeout(remaining, self.stream.next())
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out reading sse"))?;

            match chunk {
                Some(Ok(bytes)) => self.buffer.extend_from_slice(&bytes),
                Some(Err(err)) => {
                    return Err(io::Error::other(format!("sse stream error: {err}")));
                }
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "sse stream ended",
                    ));
                }
            }
        }
    }

    fn try_parse_event(&mut self) -> io::Result<Option<Value>> {
        let split = self
            .buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .or_else(|| {
                self.buffer
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
            });

        let Some(idx) = split else {
            return Ok(None);
        };

        let delimiter_len = if self.buffer.get(idx..idx + 2) == Some(b"\n\n") {
            2
        } else {
            4
        };

        let block = self.buffer.drain(..idx + delimiter_len).collect::<Vec<_>>();
        let text = String::from_utf8_lossy(&block);

        let data = text
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .collect::<Vec<_>>()
            .join("\n");

        if data.is_empty() {
            return Ok(None);
        }

        let value: Value = serde_json::from_str(&data).map_err(|err| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid sse json payload: {err}"),
            )
        })?;

        Ok(Some(value))
    }
}

fn spawn_adapter() -> io::Result<AdapterHandle> {
    let port = pick_port()?;
    let base_url = format!("http://127.0.0.1:{port}");

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .ancestors()
        .nth(3)
        .expect("workspace root")
        .to_path_buf();
    let mock_agent_js = workspace_root.join("examples/mock-acp-agent/dist/index.js");

    let registry_blob = json!({
        "id": "mock-acp-agent",
        "distribution": {
            "binary": {
                "linux-x86_64": {
                    "cmd": "node",
                    "args": [mock_agent_js.to_string_lossy()],
                    "env": {}
                },
                "linux-aarch64": {
                    "cmd": "node",
                    "args": [mock_agent_js.to_string_lossy()],
                    "env": {}
                },
                "darwin-x86_64": {
                    "cmd": "node",
                    "args": [mock_agent_js.to_string_lossy()],
                    "env": {}
                },
                "darwin-aarch64": {
                    "cmd": "node",
                    "args": [mock_agent_js.to_string_lossy()],
                    "env": {}
                },
                "windows-x86_64": {
                    "cmd": "node",
                    "args": [mock_agent_js.to_string_lossy()],
                    "env": {}
                },
                "windows-aarch64": {
                    "cmd": "node",
                    "args": [mock_agent_js.to_string_lossy()],
                    "env": {}
                }
            }
        }
    })
    .to_string();

    let child = Command::new(env!("CARGO_BIN_EXE_acp-http-adapter"))
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--registry-json")
        .arg(registry_blob)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;

    Ok(AdapterHandle { child, base_url })
}

fn pick_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

async fn wait_for_health(base_url: &str) -> io::Result<()> {
    let client = Client::new();
    let deadline = Instant::now() + Duration::from_secs(10);

    loop {
        if Instant::now() > deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "adapter did not become healthy",
            ));
        }

        if let Ok(response) = client.get(format!("{base_url}/v1/health")).send().await {
            if response.status() == StatusCode::OK {
                return Ok(());
            }
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
