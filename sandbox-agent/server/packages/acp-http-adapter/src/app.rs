use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::KeepAlive;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};

use crate::process::{AdapterError, AdapterRuntime, PostOutcome};

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct Problem {
    r#type: &'static str,
    title: &'static str,
    status: u16,
    detail: String,
}

pub fn build_router(runtime: Arc<AdapterRuntime>) -> Router {
    Router::new()
        .route("/v1/health", get(get_health))
        .route("/v1/rpc", post(post_rpc).get(get_rpc).delete(delete_rpc))
        .with_state(runtime)
}

async fn get_health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn post_rpc(
    State(runtime): State<Arc<AdapterRuntime>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    if !is_json_content_type(&headers) {
        return problem(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "content-type must be application/json",
        );
    }

    match runtime.post(payload).await {
        Ok(PostOutcome::Response(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(PostOutcome::Accepted) => StatusCode::ACCEPTED.into_response(),
        Err(err) => map_error(err),
    }
}

async fn get_rpc(
    State(runtime): State<Arc<AdapterRuntime>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let last_event_id = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    let stream = runtime.clone().sse_stream(last_event_id).await;
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

async fn delete_rpc() -> StatusCode {
    StatusCode::NO_CONTENT
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.starts_with("application/json"))
        .unwrap_or(false)
}

fn map_error(err: AdapterError) -> Response {
    match err {
        AdapterError::InvalidEnvelope => problem(
            StatusCode::BAD_REQUEST,
            "invalid_envelope",
            "request body must be a JSON-RPC object",
        ),
        AdapterError::Timeout => problem(
            StatusCode::GATEWAY_TIMEOUT,
            "timeout",
            "timed out waiting for agent response",
        ),
        AdapterError::Exited { exit_code, stderr } => {
            let detail = if let Some(stderr) = stderr {
                format!(
                    "agent process exited before responding (exit_code: {:?}, stderr: {})",
                    exit_code, stderr
                )
            } else {
                format!(
                    "agent process exited before responding (exit_code: {:?})",
                    exit_code
                )
            };
            problem(StatusCode::BAD_GATEWAY, "agent_exited", &detail)
        }
        AdapterError::Write(write) => problem(
            StatusCode::BAD_GATEWAY,
            "write_failed",
            &format!("failed writing to agent stdin: {write}"),
        ),
        AdapterError::Serialize(ser) => problem(
            StatusCode::BAD_REQUEST,
            "serialize_failed",
            &format!("failed to serialize JSON payload: {ser}"),
        ),
        AdapterError::Spawn(spawn) => problem(
            StatusCode::BAD_GATEWAY,
            "spawn_failed",
            &format!("failed to start agent process: {spawn}"),
        ),
        AdapterError::MissingStdin | AdapterError::MissingStdout | AdapterError::MissingStderr => {
            problem(
                StatusCode::BAD_GATEWAY,
                "io_setup_failed",
                "agent subprocess pipes were not available",
            )
        }
    }
}

fn problem(status: StatusCode, title: &'static str, detail: &str) -> Response {
    (
        status,
        Json(json!(Problem {
            r#type: "about:blank",
            title,
            status: status.as_u16(),
            detail: detail.to_string(),
        })),
    )
        .into_response()
}
