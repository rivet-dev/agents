use super::*;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use serial_test::serial;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

async fn wait_for_exited(test_app: &TestApp, process_id: &str) {
    for _ in 0..30 {
        let (status, _, body) = send_request(
            &test_app.app,
            Method::GET,
            &format!("/v1/processes/{process_id}"),
            None,
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let parsed = parse_json(&body);
        if parsed["status"] == "exited" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    panic!("process did not exit in time");
}

fn decode_log_entries(entries: &[Value]) -> String {
    entries
        .iter()
        .filter_map(|entry| entry.get("data").and_then(Value::as_str))
        .filter_map(|encoded| BASE64.decode(encoded).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .collect::<Vec<_>>()
        .join("")
}

async fn recv_ws_message(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Message {
    tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("timed out waiting for websocket frame")
        .expect("websocket stream ended")
        .expect("websocket frame")
}

#[tokio::test]
async fn v1_processes_config_round_trip() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/processes/config",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["maxConcurrentProcesses"], 64);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes/config",
        Some(json!({
            "maxConcurrentProcesses": 8,
            "defaultRunTimeoutMs": 1000,
            "maxRunTimeoutMs": 5000,
            "maxOutputBytes": 4096,
            "maxLogBytesPerProcess": 32768,
            "maxInputBytesPerRequest": 1024
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["maxConcurrentProcesses"], 8);
    assert_eq!(parsed["defaultRunTimeoutMs"], 1000);
}

#[tokio::test]
async fn v1_process_lifecycle_requires_stop_before_delete() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "sh",
            "args": ["-lc", "sleep 30"],
            "tty": false,
            "interactive": false
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let process_id = parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string();

    let (status, _, body) = send_request(
        &test_app.app,
        Method::DELETE,
        &format!("/v1/processes/{process_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(parse_json(&body)["status"], 409);

    let (status, _, _body) = send_request(
        &test_app.app,
        Method::POST,
        &format!("/v1/processes/{process_id}/stop"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    wait_for_exited(&test_app, &process_id).await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        &format!("/v1/processes/{process_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn v1_process_run_returns_output_and_timeout() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes/run",
        Some(json!({
            "command": "sh",
            "args": ["-lc", "echo hi"],
            "timeoutMs": 1000
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["timedOut"], false);
    assert_eq!(parsed["exitCode"], 0);
    assert!(parsed["stdout"].as_str().unwrap_or_default().contains("hi"));

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes/run",
        Some(json!({
            "command": "sh",
            "args": ["-lc", "sleep 2"],
            "timeoutMs": 50
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["timedOut"], true);
}

#[tokio::test]
async fn v1_process_run_reports_truncation() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes/run",
        Some(json!({
            "command": "sh",
            "args": ["-lc", "printf 'abcdefghijklmnopqrstuvwxyz'"],
            "maxOutputBytes": 5
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["stdoutTruncated"], true);
    assert_eq!(parsed["stderrTruncated"], false);
    assert_eq!(parsed["stdout"].as_str().unwrap_or_default().len(), 5);
}

#[tokio::test]
async fn v1_process_tty_input_and_logs() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "cat",
            "tty": true,
            "interactive": true
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let process_id = parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string();

    let (status, _, _body) = send_request(
        &test_app.app,
        Method::POST,
        &format!("/v1/processes/{process_id}/input"),
        Some(json!({
            "data": "aGVsbG8K",
            "encoding": "base64"
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    tokio::time::sleep(Duration::from_millis(150)).await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v1/processes/{process_id}/logs?stream=pty&tail=20"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = parse_json(&body)["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(!entries.is_empty());

    let (status, _, _body) = send_request(
        &test_app.app,
        Method::POST,
        &format!("/v1/processes/{process_id}/kill"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    wait_for_exited(&test_app, &process_id).await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        &format!("/v1/processes/{process_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
#[serial]
async fn v1_processes_owner_filter_separates_user_and_desktop_processes() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "sh",
            "args": ["-lc", "sleep 30"],
            "tty": false,
            "interactive": false
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let user_process_id = parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string();

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/start",
        Some(json!({
            "width": 1024,
            "height": 768
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["state"], "active");

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/processes?owner=user",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let user_processes = parse_json(&body)["processes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(user_processes
        .iter()
        .any(|process| process["id"] == user_process_id));
    assert!(user_processes
        .iter()
        .all(|process| process["owner"] == "user"));

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/processes?owner=desktop",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let desktop_processes = parse_json(&body)["processes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(desktop_processes.len() >= 2);
    assert!(desktop_processes
        .iter()
        .all(|process| process["owner"] == "desktop"));

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        &format!("/v1/processes/{user_process_id}/kill"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, body) =
        send_request(&test_app.app, Method::POST, "/v1/desktop/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["state"], "inactive");
}

#[tokio::test]
async fn v1_process_not_found_returns_404() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/processes/does-not-exist",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(parse_json(&body)["status"], 404);
}

#[tokio::test]
async fn v1_process_input_limit_returns_413() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes/config",
        Some(json!({
            "maxConcurrentProcesses": 8,
            "defaultRunTimeoutMs": 1000,
            "maxRunTimeoutMs": 5000,
            "maxOutputBytes": 4096,
            "maxLogBytesPerProcess": 32768,
            "maxInputBytesPerRequest": 4
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "cat",
            "tty": true,
            "interactive": true
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let process_id = parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string();

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        &format!("/v1/processes/{process_id}/input"),
        Some(json!({
            "data": "aGVsbG8=",
            "encoding": "base64"
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(parse_json(&body)["status"], 413);
}

#[tokio::test]
async fn v1_tty_process_is_real_terminal() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "sh",
            "args": ["-lc", "tty"],
            "tty": true,
            "interactive": false
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let process_id = parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string();

    wait_for_exited(&test_app, &process_id).await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v1/processes/{process_id}/logs?stream=pty"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = parse_json(&body)["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let joined = decode_log_entries(&entries);
    assert!(!joined.to_lowercase().contains("not a tty"));
    assert!(joined.contains("/dev/"));
}

#[tokio::test]
async fn v1_process_logs_follow_sse_streams_entries() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "sh",
            "args": ["-lc", "echo first; sleep 0.3; echo second"],
            "tty": false,
            "interactive": false
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let process_id = parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string();

    let response = reqwest::Client::new()
        .get(test_app.app.http_url(&format!(
            "/v1/processes/{process_id}/logs?stream=stdout&follow=true"
        )))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("sse response");
    assert_eq!(response.status(), StatusCode::OK);

    let mut stream = response.bytes_stream();
    let chunk = tokio::time::timeout(Duration::from_secs(5), async move {
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.expect("stream chunk");
            let text = String::from_utf8_lossy(&bytes).to_string();
            if text.contains("data:") {
                return text;
            }
        }
        panic!("SSE stream ended before log chunk");
    })
    .await
    .expect("timed out reading process log sse");

    let payload = parse_sse_data(&chunk);
    assert!(payload["sequence"].as_u64().is_some());
    assert_eq!(payload["stream"], "stdout");
}

#[tokio::test]
async fn v1_access_token_query_only_allows_terminal_ws() {
    let test_app = TestApp::new(AuthConfig::with_token("secret-token".to_string()));

    let (status, _, _) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/health?access_token=secret-token",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "cat",
            "tty": true,
            "interactive": true
        })),
        &[("authorization", "Bearer secret-token")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let process_id = parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string();

    let (status, _, _) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v1/processes/{process_id}/terminal/ws"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v1/processes/{process_id}/terminal/ws?access_token=secret-token"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn v1_process_terminal_ws_e2e_is_deterministic() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let live_server = LiveServer::spawn(test_app.app.clone()).await;
    let http = reqwest::Client::new();

    let create_response = http
        .post(live_server.http_url("/v1/processes"))
        .json(&json!({
            "command": "sh",
            "args": ["-lc", "stty -echo; IFS= read -r line; printf 'got:%s\\n' \"$line\""],
            "tty": true,
            "interactive": true
        }))
        .send()
        .await
        .expect("create process response");
    assert_eq!(create_response.status(), reqwest::StatusCode::OK);
    let create_body: Value = create_response.json().await.expect("create process json");
    let process_id = create_body["id"].as_str().expect("process id").to_string();

    let ws_url = live_server.ws_url(&format!("/v1/processes/{process_id}/terminal/ws"));
    let (mut ws, _) = connect_async(&ws_url).await.expect("connect websocket");

    let ready = recv_ws_message(&mut ws).await;
    let ready_payload: Value =
        serde_json::from_str(ready.to_text().expect("ready text frame")).expect("ready json");
    assert_eq!(ready_payload["type"], "ready");
    assert_eq!(ready_payload["processId"], process_id);

    ws.send(Message::Text(
        json!({
            "type": "input",
            "data": "hello from ws\n"
        })
        .to_string(),
    ))
    .await
    .expect("send input frame");

    let mut saw_binary_output = false;
    let mut saw_exit = false;
    for _ in 0..10 {
        let frame = recv_ws_message(&mut ws).await;
        match frame {
            Message::Binary(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                if text.contains("got:hello from ws") {
                    saw_binary_output = true;
                }
            }
            Message::Text(text) => {
                let payload: Value = serde_json::from_str(&text).expect("ws json");
                if payload["type"] == "exit" {
                    saw_exit = true;
                    break;
                }
                assert_ne!(payload["type"], "error");
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
            _ => {}
        }
    }

    assert!(
        saw_binary_output,
        "expected pty binary output over websocket"
    );
    assert!(saw_exit, "expected exit control frame over websocket");

    let _ = ws.close(None).await;

    let delete_response = http
        .delete(live_server.http_url(&format!("/v1/processes/{process_id}")))
        .send()
        .await
        .expect("delete process response");
    assert_eq!(delete_response.status(), reqwest::StatusCode::NO_CONTENT);

    live_server.shutdown().await;
}

#[tokio::test]
async fn v1_process_terminal_ws_auth_e2e() {
    let token = "secret-token";
    let test_app = TestApp::new(AuthConfig::with_token(token.to_string()));
    let live_server = LiveServer::spawn(test_app.app.clone()).await;
    let http = reqwest::Client::new();

    let create_response = http
        .post(live_server.http_url("/v1/processes"))
        .bearer_auth(token)
        .json(&json!({
            "command": "cat",
            "tty": true,
            "interactive": true
        }))
        .send()
        .await
        .expect("create process response");
    assert_eq!(create_response.status(), reqwest::StatusCode::OK);
    let create_body: Value = create_response.json().await.expect("create process json");
    let process_id = create_body["id"].as_str().expect("process id").to_string();

    let unauth_ws_url = live_server.ws_url(&format!("/v1/processes/{process_id}/terminal/ws"));
    let unauth_err = connect_async(&unauth_ws_url)
        .await
        .expect_err("unauthenticated websocket handshake should fail");
    match unauth_err {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 401);
        }
        other => panic!("unexpected websocket auth error: {other:?}"),
    }

    let auth_ws_url = live_server.ws_url(&format!(
        "/v1/processes/{process_id}/terminal/ws?access_token={token}"
    ));
    let (mut ws, _) = connect_async(&auth_ws_url)
        .await
        .expect("authenticated websocket handshake");

    let ready = recv_ws_message(&mut ws).await;
    let ready_payload: Value =
        serde_json::from_str(ready.to_text().expect("ready text frame")).expect("ready json");
    assert_eq!(ready_payload["type"], "ready");
    assert_eq!(ready_payload["processId"], process_id);

    let _ = ws
        .send(Message::Text(json!({ "type": "close" }).to_string()))
        .await;
    let _ = ws.close(None).await;

    let kill_response = http
        .post(live_server.http_url(&format!("/v1/processes/{process_id}/kill?waitMs=1000")))
        .bearer_auth(token)
        .send()
        .await
        .expect("kill process response");
    assert_eq!(kill_response.status(), reqwest::StatusCode::OK);

    let delete_response = http
        .delete(live_server.http_url(&format!("/v1/processes/{process_id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("delete process response");
    assert_eq!(delete_response.status(), reqwest::StatusCode::NO_CONTENT);

    live_server.shutdown().await;
}
