use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::time::Duration;

use futures::StreamExt;
use reqwest::header::{self, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode};
use sandbox_agent::router::AuthConfig;
use serde_json::{json, Value};
use serial_test::serial;

#[path = "support/docker.rs"]
mod docker_support;
use docker_support::{LiveServer, TestApp};

fn write_executable(path: &Path, script: &str) {
    fs::write(path, script).expect("write executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).expect("set mode");
    }
}

fn write_fake_npm(path: &Path) {
    write_executable(
        path,
        r#"#!/usr/bin/env sh
set -e
prefix=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    install|--no-audit|--no-fund)
      shift
      ;;
    --prefix)
      prefix="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$prefix" ] || exit 1
mkdir -p "$prefix/node_modules/.bin"
for bin in claude-code-acp codex-acp amp-acp pi-acp cursor-agent-acp; do
  echo '#!/usr/bin/env sh' > "$prefix/node_modules/.bin/$bin"
  echo 'exit 0' >> "$prefix/node_modules/.bin/$bin"
  chmod +x "$prefix/node_modules/.bin/$bin"
done
exit 0
"#,
    );
}

fn serve_registry_once(document: Value) -> String {
    let listener = TcpListener::bind("0.0.0.0:0").expect("bind registry server");
    let port = listener.local_addr().expect("registry address").port();
    let body = document.to_string();

    std::thread::spawn(move || loop {
        match listener.accept() {
            Ok((mut stream, _)) => respond_json(&mut stream, &body),
            Err(_) => break,
        }
    });

    format!("http://127.0.0.1:{port}/registry.json")
}

fn respond_json(stream: &mut TcpStream, body: &str) {
    let mut buffer = [0_u8; 4096];
    let _ = stream.read(&mut buffer);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .expect("write registry response");
    stream.flush().expect("flush registry response");
}

async fn send_request(
    app: &docker_support::DockerApp,
    method: Method,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let client = reqwest::Client::new();
    let mut builder = client.request(method, app.http_url(uri));
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes()).expect("header name");
        let header_value = HeaderValue::from_str(value).expect("header value");
        builder = builder.header(header_name, header_value);
    }

    let response = if let Some(body) = body {
        builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("request handled")
    } else {
        builder.send().await.expect("request handled")
    };
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.bytes().await.expect("collect body");

    (status, headers, bytes.to_vec())
}

async fn send_request_raw(
    app: &docker_support::DockerApp,
    method: Method,
    uri: &str,
    body: Option<Vec<u8>>,
    headers: &[(&str, &str)],
    content_type: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let client = reqwest::Client::new();
    let mut builder = client.request(method, app.http_url(uri));
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes()).expect("header name");
        let header_value = HeaderValue::from_str(value).expect("header value");
        builder = builder.header(header_name, header_value);
    }

    let response = if let Some(body) = body {
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        builder.body(body).send().await.expect("request handled")
    } else {
        builder.send().await.expect("request handled")
    };
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.bytes().await.expect("collect body");

    (status, headers, bytes.to_vec())
}

async fn launch_desktop_focus_window(app: &docker_support::DockerApp, display: &str) {
    let command = r#"nohup xterm -geometry 80x24+40+40 -title 'Sandbox Desktop Test' -e sh -lc 'sleep 60' >/tmp/sandbox-agent-xterm.log 2>&1 < /dev/null & for _ in $(seq 1 50); do wid="$(xdotool search --onlyvisible --name 'Sandbox Desktop Test' 2>/dev/null | head -n 1 || true)"; if [ -n "$wid" ]; then xdotool windowactivate "$wid"; exit 0; fi; sleep 0.1; done; exit 1"#;
    let (status, _, body) = send_request(
        app,
        Method::POST,
        "/v1/processes/run",
        Some(json!({
            "command": "sh",
            "args": ["-lc", command],
            "env": {
                "DISPLAY": display,
            },
            "timeoutMs": 10_000
        })),
        &[],
    )
    .await;

    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected desktop focus window launch response: {}",
        String::from_utf8_lossy(&body)
    );
    let parsed = parse_json(&body);
    assert_eq!(parsed["exitCode"], 0);
}

fn parse_json(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).expect("valid json")
    }
}

fn initialize_payload() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "1.0",
            "clientCapabilities": {}
        }
    })
}

async fn bootstrap_server(app: &docker_support::DockerApp, server_id: &str, agent: &str) {
    let initialize = initialize_payload();
    let (status, _, _body) = send_request(
        app,
        Method::POST,
        &format!("/v1/acp/{server_id}?agent={agent}"),
        Some(initialize),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

async fn read_first_sse_data(app: &docker_support::DockerApp, server_id: &str) -> String {
    let client = reqwest::Client::new();
    let response = client
        .get(app.http_url(&format!("/v1/acp/{server_id}")))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("sse response");
    assert_eq!(response.status(), StatusCode::OK);

    let mut stream = response.bytes_stream();
    tokio::time::timeout(Duration::from_secs(5), async move {
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.expect("stream chunk");
            let text = String::from_utf8_lossy(&bytes).to_string();
            if text.contains("data:") {
                return text;
            }
        }
        panic!("SSE stream ended before data chunk")
    })
    .await
    .expect("timed out reading sse")
}

async fn read_first_sse_data_with_last_id(
    app: &docker_support::DockerApp,
    server_id: &str,
    last_event_id: u64,
) -> String {
    let client = reqwest::Client::new();
    let response = client
        .get(app.http_url(&format!("/v1/acp/{server_id}")))
        .header("accept", "text/event-stream")
        .header("last-event-id", last_event_id.to_string())
        .send()
        .await
        .expect("sse response");
    assert_eq!(response.status(), StatusCode::OK);

    let mut stream = response.bytes_stream();
    tokio::time::timeout(Duration::from_secs(5), async move {
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.expect("stream chunk");
            let text = String::from_utf8_lossy(&bytes).to_string();
            if text.contains("data:") {
                return text;
            }
        }
        panic!("SSE stream ended before data chunk")
    })
    .await
    .expect("timed out reading sse")
}

fn parse_sse_data(chunk: &str) -> Value {
    let data = chunk
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str(&data).expect("valid SSE payload json")
}

fn parse_sse_event_id(chunk: &str) -> u64 {
    chunk
        .lines()
        .find_map(|line| line.strip_prefix("id: "))
        .and_then(|value| value.trim().parse::<u64>().ok())
        .expect("sse event id")
}

#[path = "v1_api/acp_transport.rs"]
mod acp_transport;
#[path = "v1_api/config_endpoints.rs"]
mod config_endpoints;
#[path = "v1_api/control_plane.rs"]
mod control_plane;
#[path = "v1_api/desktop.rs"]
mod desktop;
#[path = "v1_api/processes.rs"]
mod processes;
