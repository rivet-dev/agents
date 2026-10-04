use super::*;
use std::collections::BTreeMap;

#[tokio::test]
async fn v1_health_removed_legacy_and_opencode_unmounted() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(&test_app.app, Method::GET, "/v1/health", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["status"], "ok");

    let (status, _, _body) =
        send_request(&test_app.app, Method::GET, "/v1/anything", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, _) =
        send_request(&test_app.app, Method::GET, "/opencode/session", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn v1_auth_enforced_when_token_configured() {
    let test_app = TestApp::new(AuthConfig::with_token("secret-token".to_string()));

    let (status, _, _) = send_request(&test_app.app, Method::GET, "/v1/health", None, &[]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/health",
        None,
        &[("authorization", "Bearer secret-token")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["status"], "ok");
}

#[tokio::test]
async fn v1_filesystem_endpoints_round_trip() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::PUT,
        "/v1/fs/file?path=docs/file.txt",
        Some(b"hello".to_vec()),
        &[],
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["bytesWritten"], 5);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/fs/stat?path=docs/file.txt",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["entryType"], "file");

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/fs/entries?path=docs",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = parse_json(&body).as_array().cloned().expect("array");
    assert!(entries.iter().any(|entry| entry["name"] == "file.txt"));

    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/fs/file?path=docs/file.txt",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or(""),
        "application/octet-stream"
    );
    assert_eq!(String::from_utf8_lossy(&body), "hello");

    let move_body = json!({
        "from": "docs/file.txt",
        "to": "docs/renamed.txt",
        "overwrite": true
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/fs/move",
        Some(move_body),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(parse_json(&body)["to"]
        .as_str()
        .expect("to path")
        .ends_with("docs/renamed.txt"));

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/fs/mkdir?path=docs/nested",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/fs/entry?path=docs/nested&recursive=true",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
#[serial]
async fn require_preinstall_blocks_missing_agent() {
    let mut env = BTreeMap::new();
    env.insert(
        "SANDBOX_AGENT_REQUIRE_PREINSTALL".to_string(),
        "true".to_string(),
    );
    let test_app = TestApp::with_options(
        AuthConfig::disabled(),
        docker_support::TestAppOptions {
            env,
            ..Default::default()
        },
        |_| {},
    );

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-a?agent=codex",
        Some(initialize_payload()),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    let parsed = parse_json(&body);
    assert_eq!(parsed["status"], 404);
    assert_eq!(parsed["title"], "Agent Not Installed");
}

#[tokio::test]
#[serial]
async fn lazy_install_runs_on_first_bootstrap() {
    let registry_url = serve_registry_once(json!({
        "agents": [
            {
                "id": "codex-acp",
                "version": "1.2.3",
                "distribution": {
                    "npx": {
                        "package": "@example/codex-acp@1.2.3",
                        "args": [],
                        "env": {}
                    }
                }
            }
        ]
    }));

    let helper_bin_root = tempfile::tempdir().expect("helper bin tempdir");
    let helper_bin = helper_bin_root.path().join("bin");
    fs::create_dir_all(&helper_bin).expect("create helper bin dir");
    write_fake_npm(&helper_bin.join("npm"));

    let mut env = BTreeMap::new();
    env.insert("SANDBOX_AGENT_ACP_REGISTRY_URL".to_string(), registry_url);
    let test_app = TestApp::with_options(
        AuthConfig::disabled(),
        docker_support::TestAppOptions {
            env,
            extra_paths: vec![helper_bin.clone()],
            ..Default::default()
        },
        |install_path| {
            fs::create_dir_all(install_path.join("agent_processes"))
                .expect("create agent processes dir");
            write_executable(&install_path.join("codex"), "#!/usr/bin/env sh\nexit 0\n");
        },
    );

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-lazy?agent=codex",
        Some(json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "1.0",
                "clientCapabilities": {}
            }
        })),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(test_app
        .install_path()
        .join("agent_processes/codex-acp")
        .exists());
}
