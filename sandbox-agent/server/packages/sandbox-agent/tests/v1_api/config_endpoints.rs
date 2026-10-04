use super::*;

#[tokio::test]
async fn mcp_config_requires_directory_and_name() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, _) =
        send_request(&test_app.app, Method::GET, "/v1/config/mcp", None, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::PUT,
        "/v1/config/mcp?directory=/tmp",
        Some(json!({"type": "local", "command": "mcp"})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn mcp_config_crud_round_trip() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let project = test_app.root_path().join("mcp-config-project");
    fs::create_dir_all(&project).expect("create project dir");
    let directory = project.to_string_lossy().to_string();

    let entry = json!({
        "type": "local",
        "command": "node",
        "args": ["server.js"],
        "env": {"LOG_LEVEL": "debug"},
        "timeoutMs": 2000,
        "cwd": "/workspace"
    });

    let (status, _, _) = send_request(
        &test_app.app,
        Method::PUT,
        &format!("/v1/config/mcp?directory={directory}&mcpName=filesystem"),
        Some(entry.clone()),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v1/config/mcp?directory={directory}&mcpName=filesystem"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body), entry);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        &format!("/v1/config/mcp?directory={directory}&mcpName=filesystem"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v1/config/mcp?directory={directory}&mcpName=filesystem"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(parse_json(&body)["status"], 404);
}

#[tokio::test]
async fn skills_config_requires_directory_and_name() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, _) =
        send_request(&test_app.app, Method::GET, "/v1/config/skills", None, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::PUT,
        "/v1/config/skills?directory=/tmp",
        Some(json!({"sources": []})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn skills_config_crud_round_trip() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let project = test_app.root_path().join("skills-config-project");
    fs::create_dir_all(&project).expect("create project dir");
    let directory = project.to_string_lossy().to_string();

    let entry = json!({
        "sources": [
            {"type": "github", "source": "rivet-dev/skills", "skills": ["sandbox-agent"], "ref": "main"},
            {"type": "local", "source": "/workspace/my-skill"}
        ]
    });

    let (status, _, _) = send_request(
        &test_app.app,
        Method::PUT,
        &format!("/v1/config/skills?directory={directory}&skillName=default"),
        Some(entry.clone()),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v1/config/skills?directory={directory}&skillName=default"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body), entry);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        &format!("/v1/config/skills?directory={directory}&skillName=default"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v1/config/skills?directory={directory}&skillName=default"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
