use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use sandbox_agent::router::{build_router, AppState, AuthConfig};
use sandbox_agent_agent_management::agents::AgentManager;
use tower::util::ServiceExt;

#[tokio::test]
async fn opencode_routes_are_mounted() {
    let install_dir = tempfile::tempdir().expect("tempdir");
    let manager = AgentManager::new(install_dir.path()).expect("agent manager");
    let app = build_router(AppState::new(AuthConfig::disabled(), manager));

    let request = Request::builder()
        .method(Method::GET)
        .uri("/opencode/session")
        .body(Body::empty())
        .expect("build request");

    let response = app.oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);

    let body = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    assert!(parsed.is_array());
}
