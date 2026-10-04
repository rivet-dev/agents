use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::fs;
use std::io::Cursor;
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::Next;
use axum::response::sse::KeepAlive;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures::stream;
use futures::StreamExt;
use sandbox_agent_agent_management::agents::{
    AgentId, AgentManager, InstallOptions, InstallResult, InstallSource, InstalledArtifactKind,
};
use sandbox_agent_agent_management::credentials::{
    extract_all_credentials, CredentialExtractionOptions,
};
use sandbox_agent_error::{ErrorType, ProblemDetails, SandboxError};
use sandbox_agent_opencode_adapter::{build_opencode_router, OpenCodeAdapterConfig};
use sandbox_agent_opencode_server_manager::{OpenCodeServerManager, OpenCodeServerManagerConfig};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tar::Archive;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::trace::TraceLayer;
use tracing::Span;
use utoipa::{IntoParams, Modify, OpenApi, ToSchema};

use crate::acp_proxy_runtime::{AcpProxyRuntime, ProxyPostOutcome};
use crate::desktop_errors::DesktopProblem;
use crate::desktop_runtime::DesktopRuntime;
use crate::desktop_types::*;
use crate::process_runtime::{
    decode_input_bytes, ProcessLogFilter, ProcessLogFilterStream,
    ProcessOwner as RuntimeProcessOwner, ProcessRuntime, ProcessRuntimeConfig, ProcessSnapshot,
    ProcessStartSpec, ProcessStatus, ProcessStream, RunSpec,
};
use crate::ui;

mod support;
mod types;
use self::support::*;
pub use self::types::*;

const APPLICATION_JSON: &str = "application/json";
const TEXT_EVENT_STREAM: &str = "text/event-stream";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BrandingMode {
    #[default]
    SandboxAgent,
    Gigacode,
}

impl BrandingMode {
    pub fn product_name(&self) -> &'static str {
        match self {
            BrandingMode::SandboxAgent => "Sandbox Agent",
            BrandingMode::Gigacode => "Gigacode",
        }
    }

    pub fn docs_url(&self) -> &'static str {
        match self {
            BrandingMode::SandboxAgent => "https://sandboxagent.dev",
            BrandingMode::Gigacode => "https://gigacode.dev",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CachedAgentVersion {
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug)]
pub struct AppState {
    auth: AuthConfig,
    agent_manager: Arc<AgentManager>,
    acp_proxy: Arc<AcpProxyRuntime>,
    opencode_server_manager: Arc<OpenCodeServerManager>,
    process_runtime: Arc<ProcessRuntime>,
    desktop_runtime: Arc<DesktopRuntime>,
    pub(crate) branding: BrandingMode,
    version_cache: Mutex<HashMap<AgentId, CachedAgentVersion>>,
}

impl AppState {
    pub fn new(auth: AuthConfig, agent_manager: AgentManager) -> Self {
        Self::with_branding(auth, agent_manager, BrandingMode::SandboxAgent)
    }

    pub fn with_branding(
        auth: AuthConfig,
        agent_manager: AgentManager,
        branding: BrandingMode,
    ) -> Self {
        let agent_manager = Arc::new(agent_manager);
        let acp_proxy = Arc::new(AcpProxyRuntime::new(agent_manager.clone()));
        let opencode_server_manager = Arc::new(OpenCodeServerManager::new(
            agent_manager.clone(),
            OpenCodeServerManagerConfig {
                log_dir: default_opencode_server_log_dir(),
                auto_restart: true,
            },
        ));
        let process_runtime = Arc::new(ProcessRuntime::new());
        let desktop_runtime = Arc::new(DesktopRuntime::new(process_runtime.clone()));
        Self {
            auth,
            agent_manager,
            acp_proxy,
            opencode_server_manager,
            process_runtime,
            desktop_runtime,
            branding,
            version_cache: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn acp_proxy(&self) -> Arc<AcpProxyRuntime> {
        self.acp_proxy.clone()
    }

    pub(crate) fn agent_manager(&self) -> Arc<AgentManager> {
        self.agent_manager.clone()
    }

    pub(crate) fn opencode_server_manager(&self) -> Arc<OpenCodeServerManager> {
        self.opencode_server_manager.clone()
    }

    pub(crate) fn process_runtime(&self) -> Arc<ProcessRuntime> {
        self.process_runtime.clone()
    }

    pub(crate) fn desktop_runtime(&self) -> Arc<DesktopRuntime> {
        self.desktop_runtime.clone()
    }

    pub(crate) fn purge_version_cache(&self, agent: AgentId) {
        self.version_cache.lock().unwrap().remove(&agent);
    }
}

fn default_opencode_server_log_dir() -> PathBuf {
    let mut base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    base.push("sandbox-agent");
    base.push("agent-logs");
    base
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub token: Option<String>,
}

impl AuthConfig {
    pub fn disabled() -> Self {
        Self { token: None }
    }

    pub fn with_token(token: String) -> Self {
        Self { token: Some(token) }
    }
}

pub fn build_router(state: AppState) -> Router {
    build_router_with_state(Arc::new(state)).0
}

pub fn build_router_with_state(shared: Arc<AppState>) -> (Router, Arc<AppState>) {
    let mut v1_router = Router::new()
        .route("/health", get(get_v1_health))
        .route("/desktop/status", get(get_v1_desktop_status))
        .route("/desktop/start", post(post_v1_desktop_start))
        .route("/desktop/stop", post(post_v1_desktop_stop))
        .route("/desktop/screenshot", get(get_v1_desktop_screenshot))
        .route(
            "/desktop/screenshot/region",
            get(get_v1_desktop_screenshot_region),
        )
        .route(
            "/desktop/mouse/position",
            get(get_v1_desktop_mouse_position),
        )
        .route("/desktop/mouse/move", post(post_v1_desktop_mouse_move))
        .route("/desktop/mouse/click", post(post_v1_desktop_mouse_click))
        .route("/desktop/mouse/down", post(post_v1_desktop_mouse_down))
        .route("/desktop/mouse/up", post(post_v1_desktop_mouse_up))
        .route("/desktop/mouse/drag", post(post_v1_desktop_mouse_drag))
        .route("/desktop/mouse/scroll", post(post_v1_desktop_mouse_scroll))
        .route(
            "/desktop/keyboard/type",
            post(post_v1_desktop_keyboard_type),
        )
        .route(
            "/desktop/keyboard/press",
            post(post_v1_desktop_keyboard_press),
        )
        .route(
            "/desktop/keyboard/down",
            post(post_v1_desktop_keyboard_down),
        )
        .route("/desktop/keyboard/up", post(post_v1_desktop_keyboard_up))
        .route("/desktop/display/info", get(get_v1_desktop_display_info))
        .route("/desktop/windows", get(get_v1_desktop_windows))
        .route(
            "/desktop/windows/focused",
            get(get_v1_desktop_windows_focused),
        )
        .route(
            "/desktop/windows/:id/focus",
            post(post_v1_desktop_window_focus),
        )
        .route(
            "/desktop/windows/:id/move",
            post(post_v1_desktop_window_move),
        )
        .route(
            "/desktop/windows/:id/resize",
            post(post_v1_desktop_window_resize),
        )
        .route(
            "/desktop/clipboard",
            get(get_v1_desktop_clipboard).post(post_v1_desktop_clipboard),
        )
        .route("/desktop/launch", post(post_v1_desktop_launch))
        .route("/desktop/open", post(post_v1_desktop_open))
        .route(
            "/desktop/recording/start",
            post(post_v1_desktop_recording_start),
        )
        .route(
            "/desktop/recording/stop",
            post(post_v1_desktop_recording_stop),
        )
        .route("/desktop/recordings", get(get_v1_desktop_recordings))
        .route(
            "/desktop/recordings/:id",
            get(get_v1_desktop_recording).delete(delete_v1_desktop_recording),
        )
        .route(
            "/desktop/recordings/:id/download",
            get(get_v1_desktop_recording_download),
        )
        .route("/desktop/stream/start", post(post_v1_desktop_stream_start))
        .route("/desktop/stream/stop", post(post_v1_desktop_stream_stop))
        .route("/desktop/stream/status", get(get_v1_desktop_stream_status))
        .route("/desktop/stream/signaling", get(get_v1_desktop_stream_ws))
        .route("/agents", get(get_v1_agents))
        .route("/agents/:agent", get(get_v1_agent))
        .route("/agents/:agent/install", post(post_v1_agent_install))
        .route("/fs/entries", get(get_v1_fs_entries))
        .route("/fs/file", get(get_v1_fs_file).put(put_v1_fs_file))
        .route("/fs/entry", delete(delete_v1_fs_entry))
        .route("/fs/mkdir", post(post_v1_fs_mkdir))
        .route("/fs/move", post(post_v1_fs_move))
        .route("/fs/stat", get(get_v1_fs_stat))
        .route("/fs/upload-batch", post(post_v1_fs_upload_batch))
        .route(
            "/processes/config",
            get(get_v1_processes_config).post(post_v1_processes_config),
        )
        .route("/processes", get(get_v1_processes).post(post_v1_processes))
        .route("/processes/run", post(post_v1_processes_run))
        .route(
            "/processes/:id",
            get(get_v1_process).delete(delete_v1_process),
        )
        .route("/processes/:id/stop", post(post_v1_process_stop))
        .route("/processes/:id/kill", post(post_v1_process_kill))
        .route("/processes/:id/logs", get(get_v1_process_logs))
        .route("/processes/:id/input", post(post_v1_process_input))
        .route(
            "/processes/:id/terminal/resize",
            post(post_v1_process_terminal_resize),
        )
        .route(
            "/processes/:id/terminal/ws",
            get(get_v1_process_terminal_ws),
        )
        .route(
            "/config/mcp",
            get(get_v1_config_mcp)
                .put(put_v1_config_mcp)
                .delete(delete_v1_config_mcp),
        )
        .route(
            "/config/skills",
            get(get_v1_config_skills)
                .put(put_v1_config_skills)
                .delete(delete_v1_config_skills),
        )
        .route("/acp", get(get_v1_acp_servers))
        .route(
            "/acp/:server_id",
            post(post_v1_acp).get(get_v1_acp).delete(delete_v1_acp),
        )
        .with_state(shared.clone());

    if shared.auth.token.is_some() {
        v1_router = v1_router.layer(axum::middleware::from_fn_with_state(
            shared.clone(),
            require_token,
        ));
    }

    let opencode_router = build_opencode_router(OpenCodeAdapterConfig {
        auth_token: shared.auth.token.clone(),
        sqlite_path: std::env::var("OPENCODE_COMPAT_DB_PATH").ok(),
        native_proxy_base_url: std::env::var("OPENCODE_COMPAT_PROXY_URL").ok(),
        native_proxy_manager: Some(shared.opencode_server_manager()),
        acp_dispatch: Some(shared.acp_proxy() as Arc<dyn sandbox_agent_opencode_adapter::AcpDispatch>),
        provider_payload: Some(build_provider_payload_for_opencode(&shared)),
        ..OpenCodeAdapterConfig::default()
    })
    .unwrap_or_else(|err| {
        tracing::error!(error = %err, "failed to initialize opencode adapter router; using fallback");
        Router::new().fallback(opencode_unavailable)
    });

    let mut router = Router::new()
        .route("/", get(get_root))
        .nest("/v1", v1_router)
        .nest("/opencode", opencode_router)
        .fallback(not_found);

    router = router.merge(ui::router());

    let http_logging = match std::env::var("SANDBOX_AGENT_LOG_HTTP") {
        Ok(value) if value == "0" || value.eq_ignore_ascii_case("false") => false,
        _ => true,
    };

    if http_logging {
        let include_headers = std::env::var("SANDBOX_AGENT_LOG_HTTP_HEADERS").is_ok();
        let trace_layer = TraceLayer::new_for_http()
            .make_span_with(move |req: &Request<_>| {
                if include_headers {
                    let mut headers = Vec::new();
                    for (name, value) in req.headers().iter() {
                        let name_str = name.as_str();
                        let display_value = if name_str.eq_ignore_ascii_case("authorization") {
                            "<redacted>".to_string()
                        } else {
                            value.to_str().unwrap_or("<binary>").to_string()
                        };
                        headers.push((name_str.to_string(), display_value));
                    }
                    tracing::info_span!(
                        "http.request",
                        method = %req.method(),
                        uri = %req.uri(),
                        headers = ?headers
                    )
                } else {
                    tracing::info_span!(
                        "http.request",
                        method = %req.method(),
                        uri = %req.uri()
                    )
                }
            })
            .on_request(|_req: &Request<_>, span: &Span| {
                tracing::info!(parent: span, "request");
            })
            .on_response(|res: &Response<_>, latency: Duration, span: &Span| {
                tracing::info!(
                    parent: span,
                    status = %res.status(),
                    latency_ms = latency.as_millis()
                );
            });

        router = router.layer(trace_layer);
    }

    (router, shared)
}

async fn opencode_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "errors": [{"message": "/opencode is unavailable: adapter initialization failed"}]
        })),
    )
        .into_response()
}

pub async fn shutdown_servers(state: &Arc<AppState>) {
    state.acp_proxy().shutdown_all().await;
    state.opencode_server_manager().shutdown().await;
    state.desktop_runtime().shutdown().await;
}

#[derive(OpenApi)]
#[openapi(
    paths(
        get_v1_health,
        get_v1_desktop_status,
        post_v1_desktop_start,
        post_v1_desktop_stop,
        get_v1_desktop_screenshot,
        get_v1_desktop_screenshot_region,
        get_v1_desktop_mouse_position,
        post_v1_desktop_mouse_move,
        post_v1_desktop_mouse_click,
        post_v1_desktop_mouse_down,
        post_v1_desktop_mouse_up,
        post_v1_desktop_mouse_drag,
        post_v1_desktop_mouse_scroll,
        post_v1_desktop_keyboard_type,
        post_v1_desktop_keyboard_press,
        post_v1_desktop_keyboard_down,
        post_v1_desktop_keyboard_up,
        get_v1_desktop_display_info,
        get_v1_desktop_windows,
        get_v1_desktop_windows_focused,
        post_v1_desktop_window_focus,
        post_v1_desktop_window_move,
        post_v1_desktop_window_resize,
        get_v1_desktop_clipboard,
        post_v1_desktop_clipboard,
        post_v1_desktop_launch,
        post_v1_desktop_open,
        get_v1_desktop_stream_status,
        post_v1_desktop_recording_start,
        post_v1_desktop_recording_stop,
        get_v1_desktop_recordings,
        get_v1_desktop_recording,
        get_v1_desktop_recording_download,
        delete_v1_desktop_recording,
        post_v1_desktop_stream_start,
        post_v1_desktop_stream_stop,
        get_v1_desktop_stream_ws,
        get_v1_agents,
        get_v1_agent,
        post_v1_agent_install,
        get_v1_fs_entries,
        get_v1_fs_file,
        put_v1_fs_file,
        delete_v1_fs_entry,
        post_v1_fs_mkdir,
        post_v1_fs_move,
        get_v1_fs_stat,
        post_v1_fs_upload_batch,
        get_v1_processes_config,
        post_v1_processes_config,
        post_v1_processes,
        post_v1_processes_run,
        get_v1_processes,
        get_v1_process,
        post_v1_process_stop,
        post_v1_process_kill,
        delete_v1_process,
        get_v1_process_logs,
        post_v1_process_input,
        post_v1_process_terminal_resize,
        get_v1_process_terminal_ws,
        get_v1_config_mcp,
        put_v1_config_mcp,
        delete_v1_config_mcp,
        get_v1_config_skills,
        put_v1_config_skills,
        delete_v1_config_skills,
        get_v1_acp_servers,
        post_v1_acp,
        get_v1_acp,
        delete_v1_acp
    ),
    components(
        schemas(
            HealthResponse,
            DesktopState,
            DesktopResolution,
            DesktopErrorInfo,
            DesktopProcessInfo,
            DesktopStatusResponse,
            DesktopStartRequest,
            DesktopScreenshotQuery,
            DesktopScreenshotFormat,
            DesktopRegionScreenshotQuery,
            DesktopMousePositionResponse,
            DesktopMouseButton,
            DesktopMouseMoveRequest,
            DesktopMouseClickRequest,
            DesktopMouseDownRequest,
            DesktopMouseUpRequest,
            DesktopMouseDragRequest,
            DesktopMouseScrollRequest,
            DesktopKeyboardTypeRequest,
            DesktopKeyboardPressRequest,
            DesktopKeyModifiers,
            DesktopKeyboardDownRequest,
            DesktopKeyboardUpRequest,
            DesktopActionResponse,
            DesktopDisplayInfoResponse,
            DesktopWindowInfo,
            DesktopWindowListResponse,
            DesktopRecordingStartRequest,
            DesktopRecordingStatus,
            DesktopRecordingInfo,
            DesktopRecordingListResponse,
            DesktopStreamStatusResponse,
            DesktopClipboardResponse,
            DesktopClipboardQuery,
            DesktopClipboardWriteRequest,
            DesktopLaunchRequest,
            DesktopLaunchResponse,
            DesktopOpenRequest,
            DesktopOpenResponse,
            DesktopWindowMoveRequest,
            DesktopWindowResizeRequest,
            ServerStatus,
            ServerStatusInfo,
            AgentCapabilities,
            AgentInfo,
            AgentListResponse,
            AgentInstallRequest,
            AgentInstallArtifact,
            AgentInstallResponse,
            FsPathQuery,
            FsEntriesQuery,
            FsDeleteQuery,
            FsUploadBatchQuery,
            FsEntryType,
            FsEntry,
            FsStat,
            FsWriteResponse,
            FsMoveRequest,
            FsMoveResponse,
            FsActionResponse,
            FsUploadBatchResponse,
            ProcessConfig,
            ProcessOwner,
            ProcessCreateRequest,
            ProcessRunRequest,
            ProcessRunResponse,
            ProcessState,
            ProcessInfo,
            ProcessListResponse,
            ProcessListQuery,
            ProcessLogsStream,
            ProcessLogsQuery,
            ProcessLogEntry,
            ProcessLogsResponse,
            ProcessInputRequest,
            ProcessInputResponse,
            ProcessSignalQuery,
            ProcessTerminalResizeRequest,
            ProcessTerminalResizeResponse,
            AcpPostQuery,
            AcpServerInfo,
            AcpServerListResponse,
            McpConfigQuery,
            SkillsConfigQuery,
            McpServerConfig,
            SkillsConfig,
            SkillSource,
            ProblemDetails,
            ErrorType,
            AcpEnvelope
        )
    ),
    tags(
        (name = "v1", description = "ACP proxy v1 API")
    ),
    modifiers(&ServerAddon)
)]
pub struct ApiDoc;

struct ServerAddon;

impl Modify for ServerAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        openapi.servers = Some(vec![utoipa::openapi::Server::new("http://localhost:2468")]);
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error(transparent)]
    Sandbox(#[from] SandboxError),
    #[error("problem: {0:?}")]
    Problem(ProblemDetails),
}

impl From<ProblemDetails> for ApiError {
    fn from(value: ProblemDetails) -> Self {
        Self::Problem(value)
    }
}

impl From<DesktopProblem> for ApiError {
    fn from(value: DesktopProblem) -> Self {
        Self::Problem(value.to_problem_details())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let problem = match &self {
            ApiError::Sandbox(error) => problem_from_sandbox_error(error),
            ApiError::Problem(problem) => problem.clone(),
        };
        let status =
            StatusCode::from_u16(problem.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (
            status,
            [(header::CONTENT_TYPE, "application/problem+json")],
            Json(problem),
        )
            .into_response()
    }
}

async fn get_root() -> Json<Value> {
    Json(json!({
        "name": "Sandbox Agent",
        "docs": "https://sandboxagent.dev"
    }))
}

#[utoipa::path(
    get,
    path = "/v1/health",
    tag = "v1",
    responses(
        (status = 200, description = "Service health response", body = HealthResponse)
    )
)]
async fn get_v1_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

/// Get desktop runtime status.
///
/// Returns the current desktop runtime state, dependency status, active
/// display metadata, and supervised process information.
#[utoipa::path(
    get,
    path = "/v1/desktop/status",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop runtime status", body = DesktopStatusResponse),
        (status = 401, description = "Authentication required", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStatusResponse>, ApiError> {
    Ok(Json(state.desktop_runtime().status().await))
}

/// Start the private desktop runtime.
///
/// Lazily launches the managed Xvfb/openbox stack, validates display health,
/// and returns the resulting desktop status snapshot.
#[utoipa::path(
    post,
    path = "/v1/desktop/start",
    tag = "v1",
    request_body = DesktopStartRequest,
    responses(
        (status = 200, description = "Desktop runtime status after start", body = DesktopStatusResponse),
        (status = 400, description = "Invalid desktop start request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is already transitioning", body = ProblemDetails),
        (status = 501, description = "Desktop API unsupported on this platform", body = ProblemDetails),
        (status = 503, description = "Desktop runtime could not be started", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopStartRequest>,
) -> Result<Json<DesktopStatusResponse>, ApiError> {
    let status = state.desktop_runtime().start(body).await?;
    Ok(Json(status))
}

/// Stop the private desktop runtime.
///
/// Terminates the managed openbox/Xvfb/dbus processes owned by the desktop
/// runtime and returns the resulting status snapshot.
#[utoipa::path(
    post,
    path = "/v1/desktop/stop",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop runtime status after stop", body = DesktopStatusResponse),
        (status = 409, description = "Desktop runtime is already transitioning", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_stop(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStatusResponse>, ApiError> {
    let status = state.desktop_runtime().stop().await?;
    Ok(Json(status))
}

/// Capture a full desktop screenshot.
///
/// Performs a health-gated full-frame screenshot of the managed desktop and
/// returns the requested image bytes.
#[utoipa::path(
    get,
    path = "/v1/desktop/screenshot",
    tag = "v1",
    params(DesktopScreenshotQuery),
    responses(
        (status = 200, description = "Desktop screenshot as image bytes"),
        (status = 400, description = "Invalid screenshot query", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or screenshot capture failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_screenshot(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DesktopScreenshotQuery>,
) -> Result<Response, ApiError> {
    let screenshot = state.desktop_runtime().screenshot(query).await?;
    Ok((
        [(header::CONTENT_TYPE, screenshot.content_type)],
        Bytes::from(screenshot.bytes),
    )
        .into_response())
}

/// Capture a desktop screenshot region.
///
/// Performs a health-gated screenshot crop against the managed desktop and
/// returns the requested region image bytes.
#[utoipa::path(
    get,
    path = "/v1/desktop/screenshot/region",
    tag = "v1",
    params(DesktopRegionScreenshotQuery),
    responses(
        (status = 200, description = "Desktop screenshot region as image bytes"),
        (status = 400, description = "Invalid screenshot region", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or screenshot capture failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_screenshot_region(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DesktopRegionScreenshotQuery>,
) -> Result<Response, ApiError> {
    let screenshot = state.desktop_runtime().screenshot_region(query).await?;
    Ok((
        [(header::CONTENT_TYPE, screenshot.content_type)],
        Bytes::from(screenshot.bytes),
    )
        .into_response())
}

/// Get the current desktop mouse position.
///
/// Performs a health-gated mouse position query against the managed desktop.
#[utoipa::path(
    get,
    path = "/v1/desktop/mouse/position",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop mouse position", body = DesktopMousePositionResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input check failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_mouse_position(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().mouse_position().await?;
    Ok(Json(position))
}

/// Move the desktop mouse.
///
/// Performs a health-gated absolute pointer move on the managed desktop and
/// returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/move",
    tag = "v1",
    request_body = DesktopMouseMoveRequest,
    responses(
        (status = 200, description = "Desktop mouse position after move", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse move request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_move(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseMoveRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().move_mouse(body).await?;
    Ok(Json(position))
}

/// Click on the desktop.
///
/// Performs a health-gated pointer move and click against the managed desktop
/// and returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/click",
    tag = "v1",
    request_body = DesktopMouseClickRequest,
    responses(
        (status = 200, description = "Desktop mouse position after click", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse click request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_click(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseClickRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().click_mouse(body).await?;
    Ok(Json(position))
}

/// Press and hold a desktop mouse button.
///
/// Performs a health-gated optional pointer move followed by `xdotool mousedown`
/// and returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/down",
    tag = "v1",
    request_body = DesktopMouseDownRequest,
    responses(
        (status = 200, description = "Desktop mouse position after button press", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse down request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_down(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseDownRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().mouse_down(body).await?;
    Ok(Json(position))
}

/// Release a desktop mouse button.
///
/// Performs a health-gated optional pointer move followed by `xdotool mouseup`
/// and returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/up",
    tag = "v1",
    request_body = DesktopMouseUpRequest,
    responses(
        (status = 200, description = "Desktop mouse position after button release", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse up request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_up(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseUpRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().mouse_up(body).await?;
    Ok(Json(position))
}

/// Drag the desktop mouse.
///
/// Performs a health-gated drag gesture against the managed desktop and
/// returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/drag",
    tag = "v1",
    request_body = DesktopMouseDragRequest,
    responses(
        (status = 200, description = "Desktop mouse position after drag", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse drag request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_drag(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseDragRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().drag_mouse(body).await?;
    Ok(Json(position))
}

/// Scroll the desktop mouse wheel.
///
/// Performs a health-gated scroll gesture at the requested coordinates and
/// returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/scroll",
    tag = "v1",
    request_body = DesktopMouseScrollRequest,
    responses(
        (status = 200, description = "Desktop mouse position after scroll", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse scroll request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_scroll(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseScrollRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().scroll_mouse(body).await?;
    Ok(Json(position))
}

/// Type desktop keyboard text.
///
/// Performs a health-gated `xdotool type` operation against the managed
/// desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/keyboard/type",
    tag = "v1",
    request_body = DesktopKeyboardTypeRequest,
    responses(
        (status = 200, description = "Desktop keyboard action result", body = DesktopActionResponse),
        (status = 400, description = "Invalid keyboard type request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_keyboard_type(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopKeyboardTypeRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let response = state.desktop_runtime().type_text(body).await?;
    Ok(Json(response))
}

/// Press a desktop keyboard shortcut.
///
/// Performs a health-gated `xdotool key` operation against the managed
/// desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/keyboard/press",
    tag = "v1",
    request_body = DesktopKeyboardPressRequest,
    responses(
        (status = 200, description = "Desktop keyboard action result", body = DesktopActionResponse),
        (status = 400, description = "Invalid keyboard press request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_keyboard_press(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopKeyboardPressRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let response = state.desktop_runtime().press_key(body).await?;
    Ok(Json(response))
}

/// Press and hold a desktop keyboard key.
///
/// Performs a health-gated `xdotool keydown` operation against the managed
/// desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/keyboard/down",
    tag = "v1",
    request_body = DesktopKeyboardDownRequest,
    responses(
        (status = 200, description = "Desktop keyboard action result", body = DesktopActionResponse),
        (status = 400, description = "Invalid keyboard down request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_keyboard_down(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopKeyboardDownRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let response = state.desktop_runtime().key_down(body).await?;
    Ok(Json(response))
}

/// Release a desktop keyboard key.
///
/// Performs a health-gated `xdotool keyup` operation against the managed
/// desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/keyboard/up",
    tag = "v1",
    request_body = DesktopKeyboardUpRequest,
    responses(
        (status = 200, description = "Desktop keyboard action result", body = DesktopActionResponse),
        (status = 400, description = "Invalid keyboard up request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_keyboard_up(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopKeyboardUpRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let response = state.desktop_runtime().key_up(body).await?;
    Ok(Json(response))
}

/// Get desktop display information.
///
/// Performs a health-gated display query against the managed desktop and
/// returns the current display identifier and resolution.
#[utoipa::path(
    get,
    path = "/v1/desktop/display/info",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop display information", body = DesktopDisplayInfoResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 503, description = "Desktop runtime health or display query failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_display_info(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopDisplayInfoResponse>, ApiError> {
    let info = state.desktop_runtime().display_info().await?;
    Ok(Json(info))
}

/// List visible desktop windows.
///
/// Performs a health-gated visible-window enumeration against the managed
/// desktop and returns the current window metadata.
#[utoipa::path(
    get,
    path = "/v1/desktop/windows",
    tag = "v1",
    responses(
        (status = 200, description = "Visible desktop windows", body = DesktopWindowListResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 503, description = "Desktop runtime health or window query failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_windows(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopWindowListResponse>, ApiError> {
    let windows = state.desktop_runtime().list_windows().await?;
    Ok(Json(windows))
}

/// Get the currently focused desktop window.
///
/// Returns information about the window that currently has input focus.
#[utoipa::path(
    get,
    path = "/v1/desktop/windows/focused",
    tag = "v1",
    responses(
        (status = 200, description = "Focused window info", body = DesktopWindowInfo),
        (status = 404, description = "No window is focused", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_windows_focused(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopWindowInfo>, ApiError> {
    let window = state.desktop_runtime().focused_window().await?;
    Ok(Json(window))
}

/// Focus a desktop window.
///
/// Brings the specified window to the foreground and gives it input focus.
#[utoipa::path(
    post,
    path = "/v1/desktop/windows/{id}/focus",
    tag = "v1",
    params(
        ("id" = String, Path, description = "X11 window ID")
    ),
    responses(
        (status = 200, description = "Window info after focus", body = DesktopWindowInfo),
        (status = 404, description = "Window not found", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_window_focus(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<DesktopWindowInfo>, ApiError> {
    let window = state.desktop_runtime().focus_window(&id).await?;
    Ok(Json(window))
}

/// Move a desktop window.
///
/// Moves the specified window to the given position.
#[utoipa::path(
    post,
    path = "/v1/desktop/windows/{id}/move",
    tag = "v1",
    params(
        ("id" = String, Path, description = "X11 window ID")
    ),
    request_body = DesktopWindowMoveRequest,
    responses(
        (status = 200, description = "Window info after move", body = DesktopWindowInfo),
        (status = 404, description = "Window not found", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_window_move(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DesktopWindowMoveRequest>,
) -> Result<Json<DesktopWindowInfo>, ApiError> {
    let window = state.desktop_runtime().move_window(&id, body).await?;
    Ok(Json(window))
}

/// Resize a desktop window.
///
/// Resizes the specified window to the given dimensions.
#[utoipa::path(
    post,
    path = "/v1/desktop/windows/{id}/resize",
    tag = "v1",
    params(
        ("id" = String, Path, description = "X11 window ID")
    ),
    request_body = DesktopWindowResizeRequest,
    responses(
        (status = 200, description = "Window info after resize", body = DesktopWindowInfo),
        (status = 404, description = "Window not found", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_window_resize(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DesktopWindowResizeRequest>,
) -> Result<Json<DesktopWindowInfo>, ApiError> {
    let window = state.desktop_runtime().resize_window(&id, body).await?;
    Ok(Json(window))
}

/// Read the desktop clipboard.
///
/// Returns the current text content of the X11 clipboard.
#[utoipa::path(
    get,
    path = "/v1/desktop/clipboard",
    tag = "v1",
    params(DesktopClipboardQuery),
    responses(
        (status = 200, description = "Clipboard contents", body = DesktopClipboardResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 500, description = "Clipboard read failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_clipboard(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DesktopClipboardQuery>,
) -> Result<Json<DesktopClipboardResponse>, ApiError> {
    let clipboard = state
        .desktop_runtime()
        .get_clipboard(query.selection)
        .await?;
    Ok(Json(clipboard))
}

/// Write to the desktop clipboard.
///
/// Sets the text content of the X11 clipboard.
#[utoipa::path(
    post,
    path = "/v1/desktop/clipboard",
    tag = "v1",
    request_body = DesktopClipboardWriteRequest,
    responses(
        (status = 200, description = "Clipboard updated", body = DesktopActionResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 500, description = "Clipboard write failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_clipboard(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopClipboardWriteRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let result = state.desktop_runtime().set_clipboard(body).await?;
    Ok(Json(result))
}

/// Launch a desktop application.
///
/// Launches an application by name on the managed desktop, optionally waiting
/// for its window to appear.
#[utoipa::path(
    post,
    path = "/v1/desktop/launch",
    tag = "v1",
    request_body = DesktopLaunchRequest,
    responses(
        (status = 200, description = "Application launched", body = DesktopLaunchResponse),
        (status = 404, description = "Application not found", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_launch(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopLaunchRequest>,
) -> Result<Json<DesktopLaunchResponse>, ApiError> {
    let result = state.desktop_runtime().launch_app(body).await?;
    Ok(Json(result))
}

/// Open a file or URL with the default handler.
///
/// Opens a file path or URL using xdg-open on the managed desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/open",
    tag = "v1",
    request_body = DesktopOpenRequest,
    responses(
        (status = 200, description = "Target opened", body = DesktopOpenResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_open(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopOpenRequest>,
) -> Result<Json<DesktopOpenResponse>, ApiError> {
    let result = state.desktop_runtime().open_target(body).await?;
    Ok(Json(result))
}

/// Start desktop recording.
///
/// Starts an ffmpeg x11grab recording against the managed desktop and returns
/// the created recording metadata.
#[utoipa::path(
    post,
    path = "/v1/desktop/recording/start",
    tag = "v1",
    request_body = DesktopRecordingStartRequest,
    responses(
        (status = 200, description = "Desktop recording started", body = DesktopRecordingInfo),
        (status = 409, description = "Desktop runtime is not ready or a recording is already active", body = ProblemDetails),
        (status = 502, description = "Desktop recording failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_recording_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopRecordingStartRequest>,
) -> Result<Json<DesktopRecordingInfo>, ApiError> {
    let recording = state.desktop_runtime().start_recording(body).await?;
    Ok(Json(recording))
}

/// Stop desktop recording.
///
/// Stops the active desktop recording and returns the finalized recording
/// metadata.
#[utoipa::path(
    post,
    path = "/v1/desktop/recording/stop",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop recording stopped", body = DesktopRecordingInfo),
        (status = 409, description = "No active desktop recording", body = ProblemDetails),
        (status = 502, description = "Desktop recording stop failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_recording_stop(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopRecordingInfo>, ApiError> {
    let recording = state.desktop_runtime().stop_recording().await?;
    Ok(Json(recording))
}

/// List desktop recordings.
///
/// Returns the current desktop recording catalog.
#[utoipa::path(
    get,
    path = "/v1/desktop/recordings",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop recordings", body = DesktopRecordingListResponse),
        (status = 502, description = "Desktop recordings query failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_recordings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopRecordingListResponse>, ApiError> {
    let recordings = state.desktop_runtime().list_recordings().await?;
    Ok(Json(recordings))
}

/// Get desktop recording metadata.
///
/// Returns metadata for a single desktop recording.
#[utoipa::path(
    get,
    path = "/v1/desktop/recordings/{id}",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Desktop recording ID")
    ),
    responses(
        (status = 200, description = "Desktop recording metadata", body = DesktopRecordingInfo),
        (status = 404, description = "Unknown desktop recording", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_recording(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<DesktopRecordingInfo>, ApiError> {
    let recording = state.desktop_runtime().get_recording(&id).await?;
    Ok(Json(recording))
}

/// Download a desktop recording.
///
/// Serves the recorded MP4 bytes for a completed desktop recording.
#[utoipa::path(
    get,
    path = "/v1/desktop/recordings/{id}/download",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Desktop recording ID")
    ),
    responses(
        (status = 200, description = "Desktop recording as MP4 bytes"),
        (status = 404, description = "Unknown desktop recording", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_recording_download(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let path = state.desktop_runtime().recording_download_path(&id).await?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| SandboxError::StreamError {
            message: format!("failed to read desktop recording {}: {err}", path.display()),
        })?;
    Ok(([(header::CONTENT_TYPE, "video/mp4")], Bytes::from(bytes)).into_response())
}

/// Delete a desktop recording.
///
/// Removes a completed desktop recording and its file from disk.
#[utoipa::path(
    delete,
    path = "/v1/desktop/recordings/{id}",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Desktop recording ID")
    ),
    responses(
        (status = 204, description = "Desktop recording deleted"),
        (status = 404, description = "Unknown desktop recording", body = ProblemDetails),
        (status = 409, description = "Desktop recording is still active", body = ProblemDetails)
    )
)]
async fn delete_v1_desktop_recording(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.desktop_runtime().delete_recording(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Start desktop streaming.
///
/// Enables desktop websocket streaming for the managed desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/stream/start",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop streaming started", body = DesktopStreamStatusResponse)
    )
)]
async fn post_v1_desktop_stream_start(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStreamStatusResponse>, ApiError> {
    Ok(Json(state.desktop_runtime().start_streaming().await?))
}

/// Stop desktop streaming.
///
/// Disables desktop websocket streaming for the managed desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/stream/stop",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop streaming stopped", body = DesktopStreamStatusResponse)
    )
)]
async fn post_v1_desktop_stream_stop(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStreamStatusResponse>, ApiError> {
    Ok(Json(state.desktop_runtime().stop_streaming().await))
}

/// Get desktop stream status.
///
/// Returns the current state of the desktop WebRTC streaming session.
#[utoipa::path(
    get,
    path = "/v1/desktop/stream/status",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop stream status", body = DesktopStreamStatusResponse)
    )
)]
async fn get_v1_desktop_stream_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStreamStatusResponse>, ApiError> {
    Ok(Json(state.desktop_runtime().stream_status().await))
}

/// Open a desktop WebRTC signaling session.
///
/// Upgrades the connection to a WebSocket used for WebRTC signaling between
/// the browser client and the desktop streaming process. Also accepts mouse
/// and keyboard input frames as a fallback transport.
#[utoipa::path(
    get,
    path = "/v1/desktop/stream/signaling",
    tag = "v1",
    params(
        ("access_token" = Option<String>, Query, description = "Bearer token alternative for WS auth")
    ),
    responses(
        (status = 101, description = "WebSocket upgraded"),
        (status = 409, description = "Desktop runtime or streaming session is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop stream failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_stream_ws(
    State(state): State<Arc<AppState>>,
    Query(_query): Query<ProcessWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    state.desktop_runtime().ensure_streaming_active().await?;
    Ok(ws
        .on_upgrade(move |socket| desktop_stream_ws_session(socket, state.desktop_runtime()))
        .into_response())
}

#[utoipa::path(
    get,
    path = "/v1/agents",
    tag = "v1",
    params(
        ("config" = Option<bool>, Query, description = "When true, include version/path/configOptions (slower)"),
        ("no_cache" = Option<bool>, Query, description = "When true, bypass version cache")
    ),
    responses(
        (status = 200, description = "List of v1 agents", body = AgentListResponse),
        (status = 401, description = "Authentication required", body = ProblemDetails)
    )
)]
async fn get_v1_agents(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AgentsQuery>,
) -> Result<Json<AgentListResponse>, ApiError> {
    let credentials = tokio::task::spawn_blocking(move || {
        extract_all_credentials(&CredentialExtractionOptions::new())
    })
    .await
    .map_err(|err| SandboxError::StreamError {
        message: format!("failed to resolve credentials: {err}"),
    })?;

    let has_anthropic = credentials.anthropic.is_some();
    let has_openai = credentials.openai.is_some();

    let instances = state.acp_proxy().list_instances().await;
    let mut active_by_agent = HashMap::<AgentId, Vec<i64>>::new();
    for instance in instances {
        active_by_agent
            .entry(instance.agent)
            .or_default()
            .push(instance.created_at_ms);
    }

    let load_config = query.config.unwrap_or(false);
    let no_cache = query.no_cache.unwrap_or(false);

    let mut agents = Vec::new();
    for agent_id in AgentId::all().iter().copied() {
        let capabilities = agent_capabilities_for(agent_id);
        let installed = state.agent_manager().is_installed(agent_id);
        let credentials_available = credentials_available_for(agent_id, has_anthropic, has_openai);

        let server_status = active_by_agent.get(&agent_id).map(|created_times| {
            let uptime_ms = created_times
                .iter()
                .min()
                .map(|created| now_ms().saturating_sub(*created) as u64);
            ServerStatusInfo {
                status: if created_times.is_empty() {
                    ServerStatus::Stopped
                } else {
                    ServerStatus::Running
                },
                uptime_ms,
            }
        });

        agents.push(AgentInfo {
            id: agent_id.as_str().to_string(),
            installed,
            credentials_available,
            version: None,
            path: None,
            capabilities,
            server_status,
            config_options: None,
            config_error: None,
        });
    }

    if load_config {
        // Resolve versions/paths (slow — subprocess calls) with caching.
        // Collect agents that need a fresh lookup.
        let need_lookup: Vec<(usize, AgentId)> = agents
            .iter()
            .enumerate()
            .filter_map(|(idx, agent)| {
                let agent_id = AgentId::parse(&agent.id)?;
                if !no_cache {
                    if state.version_cache.lock().unwrap().contains_key(&agent_id) {
                        return None;
                    }
                }
                Some((idx, agent_id))
            })
            .collect();

        if !need_lookup.is_empty() {
            let mgr = state.agent_manager();
            let ids: Vec<AgentId> = need_lookup.iter().map(|(_, id)| *id).collect();
            let results = tokio::task::spawn_blocking(move || {
                ids.iter()
                    .map(|agent_id| {
                        let version = mgr.version(*agent_id).ok().flatten();
                        let path = mgr
                            .resolve_binary(*agent_id)
                            .ok()
                            .map(|p| p.to_string_lossy().to_string());
                        (*agent_id, CachedAgentVersion { version, path })
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .unwrap_or_default();

            let mut cache = state.version_cache.lock().unwrap();
            for (agent_id, entry) in results {
                cache.insert(agent_id, entry);
            }
        }

        // Apply cached version/path + hardcoded config options
        let cache = state.version_cache.lock().unwrap();
        for agent in &mut agents {
            let Some(agent_id) = AgentId::parse(&agent.id) else {
                continue;
            };
            if let Some(cached) = cache.get(&agent_id) {
                agent.version = cached.version.clone();
                agent.path = cached.path.clone();
            }
            let fallback = fallback_config_options(agent_id);
            if !fallback.is_empty() {
                agent.config_options = Some(fallback);
            }
        }
    }

    Ok(Json(AgentListResponse { agents }))
}

#[utoipa::path(
    get,
    path = "/v1/agents/{agent}",
    tag = "v1",
    params(
        ("agent" = String, Path, description = "Agent id"),
        ("config" = Option<bool>, Query, description = "When true, include version/path/configOptions (slower)"),
        ("no_cache" = Option<bool>, Query, description = "When true, bypass version cache")
    ),
    responses(
        (status = 200, description = "Agent info", body = AgentInfo),
        (status = 400, description = "Unknown agent", body = ProblemDetails),
        (status = 401, description = "Authentication required", body = ProblemDetails)
    )
)]
async fn get_v1_agent(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
    Query(query): Query<AgentsQuery>,
) -> Result<Json<AgentInfo>, ApiError> {
    let agent_id = AgentId::parse(&agent).ok_or_else(|| SandboxError::UnsupportedAgent {
        agent: agent.clone(),
    })?;

    let credentials = tokio::task::spawn_blocking(move || {
        extract_all_credentials(&CredentialExtractionOptions::new())
    })
    .await
    .map_err(|err| SandboxError::StreamError {
        message: format!("failed to resolve credentials: {err}"),
    })?;

    let has_anthropic = credentials.anthropic.is_some();
    let has_openai = credentials.openai.is_some();

    let instances = state.acp_proxy().list_instances().await;
    let created_times: Vec<i64> = instances
        .iter()
        .filter(|i| i.agent == agent_id)
        .map(|i| i.created_at_ms)
        .collect();

    let capabilities = agent_capabilities_for(agent_id);
    let installed = state.agent_manager().is_installed(agent_id);
    let credentials_available = credentials_available_for(agent_id, has_anthropic, has_openai);

    let server_status = if created_times.is_empty() {
        None
    } else {
        let uptime_ms = created_times
            .iter()
            .min()
            .map(|created| now_ms().saturating_sub(*created) as u64);
        Some(ServerStatusInfo {
            status: ServerStatus::Running,
            uptime_ms,
        })
    };

    let mut info = AgentInfo {
        id: agent_id.as_str().to_string(),
        installed,
        credentials_available,
        version: None,
        path: None,
        capabilities,
        server_status,
        config_options: None,
        config_error: None,
    };

    if query.config.unwrap_or(false) {
        let no_cache = query.no_cache.unwrap_or(false);

        // Version/path (cached, slow — subprocess calls)
        let cached = if !no_cache {
            state.version_cache.lock().unwrap().get(&agent_id).cloned()
        } else {
            None
        };
        if let Some(cached) = cached {
            info.version = cached.version;
            info.path = cached.path;
        } else {
            let mgr = state.agent_manager();
            let aid = agent_id;
            let result = tokio::task::spawn_blocking(move || {
                let version = mgr.version(aid).ok().flatten();
                let path = mgr
                    .resolve_binary(aid)
                    .ok()
                    .map(|p| p.to_string_lossy().to_string());
                CachedAgentVersion { version, path }
            })
            .await
            .unwrap_or(CachedAgentVersion {
                version: None,
                path: None,
            });
            info.version = result.version.clone();
            info.path = result.path.clone();
            state.version_cache.lock().unwrap().insert(agent_id, result);
        }

        // Hardcoded config options
        let fallback = fallback_config_options(agent_id);
        if !fallback.is_empty() {
            info.config_options = Some(fallback);
        }
    }

    Ok(Json(info))
}

// TODO: Re-enable ACP config probing once agent processes reliably return
// configOptions from session/new. Currently all agents return empty configOptions,
// so we use hardcoded fallbacks in fallback_config_options() instead.
//
// const CONFIG_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
//
// async fn probe_agent_config(
//     proxy: &Arc<AcpProxyRuntime>,
//     agent_id: &str,
// ) -> Result<Vec<Value>, String> {
//     let probe_id = PROBE_COUNTER.fetch_add(1, Ordering::Relaxed);
//     let server_id = format!("_config_probe_{}_{}", agent_id, probe_id);
//
//     let agent = AgentId::parse(agent_id).ok_or_else(|| format!("unknown agent: {agent_id}"))?;
//
//     let result = tokio::time::timeout(CONFIG_PROBE_TIMEOUT, async {
//         let init_payload = json!({
//             "jsonrpc": "2.0",
//             "id": 1,
//             "method": "initialize",
//             "params": {
//                 "protocolVersion": 1,
//                 "clientCapabilities": {},
//                 "clientInfo": { "name": "sandbox-agent", "version": "1.0.0" }
//             }
//         });
//         proxy
//             .post(&server_id, Some(agent), init_payload)
//             .await
//             .map_err(|e| format!("initialize failed: {e}"))?;
//
//         let session_payload = json!({
//             "jsonrpc": "2.0",
//             "id": 2,
//             "method": "session/new",
//             "params": {
//                 "cwd": "/",
//                 "_meta": { "sandboxagent.dev": { "agent": agent_id } }
//             }
//         });
//         let outcome = proxy
//             .post(&server_id, None, session_payload)
//             .await
//             .map_err(|e| format!("session/new failed: {e}"))?;
//
//         let config_options = match outcome {
//             ProxyPostOutcome::Response(value) => value
//                 .pointer("/result/configOptions")
//                 .cloned()
//                 .and_then(|v| serde_json::from_value::<Vec<Value>>(v).ok())
//                 .unwrap_or_default(),
//             ProxyPostOutcome::Accepted => Vec::new(),
//         };
//
//         Ok::<Vec<Value>, String>(config_options)
//     })
//     .await;
//
//     let _ = tokio::time::timeout(Duration::from_secs(5), proxy.delete(&server_id)).await;
//
//     match result {
//         Ok(inner) => inner,
//         Err(_) => Err("config probe timed out".to_string()),
//     }
// }

#[utoipa::path(
    post,
    path = "/v1/agents/{agent}/install",
    tag = "v1",
    params(
        ("agent" = String, Path, description = "Agent id")
    ),
    request_body = AgentInstallRequest,
    responses(
        (status = 200, description = "Agent install result", body = AgentInstallResponse),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 500, description = "Install failed", body = ProblemDetails)
    )
)]
async fn post_v1_agent_install(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
    Json(request): Json<AgentInstallRequest>,
) -> Result<Json<AgentInstallResponse>, ApiError> {
    let agent_id = AgentId::parse(&agent).ok_or_else(|| SandboxError::UnsupportedAgent {
        agent: agent.clone(),
    })?;

    let manager = state.agent_manager();
    let reinstall = request.reinstall.unwrap_or(false);
    let install_result = tokio::task::spawn_blocking(move || {
        manager.install(
            agent_id,
            InstallOptions {
                reinstall,
                version: request.agent_version,
                agent_process_version: request.agent_process_version,
            },
        )
    })
    .await
    .map_err(|err| SandboxError::InstallFailed {
        agent,
        stderr: Some(format!("installer task failed: {err}")),
    })?
    .map_err(|err| SandboxError::InstallFailed {
        agent: agent_id.as_str().to_string(),
        stderr: Some(err.to_string()),
    })?;

    // Purge version cache so next ?config=true picks up the new version
    state.purge_version_cache(agent_id);

    Ok(Json(map_install_result(install_result)))
}

#[utoipa::path(
    get,
    path = "/v1/fs/entries",
    tag = "v1",
    params(
        ("path" = Option<String>, Query, description = "Directory path")
    ),
    responses(
        (status = 200, description = "Directory entries", body = Vec<FsEntry>)
    )
)]
async fn get_v1_fs_entries(
    Query(query): Query<FsEntriesQuery>,
) -> Result<Json<Vec<FsEntry>>, ApiError> {
    let path = query.path.unwrap_or_else(|| ".".to_string());
    let target = resolve_fs_path(&path)?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if !metadata.is_dir() {
        return Err(SandboxError::InvalidRequest {
            message: format!("path is not a directory: {}", target.display()),
        }
        .into());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&target).map_err(|err| map_fs_error(&target, err))? {
        let entry = entry.map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        let entry_type = if metadata.is_dir() {
            FsEntryType::Directory
        } else {
            FsEntryType::File
        };
        let modified = metadata
            .modified()
            .ok()
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
        entries.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            entry_type,
            size: metadata.len(),
            modified,
        });
    }
    Ok(Json(entries))
}

#[utoipa::path(
    get,
    path = "/v1/fs/file",
    tag = "v1",
    params(
        ("path" = String, Query, description = "File path")
    ),
    responses(
        (status = 200, description = "File content")
    )
)]
async fn get_v1_fs_file(Query(query): Query<FsPathQuery>) -> Result<Response, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if !metadata.is_file() {
        return Err(SandboxError::InvalidRequest {
            message: format!("path is not a file: {}", target.display()),
        }
        .into());
    }
    let bytes = fs::read(&target).map_err(|err| map_fs_error(&target, err))?;
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Bytes::from(bytes),
    )
        .into_response())
}

#[utoipa::path(
    put,
    path = "/v1/fs/file",
    tag = "v1",
    params(
        ("path" = String, Query, description = "File path")
    ),
    request_body(content = String, description = "Raw file bytes"),
    responses(
        (status = 200, description = "Write result", body = FsWriteResponse)
    )
)]
async fn put_v1_fs_file(
    Query(query): Query<FsPathQuery>,
    body: Bytes,
) -> Result<Json<FsWriteResponse>, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
    }
    fs::write(&target, &body).map_err(|err| map_fs_error(&target, err))?;
    Ok(Json(FsWriteResponse {
        path: target.to_string_lossy().to_string(),
        bytes_written: body.len() as u64,
    }))
}

#[utoipa::path(
    delete,
    path = "/v1/fs/entry",
    tag = "v1",
    params(
        ("path" = String, Query, description = "File or directory path"),
        ("recursive" = Option<bool>, Query, description = "Delete directory recursively")
    ),
    responses(
        (status = 200, description = "Delete result", body = FsActionResponse)
    )
)]
async fn delete_v1_fs_entry(
    Query(query): Query<FsDeleteQuery>,
) -> Result<Json<FsActionResponse>, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if metadata.is_dir() {
        if query.recursive.unwrap_or(false) {
            fs::remove_dir_all(&target).map_err(|err| map_fs_error(&target, err))?;
        } else {
            fs::remove_dir(&target).map_err(|err| map_fs_error(&target, err))?;
        }
    } else {
        fs::remove_file(&target).map_err(|err| map_fs_error(&target, err))?;
    }
    Ok(Json(FsActionResponse {
        path: target.to_string_lossy().to_string(),
    }))
}

#[utoipa::path(
    post,
    path = "/v1/fs/mkdir",
    tag = "v1",
    params(
        ("path" = String, Query, description = "Directory path")
    ),
    responses(
        (status = 200, description = "Directory created", body = FsActionResponse)
    )
)]
async fn post_v1_fs_mkdir(
    Query(query): Query<FsPathQuery>,
) -> Result<Json<FsActionResponse>, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    fs::create_dir_all(&target).map_err(|err| map_fs_error(&target, err))?;
    Ok(Json(FsActionResponse {
        path: target.to_string_lossy().to_string(),
    }))
}

#[utoipa::path(
    post,
    path = "/v1/fs/move",
    tag = "v1",
    request_body = FsMoveRequest,
    responses(
        (status = 200, description = "Move result", body = FsMoveResponse)
    )
)]
async fn post_v1_fs_move(
    Json(request): Json<FsMoveRequest>,
) -> Result<Json<FsMoveResponse>, ApiError> {
    let from = resolve_fs_path(&request.from)?;
    let to = resolve_fs_path(&request.to)?;

    if to.exists() {
        if request.overwrite.unwrap_or(false) {
            let metadata = fs::metadata(&to).map_err(|err| map_fs_error(&to, err))?;
            if metadata.is_dir() {
                fs::remove_dir_all(&to).map_err(|err| map_fs_error(&to, err))?;
            } else {
                fs::remove_file(&to).map_err(|err| map_fs_error(&to, err))?;
            }
        } else {
            return Err(SandboxError::InvalidRequest {
                message: format!("destination already exists: {}", to.display()),
            }
            .into());
        }
    }

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
    }
    fs::rename(&from, &to).map_err(|err| map_fs_error(&from, err))?;
    Ok(Json(FsMoveResponse {
        from: from.to_string_lossy().to_string(),
        to: to.to_string_lossy().to_string(),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/fs/stat",
    tag = "v1",
    params(
        ("path" = String, Query, description = "Path to stat")
    ),
    responses(
        (status = 200, description = "Path metadata", body = FsStat)
    )
)]
async fn get_v1_fs_stat(Query(query): Query<FsPathQuery>) -> Result<Json<FsStat>, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    let entry_type = if metadata.is_dir() {
        FsEntryType::Directory
    } else {
        FsEntryType::File
    };
    let modified = metadata
        .modified()
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
    Ok(Json(FsStat {
        path: target.to_string_lossy().to_string(),
        entry_type,
        size: metadata.len(),
        modified,
    }))
}

#[utoipa::path(
    post,
    path = "/v1/fs/upload-batch",
    tag = "v1",
    params(
        ("path" = Option<String>, Query, description = "Destination path")
    ),
    request_body(content = String, description = "tar archive body"),
    responses(
        (status = 200, description = "Upload/extract result", body = FsUploadBatchResponse)
    )
)]
async fn post_v1_fs_upload_batch(
    headers: HeaderMap,
    Query(query): Query<FsUploadBatchQuery>,
    body: Bytes,
) -> Result<Json<FsUploadBatchResponse>, ApiError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.starts_with("application/x-tar") {
        return Err(SandboxError::InvalidRequest {
            message: "content-type must be application/x-tar".to_string(),
        }
        .into());
    }

    let path = query.path.unwrap_or_else(|| ".".to_string());
    let base = resolve_fs_path(&path)?;
    fs::create_dir_all(&base).map_err(|err| map_fs_error(&base, err))?;

    let mut archive = Archive::new(Cursor::new(body));
    let mut extracted = Vec::new();
    let mut truncated = false;

    for entry in archive.entries().map_err(|err| SandboxError::StreamError {
        message: err.to_string(),
    })? {
        let mut entry = entry.map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        let entry_path = entry.path().map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        let clean_path = sanitize_relative_path(&entry_path)?;
        if clean_path.as_os_str().is_empty() {
            continue;
        }
        let dest = base.join(&clean_path);
        if !dest.starts_with(&base) {
            return Err(SandboxError::InvalidRequest {
                message: format!("tar entry escapes destination: {}", entry_path.display()),
            }
            .into());
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
        }
        entry
            .unpack(&dest)
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
        if extracted.len() < 1024 {
            extracted.push(dest.to_string_lossy().to_string());
        } else {
            truncated = true;
        }
    }

    Ok(Json(FsUploadBatchResponse {
        paths: extracted,
        truncated,
    }))
}

/// Get process runtime configuration.
///
/// Returns the current runtime configuration for the process management API,
/// including limits for concurrency, timeouts, and buffer sizes.
#[utoipa::path(
    get,
    path = "/v1/processes/config",
    tag = "v1",
    responses(
        (status = 200, description = "Current runtime process config", body = ProcessConfig),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_processes_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ProcessConfig>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let config = state.process_runtime().get_config().await;
    Ok(Json(map_process_config(config)))
}

/// Update process runtime configuration.
///
/// Replaces the runtime configuration for the process management API.
/// Validates that all values are non-zero and clamps default timeout to max.
#[utoipa::path(
    post,
    path = "/v1/processes/config",
    tag = "v1",
    request_body = ProcessConfig,
    responses(
        (status = 200, description = "Updated runtime process config", body = ProcessConfig),
        (status = 400, description = "Invalid config", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_processes_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProcessConfig>,
) -> Result<Json<ProcessConfig>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    let updated = runtime
        .set_config(into_runtime_process_config(body))
        .await?;
    Ok(Json(map_process_config(updated)))
}

/// Create a long-lived managed process.
///
/// Spawns a new process with the given command and arguments. Supports both
/// pipe-based and PTY (tty) modes. Returns the process descriptor on success.
#[utoipa::path(
    post,
    path = "/v1/processes",
    tag = "v1",
    request_body = ProcessCreateRequest,
    responses(
        (status = 200, description = "Started process", body = ProcessInfo),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 409, description = "Process limit or state conflict", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_processes(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProcessCreateRequest>,
) -> Result<Json<ProcessInfo>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    let snapshot = runtime
        .start_process(ProcessStartSpec {
            command: body.command,
            args: body.args,
            cwd: body.cwd,
            env: body.env.into_iter().collect(),
            tty: body.tty,
            interactive: body.interactive,
            owner: RuntimeProcessOwner::User,
            restart_policy: None,
        })
        .await?;

    Ok(Json(map_process_snapshot(snapshot)))
}

/// Run a one-shot command.
///
/// Executes a command to completion and returns its stdout, stderr, exit code,
/// and duration. Supports configurable timeout and output size limits.
#[utoipa::path(
    post,
    path = "/v1/processes/run",
    tag = "v1",
    request_body = ProcessRunRequest,
    responses(
        (status = 200, description = "One-off command result", body = ProcessRunResponse),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_processes_run(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProcessRunRequest>,
) -> Result<Json<ProcessRunResponse>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    let output = runtime
        .run_once(RunSpec {
            command: body.command,
            args: body.args,
            cwd: body.cwd,
            env: body.env.into_iter().collect(),
            timeout_ms: body.timeout_ms,
            max_output_bytes: body.max_output_bytes,
        })
        .await?;

    Ok(Json(ProcessRunResponse {
        exit_code: output.exit_code,
        timed_out: output.timed_out,
        stdout: output.stdout,
        stderr: output.stderr,
        stdout_truncated: output.stdout_truncated,
        stderr_truncated: output.stderr_truncated,
        duration_ms: output.duration_ms,
    }))
}

/// List all managed processes.
///
/// Returns a list of all processes (running and exited) currently tracked
/// by the runtime, sorted by process ID.
#[utoipa::path(
    get,
    path = "/v1/processes",
    tag = "v1",
    params(ProcessListQuery),
    responses(
        (status = 200, description = "List processes", body = ProcessListResponse),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_processes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProcessListQuery>,
) -> Result<Json<ProcessListResponse>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let snapshots = state
        .process_runtime()
        .list_processes(query.owner.map(into_runtime_process_owner))
        .await;
    Ok(Json(ProcessListResponse {
        processes: snapshots.into_iter().map(map_process_snapshot).collect(),
    }))
}

/// Get a single process by ID.
///
/// Returns the current state of a managed process including its status,
/// PID, exit code, and creation/exit timestamps.
#[utoipa::path(
    get,
    path = "/v1/processes/{id}",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID")
    ),
    responses(
        (status = 200, description = "Process details", body = ProcessInfo),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_process(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ProcessInfo>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let snapshot = state.process_runtime().snapshot(&id).await?;
    Ok(Json(map_process_snapshot(snapshot)))
}

/// Send SIGTERM to a process.
///
/// Sends SIGTERM to the process and optionally waits up to `waitMs`
/// milliseconds for the process to exit before returning.
#[utoipa::path(
    post,
    path = "/v1/processes/{id}/stop",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID"),
        ("waitMs" = Option<u64>, Query, description = "Wait up to N ms for process to exit")
    ),
    responses(
        (status = 200, description = "Stop signal sent", body = ProcessInfo),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_process_stop(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ProcessSignalQuery>,
) -> Result<Json<ProcessInfo>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let snapshot = state
        .process_runtime()
        .stop_process(&id, query.wait_ms)
        .await?;
    Ok(Json(map_process_snapshot(snapshot)))
}

/// Send SIGKILL to a process.
///
/// Sends SIGKILL to the process and optionally waits up to `waitMs`
/// milliseconds for the process to exit before returning.
#[utoipa::path(
    post,
    path = "/v1/processes/{id}/kill",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID"),
        ("waitMs" = Option<u64>, Query, description = "Wait up to N ms for process to exit")
    ),
    responses(
        (status = 200, description = "Kill signal sent", body = ProcessInfo),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_process_kill(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ProcessSignalQuery>,
) -> Result<Json<ProcessInfo>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let snapshot = state
        .process_runtime()
        .kill_process(&id, query.wait_ms)
        .await?;
    Ok(Json(map_process_snapshot(snapshot)))
}

/// Delete a process record.
///
/// Removes a stopped process from the runtime. Returns 409 if the process
/// is still running; stop or kill it first.
#[utoipa::path(
    delete,
    path = "/v1/processes/{id}",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID")
    ),
    responses(
        (status = 204, description = "Process deleted"),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 409, description = "Process is still running", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn delete_v1_process(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    state.process_runtime().delete_process(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Fetch process logs.
///
/// Returns buffered log entries for a process. Supports filtering by stream
/// type, tail count, and sequence-based resumption. When `follow=true`,
/// returns an SSE stream that replays buffered entries then streams live output.
#[utoipa::path(
    get,
    path = "/v1/processes/{id}/logs",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID"),
        ("stream" = Option<ProcessLogsStream>, Query, description = "stdout|stderr|combined|pty"),
        ("tail" = Option<usize>, Query, description = "Tail N entries"),
        ("follow" = Option<bool>, Query, description = "Follow via SSE"),
        ("since" = Option<u64>, Query, description = "Only entries with sequence greater than this")
    ),
    responses(
        (status = 200, description = "Process logs", body = ProcessLogsResponse),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_process_logs(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ProcessLogsQuery>,
) -> Result<Response, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    let default_stream = if runtime.is_tty(&id).await? {
        ProcessLogsStream::Pty
    } else {
        ProcessLogsStream::Combined
    };
    let requested_stream = query.stream.unwrap_or(default_stream);
    let since = match (query.since, parse_last_event_id(&headers)?) {
        (Some(query_since), Some(last_event_id)) => Some(query_since.max(last_event_id)),
        (Some(query_since), None) => Some(query_since),
        (None, Some(last_event_id)) => Some(last_event_id),
        (None, None) => None,
    };
    let filter = ProcessLogFilter {
        stream: into_runtime_log_stream(requested_stream),
        tail: query.tail,
        since,
    };

    let entries = runtime.logs(&id, filter).await?;
    let response_entries: Vec<ProcessLogEntry> =
        entries.iter().cloned().map(map_process_log_line).collect();

    if query.follow.unwrap_or(false) {
        let rx = runtime.subscribe_logs(&id).await?;
        let replay_stream = stream::iter(response_entries.into_iter().map(|entry| {
            Ok::<axum::response::sse::Event, Infallible>(
                axum::response::sse::Event::default()
                    .event("log")
                    .id(entry.sequence.to_string())
                    .data(serde_json::to_string(&entry).unwrap_or_else(|_| "{}".to_string())),
            )
        }));

        let requested_stream_copy = requested_stream;
        let follow_stream = BroadcastStream::new(rx).filter_map(move |item| {
            let requested_stream_copy = requested_stream_copy;
            async move {
                match item {
                    Ok(line) => {
                        let entry = map_process_log_line(line);
                        if process_log_matches(&entry, requested_stream_copy) {
                            Some(Ok(axum::response::sse::Event::default()
                                .event("log")
                                .id(entry.sequence.to_string())
                                .data(
                                    serde_json::to_string(&entry)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                )))
                        } else {
                            None
                        }
                    }
                    Err(_) => None,
                }
            }
        });

        let stream = replay_stream.chain(follow_stream);
        let response =
            Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)));
        return Ok(response.into_response());
    }

    Ok(Json(ProcessLogsResponse {
        process_id: id,
        stream: requested_stream,
        entries: response_entries,
    })
    .into_response())
}

/// Write input to a process.
///
/// Sends data to a process's stdin (pipe mode) or PTY writer (tty mode).
/// Data can be encoded as base64, utf8, or text. Returns 413 if the decoded
/// payload exceeds the configured `maxInputBytesPerRequest` limit.
#[utoipa::path(
    post,
    path = "/v1/processes/{id}/input",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID")
    ),
    request_body = ProcessInputRequest,
    responses(
        (status = 200, description = "Input accepted", body = ProcessInputResponse),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 413, description = "Input exceeds configured limit", body = ProblemDetails),
        (status = 409, description = "Process not writable", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_process_input(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ProcessInputRequest>,
) -> Result<Json<ProcessInputResponse>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let encoding = body.encoding.unwrap_or_else(|| "base64".to_string());
    let input = decode_input_bytes(&body.data, &encoding)?;
    let runtime = state.process_runtime();
    let max_input = runtime.max_input_bytes().await;
    if input.len() > max_input {
        return Err(SandboxError::InvalidRequest {
            message: format!("input payload exceeds maxInputBytesPerRequest ({max_input})"),
        }
        .into());
    }

    let bytes_written = runtime.write_input(&id, &input).await?;
    Ok(Json(ProcessInputResponse { bytes_written }))
}

/// Resize a process terminal.
///
/// Sets the PTY window size (columns and rows) for a tty-mode process and
/// sends SIGWINCH so the child process can adapt.
#[utoipa::path(
    post,
    path = "/v1/processes/{id}/terminal/resize",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID")
    ),
    request_body = ProcessTerminalResizeRequest,
    responses(
        (status = 200, description = "Resize accepted", body = ProcessTerminalResizeResponse),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 409, description = "Not a terminal process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_process_terminal_resize(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ProcessTerminalResizeRequest>,
) -> Result<Json<ProcessTerminalResizeResponse>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    state
        .process_runtime()
        .resize_terminal(&id, body.cols, body.rows)
        .await?;
    Ok(Json(ProcessTerminalResizeResponse {
        cols: body.cols,
        rows: body.rows,
    }))
}

/// Open an interactive WebSocket terminal session.
///
/// Upgrades the connection to a WebSocket for bidirectional PTY I/O. Accepts
/// `access_token` query param for browser-based auth (WebSocket API cannot
/// send custom headers). Streams raw PTY output as binary frames and accepts
/// JSON control frames for input, resize, and close.
#[utoipa::path(
    get,
    path = "/v1/processes/{id}/terminal/ws",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID"),
        ("access_token" = Option<String>, Query, description = "Bearer token alternative for WS auth")
    ),
    responses(
        (status = 101, description = "WebSocket upgraded"),
        (status = 400, description = "Invalid websocket frame or upgrade request", body = ProblemDetails),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 409, description = "Not a terminal process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_process_terminal_ws(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(_query): Query<ProcessWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    if !runtime.is_tty(&id).await? {
        return Err(SandboxError::Conflict {
            message: "process is not running in tty mode".to_string(),
        }
        .into());
    }

    Ok(ws
        .on_upgrade(move |socket| process_terminal_ws_session(socket, runtime, id))
        .into_response())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalClientFrame {
    Input {
        data: String,
        #[serde(default)]
        encoding: Option<String>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Close,
}

async fn process_terminal_ws_session(
    mut socket: WebSocket,
    runtime: Arc<ProcessRuntime>,
    id: String,
) {
    let _ = send_ws_json(
        &mut socket,
        json!({
            "type": "ready",
            "processId": &id,
        }),
    )
    .await;

    let mut log_rx = match runtime.subscribe_logs(&id).await {
        Ok(rx) => rx,
        Err(err) => {
            let _ = send_ws_error(&mut socket, &err.to_string()).await;
            let _ = socket.close().await;
            return;
        }
    };
    let mut exit_poll = tokio::time::interval(Duration::from_millis(150));

    loop {
        tokio::select! {
            ws_in = socket.recv() => {
                match ws_in {
                    Some(Ok(Message::Binary(_))) => {
                        let _ = send_ws_error(&mut socket, "binary input is not supported; use text JSON frames").await;
                    }
                    Some(Ok(Message::Text(text))) => {
                        let parsed = serde_json::from_str::<TerminalClientFrame>(&text);
                        match parsed {
                            Ok(TerminalClientFrame::Input { data, encoding }) => {
                                let input = match decode_input_bytes(&data, encoding.as_deref().unwrap_or("utf8")) {
                                    Ok(input) => input,
                                    Err(err) => {
                                        let _ = send_ws_error(&mut socket, &err.to_string()).await;
                                        continue;
                                    }
                                };
                                let max_input = runtime.max_input_bytes().await;
                                if input.len() > max_input {
                                    let _ = send_ws_error(&mut socket, &format!("input payload exceeds maxInputBytesPerRequest ({max_input})")).await;
                                    continue;
                                }
                                if let Err(err) = runtime.write_input(&id, &input).await {
                                    let _ = send_ws_error(&mut socket, &err.to_string()).await;
                                }
                            }
                            Ok(TerminalClientFrame::Resize { cols, rows }) => {
                                if let Err(err) = runtime.resize_terminal(&id, cols, rows).await {
                                    let _ = send_ws_error(&mut socket, &err.to_string()).await;
                                }
                            }
                            Ok(TerminalClientFrame::Close) => {
                                let _ = socket.close().await;
                                break;
                            }
                            Err(err) => {
                                let _ = send_ws_error(&mut socket, &format!("invalid terminal frame: {err}")).await;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
            log_in = log_rx.recv() => {
                match log_in {
                    Ok(line) => {
                        if line.stream != ProcessStream::Pty {
                            continue;
                        }
                        let bytes = {
                            use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
                            use base64::Engine;
                            BASE64_ENGINE.decode(&line.data).unwrap_or_default()
                        };
                        if socket.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = exit_poll.tick() => {
                if let Ok(snapshot) = runtime.snapshot(&id).await {
                    if snapshot.status == ProcessStatus::Exited {
                        let _ = send_ws_json(
                            &mut socket,
                            json!({
                                "type": "exit",
                                "exitCode": snapshot.exit_code,
                            }),
                        )
                        .await;
                        let _ = socket.close().await;
                        break;
                    }
                }
            }
        }
    }
}

/// WebRTC signaling proxy session.
///
/// Proxies the WebSocket bidirectionally between the browser client and neko's
/// internal WebSocket endpoint. All neko signaling messages (SDP offers/answers,
/// ICE candidates, system events) are relayed transparently.
async fn desktop_stream_ws_session(mut client_ws: WebSocket, desktop_runtime: Arc<DesktopRuntime>) {
    use futures::SinkExt;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    // Get neko's internal WS URL from the streaming manager.
    let neko_ws_url = match desktop_runtime.streaming_manager().neko_ws_url().await {
        Some(url) => url,
        None => {
            let _ = send_ws_error(&mut client_ws, "streaming process is not available").await;
            let _ = client_ws.close().await;
            return;
        }
    };

    // Create a fresh neko login session for this connection.
    // Each proxy connection gets its own neko session to avoid conflicts
    // when multiple clients connect (neko sends signal/close to shared sessions).
    let session_cookie = desktop_runtime
        .streaming_manager()
        .create_neko_session()
        .await;

    // Build a WS request with the neko session cookie for authentication.
    let ws_req = {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut req = neko_ws_url
            .into_client_request()
            .expect("valid neko WS URL");
        if let Some(ref cookie) = session_cookie {
            req.headers_mut()
                .insert("Cookie", cookie.parse().expect("valid cookie header"));
        }
        req
    };

    // Connect to neko's internal WebSocket.
    let (neko_ws, _) = match tokio_tungstenite::connect_async(ws_req).await {
        Ok(conn) => conn,
        Err(err) => {
            let _ = send_ws_error(
                &mut client_ws,
                &format!("failed to connect to streaming process: {err}"),
            )
            .await;
            let _ = client_ws.close().await;
            return;
        }
    };

    let (mut neko_sink, mut neko_stream) = neko_ws.split();

    // Relay messages bidirectionally between client and neko.
    loop {
        tokio::select! {
            // Client → Neko (signaling passthrough; input goes via WebRTC data channel)
            client_msg = client_ws.recv() => {
                match client_msg {
                    Some(Ok(Message::Text(text))) => {
                        if neko_sink.send(TungsteniteMessage::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if neko_sink.send(TungsteniteMessage::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = client_ws.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
            // Neko → Client
            neko_msg = neko_stream.next() => {
                match neko_msg {
                    Some(Ok(TungsteniteMessage::Text(text))) => {
                        if client_ws.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Binary(data))) => {
                        if client_ws.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Ping(payload))) => {
                        if neko_sink.send(TungsteniteMessage::Pong(payload.clone())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Close(_))) | None => break,
                    Some(Ok(TungsteniteMessage::Pong(_))) => {}
                    Some(Ok(TungsteniteMessage::Frame(_))) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    let _ = neko_sink.close().await;
    let _ = client_ws.close().await;
}

async fn send_ws_json(socket: &mut WebSocket, payload: Value) -> Result<(), ()> {
    socket
        .send(Message::Text(
            serde_json::to_string(&payload).map_err(|_| ())?,
        ))
        .await
        .map_err(|_| ())
}

async fn send_ws_error(socket: &mut WebSocket, message: &str) -> Result<(), ()> {
    send_ws_json(
        socket,
        json!({
            "type": "error",
            "message": message,
        }),
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v1/config/mcp",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("mcpName" = String, Query, description = "MCP entry name")
    ),
    responses(
        (status = 200, description = "MCP entry", body = McpServerConfig),
        (status = 404, description = "Entry not found", body = ProblemDetails)
    )
)]
async fn get_v1_config_mcp(
    Query(query): Query<McpConfigQuery>,
) -> Result<Json<McpServerConfig>, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.mcp_name, "mcpName")?;

    let path = config_file_path(&query.directory, "mcp.json")?;
    let entries: BTreeMap<String, McpServerConfig> = read_named_config_map(&path)?;
    let value =
        entries
            .get(&query.mcp_name)
            .cloned()
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: format!("mcp:{}", query.mcp_name),
            })?;
    Ok(Json(value))
}

#[utoipa::path(
    put,
    path = "/v1/config/mcp",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("mcpName" = String, Query, description = "MCP entry name")
    ),
    request_body = McpServerConfig,
    responses(
        (status = 204, description = "Stored")
    )
)]
async fn put_v1_config_mcp(
    Query(query): Query<McpConfigQuery>,
    Json(body): Json<McpServerConfig>,
) -> Result<StatusCode, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.mcp_name, "mcpName")?;

    let path = config_file_path(&query.directory, "mcp.json")?;
    let mut entries: BTreeMap<String, McpServerConfig> = read_named_config_map(&path)?;
    entries.insert(query.mcp_name, body);
    write_named_config_map(&path, &entries)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/v1/config/mcp",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("mcpName" = String, Query, description = "MCP entry name")
    ),
    responses(
        (status = 204, description = "Deleted")
    )
)]
async fn delete_v1_config_mcp(Query(query): Query<McpConfigQuery>) -> Result<StatusCode, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.mcp_name, "mcpName")?;

    let path = config_file_path(&query.directory, "mcp.json")?;
    let mut entries: BTreeMap<String, McpServerConfig> = read_named_config_map(&path)?;
    entries.remove(&query.mcp_name);
    write_named_config_map(&path, &entries)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/config/skills",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("skillName" = String, Query, description = "Skill entry name")
    ),
    responses(
        (status = 200, description = "Skills entry", body = SkillsConfig),
        (status = 404, description = "Entry not found", body = ProblemDetails)
    )
)]
async fn get_v1_config_skills(
    Query(query): Query<SkillsConfigQuery>,
) -> Result<Json<SkillsConfig>, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.skill_name, "skillName")?;

    let path = config_file_path(&query.directory, "skills.json")?;
    let entries: BTreeMap<String, SkillsConfig> = read_named_config_map(&path)?;
    let value =
        entries
            .get(&query.skill_name)
            .cloned()
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: format!("skills:{}", query.skill_name),
            })?;
    Ok(Json(value))
}

#[utoipa::path(
    put,
    path = "/v1/config/skills",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("skillName" = String, Query, description = "Skill entry name")
    ),
    request_body = SkillsConfig,
    responses(
        (status = 204, description = "Stored")
    )
)]
async fn put_v1_config_skills(
    Query(query): Query<SkillsConfigQuery>,
    Json(body): Json<SkillsConfig>,
) -> Result<StatusCode, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.skill_name, "skillName")?;

    let path = config_file_path(&query.directory, "skills.json")?;
    let mut entries: BTreeMap<String, SkillsConfig> = read_named_config_map(&path)?;
    entries.insert(query.skill_name, body);
    write_named_config_map(&path, &entries)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/v1/config/skills",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("skillName" = String, Query, description = "Skill entry name")
    ),
    responses(
        (status = 204, description = "Deleted")
    )
)]
async fn delete_v1_config_skills(
    Query(query): Query<SkillsConfigQuery>,
) -> Result<StatusCode, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.skill_name, "skillName")?;

    let path = config_file_path(&query.directory, "skills.json")?;
    let mut entries: BTreeMap<String, SkillsConfig> = read_named_config_map(&path)?;
    entries.remove(&query.skill_name);
    write_named_config_map(&path, &entries)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/acp",
    tag = "v1",
    responses(
        (status = 200, description = "Active ACP server instances", body = AcpServerListResponse)
    )
)]
async fn get_v1_acp_servers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AcpServerListResponse>, ApiError> {
    let servers = state
        .acp_proxy()
        .list_instances()
        .await
        .into_iter()
        .map(|instance| AcpServerInfo {
            server_id: instance.server_id,
            agent: instance.agent.as_str().to_string(),
            created_at_ms: instance.created_at_ms,
        })
        .collect::<Vec<_>>();

    Ok(Json(AcpServerListResponse { servers }))
}

#[utoipa::path(
    post,
    path = "/v1/acp/{server_id}",
    tag = "v1",
    params(
        ("server_id" = String, Path, description = "Client-defined ACP server id"),
        ("agent" = Option<String>, Query, description = "Agent id required for first POST")
    ),
    request_body = AcpEnvelope,
    responses(
        (status = 200, description = "JSON-RPC response envelope", body = AcpEnvelope),
        (status = 202, description = "JSON-RPC notification accepted"),
        (status = 406, description = "Client does not accept JSON responses", body = ProblemDetails),
        (status = 415, description = "Unsupported media type", body = ProblemDetails),
        (status = 400, description = "Invalid ACP envelope", body = ProblemDetails),
        (status = 404, description = "Unknown ACP server", body = ProblemDetails),
        (status = 409, description = "ACP server bound to different agent", body = ProblemDetails),
        (status = 504, description = "ACP agent process response timeout", body = ProblemDetails)
    )
)]
async fn post_v1_acp(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Query(query): Query<AcpPostQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if !content_type_is(&headers, APPLICATION_JSON) {
        return Err(SandboxError::UnsupportedMediaType {
            message: "content-type must be application/json".to_string(),
        }
        .into());
    }
    if !accept_allows(&headers, APPLICATION_JSON) {
        return Err(SandboxError::NotAcceptable {
            message: "accept must allow application/json".to_string(),
        }
        .into());
    }

    let payload =
        serde_json::from_slice::<Value>(&body).map_err(|err| SandboxError::InvalidRequest {
            message: format!("invalid JSON body: {err}"),
        })?;

    let bootstrap_agent = match query.agent {
        Some(agent) => {
            Some(
                AgentId::parse(&agent).ok_or_else(|| SandboxError::UnsupportedAgent {
                    agent: agent.clone(),
                })?,
            )
        }
        None => None,
    };

    match state
        .acp_proxy()
        .post(&server_id, bootstrap_agent, payload)
        .await?
    {
        ProxyPostOutcome::Response(value) => Ok((StatusCode::OK, Json(value)).into_response()),
        ProxyPostOutcome::Accepted => Ok(StatusCode::ACCEPTED.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v1/acp/{server_id}",
    tag = "v1",
    params(
        ("server_id" = String, Path, description = "Client-defined ACP server id")
    ),
    responses(
        (status = 200, description = "SSE stream of ACP envelopes"),
        (status = 406, description = "Client does not accept SSE responses", body = ProblemDetails),
        (status = 404, description = "Unknown ACP server", body = ProblemDetails),
        (status = 400, description = "Invalid request", body = ProblemDetails)
    )
)]
async fn get_v1_acp(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Sse<PinBoxSseStream>, ApiError> {
    if !accept_allows(&headers, TEXT_EVENT_STREAM) {
        return Err(SandboxError::NotAcceptable {
            message: "accept must allow text/event-stream".to_string(),
        }
        .into());
    }

    let last_event_id = parse_last_event_id(&headers)?;
    let stream = state.acp_proxy().sse(&server_id, last_event_id).await?;

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    ))
}

#[utoipa::path(
    delete,
    path = "/v1/acp/{server_id}",
    tag = "v1",
    params(
        ("server_id" = String, Path, description = "Client-defined ACP server id")
    ),
    responses(
        (status = 204, description = "ACP server closed")
    )
)]
async fn delete_v1_acp(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.acp_proxy().delete(&server_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn process_api_supported() -> bool {
    !cfg!(windows)
}

fn process_api_not_supported() -> ProblemDetails {
    ProblemDetails {
        type_: ErrorType::InvalidRequest.as_urn().to_string(),
        title: "Not Implemented".to_string(),
        status: 501,
        detail: Some("process API is not implemented on Windows".to_string()),
        instance: None,
        extensions: serde_json::Map::new(),
    }
}

fn map_process_config(config: ProcessRuntimeConfig) -> ProcessConfig {
    ProcessConfig {
        max_concurrent_processes: config.max_concurrent_processes,
        default_run_timeout_ms: config.default_run_timeout_ms,
        max_run_timeout_ms: config.max_run_timeout_ms,
        max_output_bytes: config.max_output_bytes,
        max_log_bytes_per_process: config.max_log_bytes_per_process,
        max_input_bytes_per_request: config.max_input_bytes_per_request,
    }
}

fn into_runtime_process_config(config: ProcessConfig) -> ProcessRuntimeConfig {
    ProcessRuntimeConfig {
        max_concurrent_processes: config.max_concurrent_processes,
        default_run_timeout_ms: config.default_run_timeout_ms,
        max_run_timeout_ms: config.max_run_timeout_ms,
        max_output_bytes: config.max_output_bytes,
        max_log_bytes_per_process: config.max_log_bytes_per_process,
        max_input_bytes_per_request: config.max_input_bytes_per_request,
    }
}

fn into_runtime_process_owner(owner: ProcessOwner) -> RuntimeProcessOwner {
    match owner {
        ProcessOwner::User => RuntimeProcessOwner::User,
        ProcessOwner::Desktop => RuntimeProcessOwner::Desktop,
        ProcessOwner::System => RuntimeProcessOwner::System,
    }
}

fn map_process_snapshot(snapshot: ProcessSnapshot) -> ProcessInfo {
    ProcessInfo {
        id: snapshot.id,
        command: snapshot.command,
        args: snapshot.args,
        cwd: snapshot.cwd,
        tty: snapshot.tty,
        interactive: snapshot.interactive,
        owner: match snapshot.owner {
            RuntimeProcessOwner::User => ProcessOwner::User,
            RuntimeProcessOwner::Desktop => ProcessOwner::Desktop,
            RuntimeProcessOwner::System => ProcessOwner::System,
        },
        status: match snapshot.status {
            ProcessStatus::Running => ProcessState::Running,
            ProcessStatus::Exited => ProcessState::Exited,
        },
        pid: snapshot.pid,
        exit_code: snapshot.exit_code,
        created_at_ms: snapshot.created_at_ms,
        exited_at_ms: snapshot.exited_at_ms,
    }
}

fn into_runtime_log_stream(stream: ProcessLogsStream) -> ProcessLogFilterStream {
    match stream {
        ProcessLogsStream::Stdout => ProcessLogFilterStream::Stdout,
        ProcessLogsStream::Stderr => ProcessLogFilterStream::Stderr,
        ProcessLogsStream::Combined => ProcessLogFilterStream::Combined,
        ProcessLogsStream::Pty => ProcessLogFilterStream::Pty,
    }
}

fn map_process_log_line(line: crate::process_runtime::ProcessLogLine) -> ProcessLogEntry {
    ProcessLogEntry {
        sequence: line.sequence,
        stream: match line.stream {
            ProcessStream::Stdout => ProcessLogsStream::Stdout,
            ProcessStream::Stderr => ProcessLogsStream::Stderr,
            ProcessStream::Pty => ProcessLogsStream::Pty,
        },
        timestamp_ms: line.timestamp_ms,
        data: line.data,
        encoding: line.encoding.to_string(),
    }
}

fn process_log_matches(entry: &ProcessLogEntry, stream: ProcessLogsStream) -> bool {
    match stream {
        ProcessLogsStream::Stdout => entry.stream == ProcessLogsStream::Stdout,
        ProcessLogsStream::Stderr => entry.stream == ProcessLogsStream::Stderr,
        ProcessLogsStream::Combined => {
            entry.stream == ProcessLogsStream::Stdout || entry.stream == ProcessLogsStream::Stderr
        }
        ProcessLogsStream::Pty => entry.stream == ProcessLogsStream::Pty,
    }
}

fn validate_named_query(value: &str, field_name: &str) -> Result<(), SandboxError> {
    if value.trim().is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: format!("missing required '{field_name}' query parameter"),
        });
    }
    Ok(())
}

fn config_file_path(directory: &str, filename: &str) -> Result<PathBuf, SandboxError> {
    if directory.trim().is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: "missing required 'directory' query parameter".to_string(),
        });
    }

    let base_dir = PathBuf::from(directory);
    let root = if base_dir.is_absolute() {
        base_dir
    } else {
        std::env::current_dir()
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?
            .join(base_dir)
    };

    Ok(root.join(".sandbox-agent").join("config").join(filename))
}

fn read_named_config_map<T>(path: &StdPath) -> Result<BTreeMap<String, T>, SandboxError>
where
    T: DeserializeOwned,
{
    if !path.exists() {
        return Ok(BTreeMap::new());
    }

    let text = fs::read_to_string(path).map_err(|err| SandboxError::StreamError {
        message: err.to_string(),
    })?;

    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }

    serde_json::from_str::<BTreeMap<String, T>>(&text).map_err(|err| SandboxError::InvalidRequest {
        message: format!("invalid config file {}: {err}", path.display()),
    })
}

fn write_named_config_map<T>(
    path: &StdPath,
    values: &BTreeMap<String, T>,
) -> Result<(), SandboxError>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
    }

    let body = serde_json::to_string_pretty(values).map_err(|err| SandboxError::StreamError {
        message: err.to_string(),
    })?;

    fs::write(path, body).map_err(|err| SandboxError::StreamError {
        message: err.to_string(),
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
