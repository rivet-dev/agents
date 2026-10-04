use super::*;

fn write_stub_native(path: &Path, agent: &str) {
    let script = format!("#!/usr/bin/env sh\necho \"{agent} 0.0.1\"\nexit 0\n");
    write_executable(path, &script);
}

fn write_stub_agent_process(path: &Path, agent: &str) {
    let script = format!(
        r#"#!/usr/bin/env sh
if [ "${{1:-}}" = "--help" ] || [ "${{1:-}}" = "--version" ] || [ "${{1:-}}" = "version" ] || [ "${{1:-}}" = "-V" ]; then
  echo "{agent}-agent-process 0.0.1"
  exit 0
fi

while IFS= read -r line; do
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([^,}}]*\).*/\1/p')

  if [ -n "$method" ]; then
    printf '{{"jsonrpc":"2.0","method":"server/echo","params":{{"method":"%s"}}}}\n' "$method"
  fi

  if [ -n "$method" ] && [ -n "$id" ]; then
    printf '{{"jsonrpc":"2.0","id":%s,"result":{{"ok":true,"echoedMethod":"%s"}}}}\n' "$id" "$method"
  elif [ -z "$method" ] && [ -n "$id" ]; then
    printf '{{"jsonrpc":"2.0","method":"server/client_response","params":{{"id":%s}}}}\n' "$id"
  fi
done
"#
    );

    write_executable(path, &script);
}

fn write_strict_pi_agent_process(path: &Path) {
    // This stub intentionally mirrors the strict bootstrap validation behavior
    // observed in pi-acp:
    // - initialize.params.protocolVersion must be numeric
    // - session/new.params.mcpServers must be present (array)
    //
    // The proxy normalization layer should adapt legacy/raw client payloads so
    // requests still succeed against this stricter contract.
    let script = r#"#!/usr/bin/env sh
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "--version" ] || [ "${1:-}" = "version" ] || [ "${1:-}" = "-V" ]; then
  echo "pi-agent-process 0.0.1"
  exit 0
fi

while IFS= read -r line; do
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p')

  if [ "$method" = "initialize" ] && [ -n "$id" ]; then
    if printf '%s\n' "$line" | grep -Eq '"protocolVersion"[[:space:]]*:[[:space:]]*"'; then
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"Internal error","data":[{"expected":"number","code":"invalid_type","path":["protocolVersion"],"message":"Invalid input: expected number, received string"}]}}\n' "$id"
    else
      printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true,"echoedMethod":"initialize"}}\n' "$id"
    fi
    continue
  fi

  if [ "$method" = "session/new" ] && [ -n "$id" ]; then
    if printf '%s\n' "$line" | grep -Eq '"mcpServers"[[:space:]]*:[[:space:]]*\['; then
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"pi-session","echoedMethod":"session/new"}}\n' "$id"
    else
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"Internal error","data":[{"expected":"array","code":"invalid_type","path":["mcpServers"],"message":"Invalid input: expected array, received undefined"}]}}\n' "$id"
    fi
    continue
  fi

  if [ -n "$method" ] && [ -n "$id" ]; then
    printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true,"echoedMethod":"%s"}}\n' "$id" "$method"
  fi
done
"#;

    write_executable(path, script);
}

fn setup_stub_artifacts(install_dir: &Path, agent: &str) {
    let native = install_dir.join(agent);
    write_stub_native(&native, agent);

    let agent_processes = install_dir.join("agent_processes");
    fs::create_dir_all(&agent_processes).expect("create agent processes dir");
    let launcher = if cfg!(windows) {
        agent_processes.join(format!("{agent}-acp.cmd"))
    } else {
        agent_processes.join(format!("{agent}-acp"))
    };
    write_stub_agent_process(&launcher, agent);
}

fn setup_strict_pi_agent_process_only(install_dir: &Path) {
    let agent_processes = install_dir.join("agent_processes");
    fs::create_dir_all(&agent_processes).expect("create agent processes dir");
    let launcher = if cfg!(windows) {
        agent_processes.join("pi-acp.cmd")
    } else {
        agent_processes.join("pi-acp")
    };
    write_strict_pi_agent_process(&launcher);
}

#[tokio::test]
async fn acp_bootstrap_requires_agent_query() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-a",
        Some(initialize_payload()),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(parse_json(&body)["status"], 400);
}

#[cfg(unix)]
#[tokio::test]
async fn acp_round_trip_and_replay() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-replay?agent=codex",
        Some(initialize_payload()),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["echoedMethod"], "initialize");

    let prompt = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/prompt",
        "params": {
            "sessionId": "s-1",
            "prompt": [{"type": "text", "text": "hello"}]
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-replay",
        Some(prompt),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        parse_json(&body)["result"]["echoedMethod"],
        "session/prompt"
    );

    let first_chunk = read_first_sse_data_with_last_id(&test_app.app, "server-replay", 0).await;
    let first_event_id = parse_sse_event_id(&first_chunk);
    let first_event = parse_sse_data(&first_chunk);
    assert_eq!(first_event["method"], "server/echo");

    let second_chunk =
        read_first_sse_data_with_last_id(&test_app.app, "server-replay", first_event_id).await;
    let second_event_id = parse_sse_event_id(&second_chunk);
    assert!(second_event_id > first_event_id);
}

#[cfg(unix)]
#[tokio::test]
async fn pi_initialize_and_session_new_are_normalized() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_strict_pi_agent_process_only(install_dir);
    });

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-pi?agent=pi",
        Some(initialize_payload()),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["echoedMethod"], "initialize");

    let session_new = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {
            "cwd": "/tmp"
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-pi",
        Some(session_new),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["echoedMethod"], "session/new");
}

#[cfg(unix)]
#[tokio::test]
async fn acp_agent_mismatch_returns_conflict() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
        setup_stub_artifacts(install_dir, "claude");
    });

    bootstrap_server(&test_app.app, "server-mismatch", "codex").await;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {}
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-mismatch?agent=claude",
        Some(request),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(parse_json(&body)["status"], 409);
}

#[tokio::test]
async fn acp_get_unknown_returns_not_found() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/acp/missing", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(parse_json(&body)["status"], 404);
}

#[tokio::test]
async fn acp_delete_is_idempotent() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/acp/server-delete",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/acp/server-delete",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "1.0",
            "clientCapabilities": {}
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-delete",
        Some(request),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(parse_json(&body)["status"], 400);
}

#[cfg(unix)]
#[tokio::test]
async fn acp_list_servers_returns_active_instances() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-1", "codex").await;
    bootstrap_server(&test_app.app, "server-2", "codex").await;

    let (status, _, body) = send_request(&test_app.app, Method::GET, "/v1/acp", None, &[]).await;
    assert_eq!(status, StatusCode::OK);

    let parsed = parse_json(&body);
    let servers = parsed["servers"].as_array().expect("servers array");
    assert!(servers
        .iter()
        .any(|server| server["serverId"] == "server-1"));
    assert!(servers
        .iter()
        .any(|server| server["serverId"] == "server-2"));
}

#[cfg(unix)]
#[tokio::test]
async fn sandboxagent_methods_are_not_handled_specially() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-ext", "codex").await;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 22,
        "method": "_sandboxagent/session/list",
        "params": {}
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-ext",
        Some(request),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        parse_json(&body)["result"]["echoedMethod"],
        "_sandboxagent/session/list"
    );
}

#[tokio::test]
async fn post_requires_json_content_type() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let payload = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0","clientCapabilities":{}}}"#
        .to_vec();
    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-content?agent=mock",
        Some(payload),
        &[],
        Some("text/plain"),
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(parse_json(&body)["status"], 415);
}

#[tokio::test]
async fn sse_rejects_non_sse_accept() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/acp/server-a",
        None,
        &[("accept", "application/json")],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_ACCEPTABLE);
    assert_eq!(parse_json(&body)["status"], 406);
}

#[tokio::test]
async fn invalid_last_event_id_returns_bad_request() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/acp/server-a",
        None,
        &[("last-event-id", "not-a-number")],
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        parse_json(&body)["detail"],
        "invalid request: Last-Event-ID must be a positive integer"
    );
}
