use std::path::Path;

use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

include!(concat!(env!("OUT_DIR"), "/inspector_assets.rs"));

pub fn is_enabled() -> bool {
    INSPECTOR_ENABLED
}

pub fn router() -> Router {
    if !INSPECTOR_ENABLED {
        return Router::new()
            .route("/ui", get(handle_not_built))
            .route("/ui/", get(handle_not_built))
            .route("/ui/*path", get(handle_not_built));
    }
    Router::new()
        .route("/ui", get(handle_index))
        .route("/ui/", get(handle_index))
        .route("/ui/*path", get(handle_path))
}

async fn handle_not_built() -> Response {
    let body = "Inspector UI was not included in this build.\n\n\
                To enable it, build the frontend first:\n\n\
                  cd frontend/packages/inspector && pnpm install && pnpm build\n\n\
                Then rebuild sandbox-agent without SANDBOX_AGENT_SKIP_INSPECTOR.\n";
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body))
        .unwrap()
}

async fn handle_index() -> Response {
    serve_path("")
}

async fn handle_path(AxumPath(path): AxumPath<String>) -> Response {
    serve_path(&path)
}

fn serve_path(path: &str) -> Response {
    let Some(dir) = inspector_dir() else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let trimmed = path.trim_start_matches('/');
    let target = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };

    if let Some(file) = dir.get_file(target) {
        return file_response(file);
    }

    if !target.contains('.') {
        if let Some(file) = dir.get_file("index.html") {
            return file_response(file);
        }
    }

    StatusCode::NOT_FOUND.into_response()
}

fn file_response(file: &include_dir::File) -> Response {
    let mut response = Response::new(Body::from(file.contents().to_vec()));
    *response.status_mut() = StatusCode::OK;
    let content_type = content_type_for(file.path());
    let value = HeaderValue::from_static(content_type);
    response.headers_mut().insert(header::CONTENT_TYPE, value);
    response
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        Some("map") => "application/json",
        Some("txt") => "text/plain; charset=utf-8",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("eot") => "application/vnd.ms-fontobject",
        _ => "application/octet-stream",
    }
}
