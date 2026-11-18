//! OpenCode-compatible API handlers mounted under `/opencode`.
//!
//! These endpoints implement the full OpenCode OpenAPI surface. Most routes are
//! stubbed responses with deterministic helpers for snapshot testing. A minimal
//! in-memory state tracks sessions/messages/ptys to keep behavior coherent.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive};
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use futures::stream;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};
use tokio::time::interval;
use tracing::{info, warn};
use utoipa::{IntoParams, OpenApi, ToSchema};

use crate::router::{
    is_question_tool_action, AgentModelInfo, AppState, CreateSessionRequest, PermissionReply,
    SessionInfo,
};
use crate::universal_events::{
    ContentPart, FileAction, ItemDeltaData, ItemEventData, ItemKind, ItemRole, ItemStatus,
    PermissionEventData, PermissionStatus, QuestionEventData, QuestionStatus, UniversalEvent,
    UniversalEventData, UniversalEventType, UniversalItem,
};
use sandbox_agent_agent_credentials::{
    extract_all_credentials, CredentialExtractionOptions, ExtractedCredentials,
};
use sandbox_agent_agent_management::agents::AgentId;
use sandbox_agent_error::SandboxError;

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);
static MESSAGE_COUNTER: AtomicU64 = AtomicU64::new(1);
static PART_COUNTER: AtomicU64 = AtomicU64::new(1);
static PTY_COUNTER: AtomicU64 = AtomicU64::new(1);
static PROJECT_COUNTER: AtomicU64 = AtomicU64::new(1);
const OPENCODE_EVENT_CHANNEL_SIZE: usize = 2048;
const OPENCODE_EVENT_LOG_SIZE: usize = 4096;
const OPENCODE_DEFAULT_MODEL_ID: &str = "mock";
const OPENCODE_DEFAULT_PROVIDER_ID: &str = "mock";
const OPENCODE_DEFAULT_AGENT_MODE: &str = "build";
const OPENCODE_MODEL_CHANGE_AFTER_SESSION_CREATE_ERROR: &str = "OpenCode compatibility currently does not support changing the model after creating a session. Export with /export and load in to a new session.";

#[derive(Clone, Debug)]
struct OpenCodeStreamEvent {
    id: u64,
    payload: Value,
}

#[derive(Clone, Debug)]
struct OpenCodeCompatConfig {
    fixed_time_ms: Option<i64>,
    fixed_directory: Option<String>,
    fixed_worktree: Option<String>,
    fixed_home: Option<String>,
    fixed_state: Option<String>,
    fixed_config: Option<String>,
    fixed_branch: Option<String>,
    proxy_base_url: Option<String>,
}

impl OpenCodeCompatConfig {
    fn from_env() -> Self {
        Self {
            fixed_time_ms: std::env::var("OPENCODE_COMPAT_FIXED_TIME_MS")
                .ok()
                .and_then(|value| value.parse::<i64>().ok()),
            fixed_directory: std::env::var("OPENCODE_COMPAT_DIRECTORY").ok(),
            fixed_worktree: std::env::var("OPENCODE_COMPAT_WORKTREE").ok(),
            fixed_home: std::env::var("OPENCODE_COMPAT_HOME").ok(),
            fixed_state: std::env::var("OPENCODE_COMPAT_STATE").ok(),
            fixed_config: std::env::var("OPENCODE_COMPAT_CONFIG").ok(),
            fixed_branch: std::env::var("OPENCODE_COMPAT_BRANCH").ok(),
            proxy_base_url: std::env::var("OPENCODE_COMPAT_PROXY_URL")
                .ok()
                .and_then(normalize_proxy_base_url),
        }
    }

    fn now_ms(&self) -> i64 {
        if let Some(value) = self.fixed_time_ms {
            return value;
        }
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

fn normalize_proxy_base_url(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.trim_end_matches('/').to_string();
    if normalized.starts_with("http://") || normalized.starts_with("https://") {
        Some(normalized)
    } else {
        None
    }
}

#[derive(Clone, Debug)]
struct OpenCodeSessionRecord {
    id: String,
    slug: String,
    project_id: String,
    directory: String,
    parent_id: Option<String>,
    title: String,
    version: String,
    created_at: i64,
    updated_at: i64,
    share_url: Option<String>,
    permission_mode: Option<String>,
}

impl OpenCodeSessionRecord {
    fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("id".to_string(), json!(self.id));
        map.insert("slug".to_string(), json!(self.slug));
        map.insert("projectID".to_string(), json!(self.project_id));
        map.insert("directory".to_string(), json!(self.directory));
        map.insert("title".to_string(), json!(self.title));
        map.insert("version".to_string(), json!(self.version));
        map.insert(
            "time".to_string(),
            json!({
                "created": self.created_at,
                "updated": self.updated_at,
            }),
        );
        if let Some(parent_id) = &self.parent_id {
            map.insert("parentID".to_string(), json!(parent_id));
        }
        if let Some(url) = &self.share_url {
            map.insert("share".to_string(), json!({"url": url}));
        }
        if let Some(permission_mode) = &self.permission_mode {
            map.insert("permissionMode".to_string(), json!(permission_mode));
        }
        Value::Object(map)
    }
}

/// Convert a v1 `SessionInfo` to the OpenCode session JSON format.
fn session_info_to_opencode_value(info: &SessionInfo, default_project_id: &str) -> Value {
    let title = info
        .title
        .clone()
        .unwrap_or_else(|| format!("Session {}", info.session_id));
    let directory = info.directory.clone().unwrap_or_default();
    let mut value = json!({
        "id": info.session_id,
        "slug": format!("session-{}", info.session_id),
        "projectID": default_project_id,
        "directory": directory,
        "title": title,
        "version": "0",
        "time": {
            "created": info.created_at,
            "updated": info.updated_at,
        }
    });
    if let Some(obj) = value.as_object_mut() {
        obj.insert("agent".to_string(), json!(info.agent));
        obj.insert("permissionMode".to_string(), json!(info.permission_mode));
        if let Some(model) = &info.model {
            obj.insert("model".to_string(), json!(model));
        }
    }
    value
}

#[derive(Clone, Debug)]
struct OpenCodeMessageRecord {
    info: Value,
    parts: Vec<Value>,
}

#[derive(Clone, Debug)]
struct OpenCodePtyRecord {
    id: String,
    title: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    status: String,
    pid: i64,
}

impl OpenCodePtyRecord {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "command": self.command,
            "args": self.args,
            "cwd": self.cwd,
            "status": self.status,
            "pid": self.pid,
        })
    }
}

#[derive(Clone, Debug)]
struct OpenCodePermissionRecord {
    id: String,
    session_id: String,
    permission: String,
    patterns: Vec<String>,
    metadata: Value,
    always: Vec<String>,
    tool: Option<Value>,
}

impl OpenCodePermissionRecord {
    fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("id".to_string(), json!(self.id));
        map.insert("sessionID".to_string(), json!(self.session_id));
        map.insert("permission".to_string(), json!(self.permission));
        map.insert("patterns".to_string(), json!(self.patterns));
        map.insert("metadata".to_string(), self.metadata.clone());
        map.insert("always".to_string(), json!(self.always));
        if let Some(tool) = &self.tool {
            map.insert("tool".to_string(), tool.clone());
        }
        Value::Object(map)
    }
}

#[derive(Clone, Debug)]
struct OpenCodeQuestionRecord {
    id: String,
    session_id: String,
    questions: Vec<Value>,
    tool: Option<Value>,
}

impl OpenCodeQuestionRecord {
    fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("id".to_string(), json!(self.id));
        map.insert("sessionID".to_string(), json!(self.session_id));
        map.insert("questions".to_string(), json!(self.questions));
        if let Some(tool) = &self.tool {
            map.insert("tool".to_string(), tool.clone());
        }
        Value::Object(map)
    }
}

#[derive(Default, Clone)]
struct OpenCodeSessionRuntime {
    turn_in_progress: bool,
    last_user_message_id: Option<String>,
    active_assistant_message_id: Option<String>,
    last_agent: Option<String>,
    last_model_provider: Option<String>,
    last_model_id: Option<String>,
    session_agent_id: Option<String>,
    session_provider_id: Option<String>,
    session_model_id: Option<String>,
    message_id_for_item: HashMap<String, String>,
    text_by_message: HashMap<String, String>,
    part_id_by_message: HashMap<String, String>,
    tool_part_by_call: HashMap<String, String>,
    tool_message_by_call: HashMap<String, String>,
    /// Tool name by call_id, persisted from ToolCall for use in ToolResult events
    tool_name_by_call: HashMap<String, String>,
    /// Tool arguments by call_id, persisted from ToolCall for use in ToolResult events
    tool_args_by_call: HashMap<String, String>,
    /// Tool calls that have been requested but not yet resolved.
    open_tool_calls: HashSet<String>,
    /// Assistant messages that have streamed text deltas.
    messages_with_text_deltas: HashSet<String>,
    /// Item IDs (native and normalized) known to be user messages.
    user_item_ids: HashSet<String>,
    /// Item IDs (native and normalized) that should not emit text deltas.
    non_text_item_ids: HashSet<String>,
}

#[derive(Clone, Debug)]
struct OpenCodeModelEntry {
    model: AgentModelInfo,
    group_id: String,
    group_name: String,
}

#[derive(Clone, Debug)]
struct OpenCodeModelCache {
    entries: Vec<OpenCodeModelEntry>,
    model_lookup: HashMap<String, AgentId>,
    group_defaults: HashMap<String, String>,
    group_agents: HashMap<String, AgentId>,
    group_names: HashMap<String, String>,
    default_group: String,
    default_model: String,
    /// Group IDs that have valid credentials available
    connected: Vec<String>,
}

pub struct OpenCodeState {
    config: OpenCodeCompatConfig,
    default_project_id: String,
    sessions: Mutex<HashMap<String, OpenCodeSessionRecord>>,
    messages: Mutex<HashMap<String, Vec<OpenCodeMessageRecord>>>,
    ptys: Mutex<HashMap<String, OpenCodePtyRecord>>,
    permissions: Mutex<HashMap<String, OpenCodePermissionRecord>>,
    questions: Mutex<HashMap<String, OpenCodeQuestionRecord>>,
    session_runtime: Mutex<HashMap<String, OpenCodeSessionRuntime>>,
    session_streams: Mutex<HashMap<String, bool>>,
    event_broadcaster: broadcast::Sender<OpenCodeStreamEvent>,
    event_log: StdMutex<VecDeque<OpenCodeStreamEvent>>,
    next_event_id: AtomicU64,
    model_cache: Mutex<Option<OpenCodeModelCache>>,
}

impl OpenCodeState {
    pub fn new() -> Self {
        let (event_broadcaster, _) = broadcast::channel(OPENCODE_EVENT_CHANNEL_SIZE);
        let project_id = format!("proj_{}", PROJECT_COUNTER.fetch_add(1, Ordering::Relaxed));
        Self {
            config: OpenCodeCompatConfig::from_env(),
            default_project_id: project_id,
            sessions: Mutex::new(HashMap::new()),
            messages: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            questions: Mutex::new(HashMap::new()),
            session_runtime: Mutex::new(HashMap::new()),
            session_streams: Mutex::new(HashMap::new()),
            event_broadcaster,
            event_log: StdMutex::new(VecDeque::new()),
            next_event_id: AtomicU64::new(1),
            model_cache: Mutex::new(None),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<OpenCodeStreamEvent> {
        self.event_broadcaster.subscribe()
    }

    pub fn emit_event(&self, event: Value) {
        let stream_event = OpenCodeStreamEvent {
            id: self.next_event_id.fetch_add(1, Ordering::Relaxed),
            payload: event,
        };
        if let Ok(mut log) = self.event_log.lock() {
            log.push_back(stream_event.clone());
            if log.len() > OPENCODE_EVENT_LOG_SIZE {
                let overflow = log.len() - OPENCODE_EVENT_LOG_SIZE;
                for _ in 0..overflow {
                    let _ = log.pop_front();
                }
            }
        }
        let _ = self.event_broadcaster.send(stream_event);
    }

    fn buffered_events_after(&self, last_event_id: Option<u64>) -> Vec<OpenCodeStreamEvent> {
        let Some(last_event_id) = last_event_id else {
            return Vec::new();
        };
        let Ok(log) = self.event_log.lock() else {
            return Vec::new();
        };
        log.iter()
            .filter(|event| event.id > last_event_id)
            .cloned()
            .collect()
    }

    fn now_ms(&self) -> i64 {
        self.config.now_ms()
    }

    fn directory_for(&self, headers: &HeaderMap, query: Option<&String>) -> String {
        if let Some(value) = query {
            return value.clone();
        }
        if let Some(value) = self.config.fixed_directory.as_ref().cloned().or_else(|| {
            headers
                .get("x-opencode-directory")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_string())
        }) {
            return value;
        }
        std::env::current_dir()
            .ok()
            .and_then(|p| p.to_str().map(|v| v.to_string()))
            .unwrap_or_else(|| ".".to_string())
    }

    fn worktree_for(&self, directory: &str) -> String {
        self.config
            .fixed_worktree
            .clone()
            .unwrap_or_else(|| directory.to_string())
    }

    fn home_dir(&self) -> String {
        self.config
            .fixed_home
            .clone()
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string())
    }

    fn state_dir(&self) -> String {
        self.config
            .fixed_state
            .clone()
            .unwrap_or_else(|| format!("{}/.local/state/opencode", self.home_dir()))
    }

    async fn ensure_session(&self, session_id: &str, directory: String) -> Value {
        let mut sessions = self.sessions.lock().await;
        if let Some(existing) = sessions.get(session_id) {
            return existing.to_value();
        }

        let now = self.now_ms();
        let record = OpenCodeSessionRecord {
            id: session_id.to_string(),
            slug: format!("session-{}", session_id),
            project_id: self.default_project_id.clone(),
            directory,
            parent_id: None,
            title: format!("Session {}", session_id),
            version: "0".to_string(),
            created_at: now,
            updated_at: now,
            share_url: None,
            permission_mode: None,
        };
        let value = record.to_value();
        sessions.insert(session_id.to_string(), record);
        drop(sessions);

        self.emit_event(session_event("session.created", &value));
        value
    }

    fn config_dir(&self) -> String {
        self.config
            .fixed_config
            .clone()
            .unwrap_or_else(|| format!("{}/.config/opencode", self.home_dir()))
    }

    fn branch_name(&self) -> String {
        self.config
            .fixed_branch
            .clone()
            .unwrap_or_else(|| "main".to_string())
    }

    fn proxy_base_url(&self) -> Option<&str> {
        self.config.proxy_base_url.as_deref()
    }

    async fn update_runtime(
        &self,
        session_id: &str,
        update: impl FnOnce(&mut OpenCodeSessionRuntime),
    ) -> OpenCodeSessionRuntime {
        let mut runtimes = self.session_runtime.lock().await;
        let entry = runtimes
            .entry(session_id.to_string())
            .or_insert_with(OpenCodeSessionRuntime::default);
        update(entry);
        entry.clone()
    }
}

/// Combined app state with OpenCode state.
pub struct OpenCodeAppState {
    pub inner: Arc<AppState>,
    pub opencode: Arc<OpenCodeState>,
    proxy_http_client: Client,
}

impl OpenCodeAppState {
    pub fn new(inner: Arc<AppState>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            opencode: Arc::new(OpenCodeState::new()),
            proxy_http_client: Client::new(),
        })
    }
}

async fn ensure_backing_session(
    state: &Arc<OpenCodeAppState>,
    session_id: &str,
    agent: &str,
    model: Option<String>,
    variant: Option<String>,
    permission_mode: Option<String>,
) -> Result<(), SandboxError> {
    let model = model.filter(|value| !value.trim().is_empty());
    let variant = variant.filter(|value| !value.trim().is_empty());
    // Pull directory and title from the OpenCode session record if available.
    let (directory, title) = {
        let sessions = state.opencode.sessions.lock().await;
        sessions
            .get(session_id)
            .map(|s| (Some(s.directory.clone()), Some(s.title.clone())))
            .unwrap_or((None, None))
    };
    let request = CreateSessionRequest {
        agent: agent.to_string(),
        agent_mode: None,
        permission_mode: permission_mode.clone(),
        model: model.clone(),
        variant: variant.clone(),
        agent_version: None,
        directory,
        title,
        mcp: None,
        skills: None,
    };
    let manager = state.inner.session_manager();
    match manager
        .create_session(session_id.to_string(), request.clone())
        .await
    {
        Ok(_) => Ok(()),
        Err(SandboxError::SessionAlreadyExists { .. }) => {
            let should_recreate = manager
                .get_session_info(session_id)
                .await
                .map(|info| info.agent != agent && info.event_count <= 1)
                .unwrap_or(false);
            if should_recreate {
                manager.delete_session(session_id).await?;
                match manager
                    .create_session(session_id.to_string(), request.clone())
                    .await
                {
                    Ok(_) => Ok(()),
                    Err(SandboxError::SessionAlreadyExists { .. }) => {
                        match manager
                            .set_session_overrides(session_id, model.clone(), variant.clone())
                            .await
                        {
                            Ok(()) => Ok(()),
                            Err(SandboxError::SessionNotFound { .. }) => {
                                tracing::warn!(
                                    target = "sandbox_agent::opencode",
                                    session_id,
                                    "backing session vanished while applying overrides; retrying create_session"
                                );
                                match manager
                                    .create_session(session_id.to_string(), request.clone())
                                    .await
                                {
                                    Ok(_) | Err(SandboxError::SessionAlreadyExists { .. }) => {
                                        Ok(())
                                    }
                                    Err(err) => Err(err),
                                }
                            }
                            Err(other) => Err(other),
                        }
                    }
                    Err(err) => Err(err),
                }
            } else {
                match manager
                    .set_session_overrides(session_id, model.clone(), variant.clone())
                    .await
                {
                    Ok(()) => Ok(()),
                    Err(SandboxError::SessionNotFound { .. }) => {
                        tracing::warn!(
                            target = "sandbox_agent::opencode",
                            session_id,
                            "backing session missing while setting overrides; retrying create_session"
                        );
                        match manager
                            .create_session(session_id.to_string(), request.clone())
                            .await
                        {
                            Ok(_) | Err(SandboxError::SessionAlreadyExists { .. }) => Ok(()),
                            Err(err) => Err(err),
                        }
                    }
                    Err(other) => Err(other),
                }
            }
        }
        Err(err) => Err(err),
    }
}

async fn ensure_session_stream(state: Arc<OpenCodeAppState>, session_id: String) {
    let should_spawn = {
        let mut streams = state.opencode.session_streams.lock().await;
        if streams.contains_key(&session_id) {
            false
        } else {
            streams.insert(session_id.clone(), true);
            true
        }
    };
    if !should_spawn {
        return;
    }

    tokio::spawn(async move {
        let subscription = match state
            .inner
            .session_manager()
            .subscribe(&session_id, 0)
            .await
        {
            Ok(subscription) => subscription,
            Err(_) => {
                let mut streams = state.opencode.session_streams.lock().await;
                streams.remove(&session_id);
                return;
            }
        };

        for event in subscription.initial_events {
            apply_universal_event(state.clone(), event).await;
        }
        let mut receiver = subscription.receiver;
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    apply_universal_event(state.clone(), event).await;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
        let mut streams = state.opencode.session_streams.lock().await;
        streams.remove(&session_id);
    });
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct OpenCodeCreateSessionRequest {
    title: Option<String>,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
    #[schema(value_type = String)]
    permission: Option<Value>,
    #[serde(alias = "permission_mode")]
    permission_mode: Option<String>,
    #[schema(value_type = String)]
    model: Option<Value>,
    #[serde(rename = "providerID")]
    provider_id: Option<String>,
    #[serde(rename = "modelID")]
    model_id: Option<String>,
    variant: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct OpenCodeUpdateSessionRequest {
    title: Option<String>,
    #[schema(value_type = String)]
    model: Option<Value>,
    #[serde(rename = "providerID", alias = "provider_id", alias = "providerId")]
    provider_id: Option<String>,
    #[serde(rename = "modelID", alias = "model_id", alias = "modelId")]
    model_id: Option<String>,
}

fn update_requests_model_change(update: &OpenCodeUpdateSessionRequest) -> bool {
    update.model.is_some() || update.provider_id.is_some() || update.model_id.is_some()
}

#[derive(Debug, Deserialize, IntoParams)]
struct DirectoryQuery {
    directory: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct ToolQuery {
    directory: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct FindTextQuery {
    directory: Option<String>,
    pattern: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct FindFilesQuery {
    directory: Option<String>,
    query: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct FindSymbolsQuery {
    directory: Option<String>,
    query: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct FileContentQuery {
    directory: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionMessageRequest {
    #[schema(value_type = Vec<String>)]
    parts: Option<Vec<Value>>,
    #[serde(rename = "messageID")]
    message_id: Option<String>,
    agent: Option<String>,
    #[schema(value_type = String)]
    model: Option<Value>,
    system: Option<String>,
    variant: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionCommandRequest {
    command: Option<String>,
    arguments: Option<String>,
    #[serde(rename = "messageID")]
    message_id: Option<String>,
    agent: Option<String>,
    model: Option<String>,
    variant: Option<String>,
    #[schema(value_type = Vec<String>)]
    parts: Option<Vec<Value>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionShellRequest {
    command: Option<String>,
    agent: Option<String>,
    #[schema(value_type = String)]
    model: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionSummarizeRequest {
    #[serde(rename = "providerID")]
    provider_id: Option<String>,
    #[serde(rename = "modelID")]
    model_id: Option<String>,
    auto: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionInitRequest {
    #[serde(rename = "providerID")]
    provider_id: Option<String>,
    #[serde(rename = "modelID")]
    model_id: Option<String>,
    #[serde(rename = "messageID")]
    message_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
struct PermissionReplyRequest {
    response: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PermissionGlobalReplyRequest {
    reply: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct QuestionReplyBody {
    answers: Option<Vec<Vec<String>>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PtyCreateRequest {
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    title: Option<String>,
}

fn next_id(prefix: &str, counter: &AtomicU64) -> String {
    let id = counter.fetch_add(1, Ordering::Relaxed);
    format!("{}{}", prefix, id)
}

fn available_agent_ids() -> Vec<AgentId> {
    vec![
        AgentId::Claude,
        AgentId::Codex,
        AgentId::Opencode,
        AgentId::Amp,
        AgentId::Mock,
    ]
}

fn default_agent_id() -> AgentId {
    AgentId::Mock
}

fn default_agent_mode() -> &'static str {
    OPENCODE_DEFAULT_AGENT_MODE
}

async fn opencode_model_cache(state: &OpenCodeAppState) -> OpenCodeModelCache {
    // Keep this lock for the full build to enforce singleflight behavior.
    // Concurrent requests wait for the same in-flight build instead of
    // spawning duplicate provider/model fetches.
    let mut slot = state.opencode.model_cache.lock().await;
    if let Some(cache) = slot.as_ref() {
        info!(
            entries = cache.entries.len(),
            groups = cache.group_names.len(),
            connected = cache.connected.len(),
            "opencode model cache hit"
        );
        return cache.clone();
    }

    let started = std::time::Instant::now();
    info!("opencode model cache miss; building cache");
    let cache = build_opencode_model_cache(state).await;
    info!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        entries = cache.entries.len(),
        groups = cache.group_names.len(),
        connected = cache.connected.len(),
        "opencode model cache built"
    );
    *slot = Some(cache.clone());
    cache
}

async fn build_opencode_model_cache(state: &OpenCodeAppState) -> OpenCodeModelCache {
    let started = std::time::Instant::now();
    // Check credentials upfront
    let creds_started = std::time::Instant::now();
    let credentials = match tokio::task::spawn_blocking(|| {
        extract_all_credentials(&CredentialExtractionOptions::new())
    })
    .await
    {
        Ok(creds) => creds,
        Err(err) => {
            warn!("Failed to extract credentials for model cache: {err}");
            ExtractedCredentials::default()
        }
    };
    let has_anthropic = credentials.anthropic.is_some();
    let has_openai = credentials.openai.is_some();
    info!(
        elapsed_ms = creds_started.elapsed().as_millis() as u64,
        has_anthropic, has_openai, "opencode model cache credential scan complete"
    );

    let mut entries = Vec::new();
    let mut model_lookup = HashMap::new();
    let mut ambiguous_models = HashSet::new();
    let mut group_defaults: HashMap<String, String> = HashMap::new();
    let mut group_agents: HashMap<String, AgentId> = HashMap::new();
    let mut group_names: HashMap<String, String> = HashMap::new();
    let mut default_model: Option<String> = None;

    let agents = available_agent_ids();
    let manager = state.inner.session_manager();
    let fetches = agents.iter().copied().map(|agent| {
        let manager = manager.clone();
        async move {
            let agent_started = std::time::Instant::now();
            let response = manager.agent_models(agent).await;
            (agent, agent_started.elapsed(), response)
        }
    });
    let fetch_results = futures::future::join_all(fetches).await;

    for (agent, elapsed, response) in fetch_results {
        let response = match response {
            Ok(response) => response,
            Err(err) => {
                warn!(
                    agent = agent.as_str(),
                    elapsed_ms = elapsed.as_millis() as u64,
                    ?err,
                    "opencode model cache failed fetching agent models"
                );
                continue;
            }
        };
        info!(
            agent = agent.as_str(),
            elapsed_ms = elapsed.as_millis() as u64,
            model_count = response.models.len(),
            has_default = response.default_model.is_some(),
            "opencode model cache fetched agent models"
        );

        let first_model_id = response.models.first().map(|model| model.id.clone());
        for model in response.models {
            let model_id = model.id.clone();
            let (group_id, group_name) = group_for_agent_model(agent, &model_id);

            if response.default_model.as_deref() == Some(model_id.as_str()) {
                group_defaults.insert(group_id.clone(), model_id.clone());
            }

            group_agents.entry(group_id.clone()).or_insert(agent);
            group_names
                .entry(group_id.clone())
                .or_insert_with(|| group_name.clone());

            if !ambiguous_models.contains(&model_id) {
                match model_lookup.get(&model_id) {
                    None => {
                        model_lookup.insert(model_id.clone(), agent);
                    }
                    Some(existing) if *existing != agent => {
                        model_lookup.remove(&model_id);
                        ambiguous_models.insert(model_id.clone());
                    }
                    _ => {}
                }
            }

            entries.push(OpenCodeModelEntry {
                model,
                group_id,
                group_name,
            });
        }

        if default_model.is_none() {
            default_model = response.default_model.clone().or(first_model_id);
        }
    }

    let mut groups: BTreeMap<String, Vec<&OpenCodeModelEntry>> = BTreeMap::new();
    for entry in &entries {
        groups
            .entry(entry.group_id.clone())
            .or_default()
            .push(entry);
    }
    for entries in groups.values_mut() {
        entries.sort_by(|a, b| a.model.id.cmp(&b.model.id));
    }

    if entries
        .iter()
        .any(|entry| entry.model.id == OPENCODE_DEFAULT_MODEL_ID)
    {
        default_model = Some(OPENCODE_DEFAULT_MODEL_ID.to_string());
    }

    let default_model = default_model.unwrap_or_else(|| {
        entries
            .first()
            .map(|entry| entry.model.id.clone())
            .unwrap_or_else(|| OPENCODE_DEFAULT_MODEL_ID.to_string())
    });

    let mut default_group = entries
        .iter()
        .find(|entry| entry.model.id == default_model)
        .map(|entry| entry.group_id.clone())
        .unwrap_or_else(|| OPENCODE_DEFAULT_PROVIDER_ID.to_string());

    if !groups.contains_key(&default_group) {
        if let Some((group_id, _)) = groups.iter().next() {
            default_group = group_id.clone();
        }
    }

    for (group_id, entries) in &groups {
        if !group_defaults.contains_key(group_id) {
            if let Some(entry) = entries.first() {
                group_defaults.insert(group_id.clone(), entry.model.id.clone());
            }
        }
    }

    // Build connected list conservatively for deterministic compat behavior.
    let mut connected = Vec::new();
    for group_id in group_names.keys() {
        let is_connected = matches!(group_agents.get(group_id), Some(AgentId::Mock));
        if is_connected {
            connected.push(group_id.clone());
        }
    }

    let cache = OpenCodeModelCache {
        entries,
        model_lookup,
        group_defaults,
        group_agents,
        group_names,
        default_group,
        default_model,
        connected,
    };
    info!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        entries = cache.entries.len(),
        groups = cache.group_names.len(),
        connected = cache.connected.len(),
        default_group = cache.default_group.as_str(),
        default_model = cache.default_model.as_str(),
        "opencode model cache build complete"
    );
    cache
}

fn resolve_agent_from_model(
    cache: &OpenCodeModelCache,
    provider_id: &str,
    model_id: &str,
) -> Option<AgentId> {
    if let Some(agent) = cache.group_agents.get(provider_id) {
        return Some(*agent);
    }
    if let Some(agent) = cache.model_lookup.get(model_id) {
        return Some(*agent);
    }
    if let Some(agent) = AgentId::parse(model_id) {
        return Some(agent);
    }
    if opencode_group_provider(provider_id).is_some() {
        return Some(AgentId::Opencode);
    }
    if model_id.contains('/') {
        return Some(AgentId::Opencode);
    }
    if model_id.starts_with("claude-") {
        return Some(AgentId::Claude);
    }
    if ["smart", "rush", "deep", "free"].contains(&model_id) {
        return Some(AgentId::Amp);
    }
    if model_id.starts_with("gpt-") || model_id.starts_with('o') {
        return Some(AgentId::Codex);
    }
    None
}

fn normalize_agent_mode(agent: Option<String>) -> String {
    agent
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_agent_mode().to_string())
}

async fn resolve_session_agent(
    state: &OpenCodeAppState,
    session_id: &str,
    requested_provider: Option<&str>,
    requested_model: Option<&str>,
) -> (String, String, String) {
    let cache = opencode_model_cache(state).await;
    let default_model_id = cache.default_model.clone();
    let requested_provider = requested_provider
        .filter(|value| !value.is_empty())
        .filter(|value| *value != "sandbox-agent")
        .map(|value| value.to_string());
    let requested_model = requested_model
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let explicit_selection = requested_provider.is_some() || requested_model.is_some();
    let mut provider_id = requested_provider.clone();
    let model_id = requested_model.clone();
    if provider_id.is_none() {
        if let Some(model_value) = model_id.as_deref() {
            if let Some(entry) = cache
                .entries
                .iter()
                .find(|entry| entry.model.id == model_value)
            {
                provider_id = Some(entry.group_id.clone());
            } else if let Some(agent) = AgentId::parse(model_value) {
                provider_id = Some(agent.as_str().to_string());
            }
        }
    }
    let mut provider_id = provider_id.unwrap_or_else(|| cache.default_group.clone());
    let mut model_id = model_id
        .or_else(|| cache.group_defaults.get(&provider_id).cloned())
        .unwrap_or_else(|| default_model_id.clone());
    let mut resolved_agent = resolve_agent_from_model(&cache, &provider_id, &model_id);
    if resolved_agent.is_none() {
        provider_id = cache.default_group.clone();
        model_id = default_model_id.clone();
        resolved_agent = resolve_agent_from_model(&cache, &provider_id, &model_id)
            .or_else(|| Some(default_agent_id()));
    }

    let mut resolved_agent_id: Option<String> = None;
    let mut resolved_provider: Option<String> = None;
    let mut resolved_model: Option<String> = None;

    state
        .opencode
        .update_runtime(session_id, |runtime| {
            if runtime.session_agent_id.is_none() || explicit_selection {
                let agent = resolved_agent.unwrap_or_else(default_agent_id);
                runtime.session_agent_id = Some(agent.as_str().to_string());
                runtime.session_provider_id = Some(provider_id.clone());
                runtime.session_model_id = Some(model_id.clone());
            }
            resolved_agent_id = runtime.session_agent_id.clone();
            resolved_provider = runtime.session_provider_id.clone();
            resolved_model = runtime.session_model_id.clone();
        })
        .await;

    (
        resolved_agent_id.unwrap_or_else(|| default_agent_id().as_str().to_string()),
        resolved_provider.unwrap_or(provider_id),
        resolved_model.unwrap_or(model_id),
    )
}

fn agent_display_name(agent: AgentId) -> &'static str {
    match agent {
        AgentId::Claude => "Claude Code",
        AgentId::Codex => "Codex",
        AgentId::Opencode => "OpenCode",
        AgentId::Amp => "Amp",
        AgentId::Mock => "Mock",
    }
}

fn opencode_model_provider(model_id: &str) -> Option<&str> {
    model_id.split_once('/').map(|(provider, _)| provider)
}

fn opencode_group_provider(group_id: &str) -> Option<&str> {
    group_id.strip_prefix("opencode:")
}

fn group_for_agent_model(agent: AgentId, model_id: &str) -> (String, String) {
    if agent == AgentId::Opencode {
        let provider = opencode_model_provider(model_id).unwrap_or("unknown");
        return (
            format!("opencode:{provider}"),
            format!("OpenCode ({provider})"),
        );
    }
    let group_id = agent.as_str().to_string();
    let group_name = agent_display_name(agent).to_string();
    (group_id, group_name)
}

fn backing_model_for_agent(agent: AgentId, provider_id: &str, model_id: &str) -> Option<String> {
    if model_id.trim().is_empty() {
        return None;
    }
    if AgentId::parse(model_id).is_some() {
        return None;
    }
    if agent != AgentId::Opencode {
        return Some(model_id.to_string());
    }
    if model_id.contains('/') {
        return Some(model_id.to_string());
    }
    if let Some(provider) = opencode_group_provider(provider_id) {
        return Some(format!("{provider}/{model_id}"));
    }
    Some(model_id.to_string())
}

fn model_config_entry(entry: &OpenCodeModelEntry) -> Value {
    let model_name = entry
        .model
        .name
        .clone()
        .unwrap_or_else(|| entry.model.id.clone());
    let variants = model_variants_object(&entry.model);
    json!({
        "id": entry.model.id,
        "providerID": entry.group_id,
        "api": {
            "id": "sandbox-agent",
            "url": "http://localhost",
            "npm": "@sandbox-agent/sdk"
        },
        "name": model_name,
        "family": entry.group_name,
        "capabilities": {
            "temperature": true,
            "reasoning": true,
            "attachment": false,
            "toolcall": true,
            "input": {
                "text": true,
                "audio": false,
                "image": false,
                "video": false,
                "pdf": false
            },
            "output": {
                "text": true,
                "audio": false,
                "image": false,
                "video": false,
                "pdf": false
            },
            "interleaved": false
        },
        "cost": {
            "input": 0,
            "output": 0,
            "cache": {"read": 0, "write": 0}
        },
        "limit": {
            "context": 128000,
            "output": 4096
        },
        "status": "active",
        "options": {},
        "headers": {},
        "release_date": "2024-01-01",
        "variants": variants
    })
}

fn model_summary_entry(entry: &OpenCodeModelEntry) -> Value {
    let model_name = entry
        .model
        .name
        .clone()
        .unwrap_or_else(|| entry.model.id.clone());
    let variants = model_variants_object(&entry.model);
    json!({
        "id": entry.model.id,
        "name": model_name,
        "family": entry.group_name,
        "release_date": "2024-01-01",
        "attachment": false,
        "reasoning": true,
        "temperature": true,
        "tool_call": true,
        "options": {},
        "limit": {
            "context": 128000,
            "output": 4096
        },
        "variants": variants
    })
}

fn model_variants_object(model: &AgentModelInfo) -> Value {
    let Some(variants) = model.variants.as_ref() else {
        return json!({});
    };
    let mut map = serde_json::Map::new();
    for variant in variants {
        map.insert(variant.clone(), json!({}));
    }
    Value::Object(map)
}

fn bad_request(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "data": {},
            "errors": [{"message": message}],
            "success": false,
        })),
    )
}

fn not_found(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "name": "NotFoundError",
            "data": {"message": message},
        })),
    )
}

fn internal_error(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "data": {},
            "errors": [{"message": message}],
            "success": false,
        })),
    )
}

fn sandbox_error_response(err: SandboxError) -> (StatusCode, Json<Value>) {
    match err {
        SandboxError::SessionNotFound { .. } => not_found("Session not found"),
        SandboxError::InvalidRequest { message } => bad_request(&message),
        other => internal_error(&other.to_string()),
    }
}

fn parse_permission_reply_value(value: Option<&str>) -> Result<PermissionReply, String> {
    let value = value.unwrap_or("once").to_ascii_lowercase();
    match value.as_str() {
        "once" | "allow" | "approve" => Ok(PermissionReply::Once),
        "always" => Ok(PermissionReply::Always),
        "reject" | "deny" => Ok(PermissionReply::Reject),
        other => PermissionReply::from_str(other),
    }
}

fn bool_ok(value: bool) -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!(value)))
}

async fn proxy_native_opencode(
    state: &Arc<OpenCodeAppState>,
    method: reqwest::Method,
    path: &str,
    headers: &HeaderMap,
    body: Option<Value>,
) -> Option<Response> {
    let base_url = if let Some(base_url) = state.opencode.proxy_base_url() {
        base_url.to_string()
    } else {
        match state.inner.ensure_opencode_server().await {
            Ok(base_url) => base_url,
            Err(err) => {
                warn!(path, ?err, "failed to lazily start native opencode server");
                return None;
            }
        }
    };

    let mut request = state
        .proxy_http_client
        .request(method, format!("{base_url}{path}"));

    for header_name in [
        header::AUTHORIZATION,
        header::ACCEPT,
        HeaderName::from_static("x-opencode-directory"),
    ] {
        if let Some(value) = headers.get(&header_name) {
            request = request.header(header_name.as_str(), value.as_bytes());
        }
    }

    if let Some(body) = body {
        request = request.json(&body);
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            warn!(path, ?err, "failed proxy request to native opencode");
            return Some(
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "data": {},
                        "errors": [{"message": format!("failed to proxy to native opencode: {err}")}],
                        "success": false,
                    })),
                )
                    .into_response(),
            );
        }
    };

    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let body_bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!(path, ?err, "failed to read proxied response body");
            return Some(
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "data": {},
                        "errors": [{"message": format!("failed to read proxied response: {err}")}],
                        "success": false,
                    })),
                )
                    .into_response(),
            );
        }
    };

    let mut proxied = Response::new(Body::from(body_bytes));
    *proxied.status_mut() = status;
    if let Some(content_type) = content_type {
        if let Ok(header_value) = HeaderValue::from_str(&content_type) {
            proxied
                .headers_mut()
                .insert(header::CONTENT_TYPE, header_value);
        }
    }

    Some(proxied)
}

fn build_user_message(
    session_id: &str,
    message_id: &str,
    created_at: i64,
    agent: &str,
    provider_id: &str,
    model_id: &str,
) -> Value {
    json!({
        "id": message_id,
        "sessionID": session_id,
        "role": "user",
        "time": {"created": created_at},
        "agent": agent,
        "model": {"providerID": provider_id, "modelID": model_id},
    })
}

fn build_assistant_message(
    session_id: &str,
    message_id: &str,
    parent_id: &str,
    created_at: i64,
    directory: &str,
    worktree: &str,
    agent: &str,
    provider_id: &str,
    model_id: &str,
) -> Value {
    json!({
        "id": message_id,
        "sessionID": session_id,
        "role": "assistant",
        "time": {"created": created_at},
        "parentID": parent_id,
        "modelID": model_id,
        "providerID": provider_id,
        "mode": "default",
        "agent": agent,
        "path": {"cwd": directory, "root": worktree},
        "cost": 0,
        "finish": "stop",
        "tokens": {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache": {"read": 0, "write": 0}
        }
    })
}

fn build_text_part(session_id: &str, message_id: &str, text: &str) -> Value {
    json!({
        "id": next_id("part_", &PART_COUNTER),
        "sessionID": session_id,
        "messageID": message_id,
        "type": "text",
        "text": text,
    })
}

fn part_id_from_input(input: &Value) -> String {
    input
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .unwrap_or_else(|| next_id("part_", &PART_COUNTER))
}

fn build_file_part(session_id: &str, message_id: &str, input: &Value) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), json!(part_id_from_input(input)));
    map.insert("sessionID".to_string(), json!(session_id));
    map.insert("messageID".to_string(), json!(message_id));
    map.insert("type".to_string(), json!("file"));
    map.insert(
        "mime".to_string(),
        input
            .get("mime")
            .cloned()
            .unwrap_or_else(|| json!("application/octet-stream")),
    );
    map.insert(
        "url".to_string(),
        input.get("url").cloned().unwrap_or_else(|| json!("")),
    );
    if let Some(filename) = input.get("filename") {
        map.insert("filename".to_string(), filename.clone());
    }
    if let Some(source) = input.get("source") {
        map.insert("source".to_string(), source.clone());
    }
    Value::Object(map)
}

fn build_agent_part(session_id: &str, message_id: &str, input: &Value) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), json!(part_id_from_input(input)));
    map.insert("sessionID".to_string(), json!(session_id));
    map.insert("messageID".to_string(), json!(message_id));
    map.insert("type".to_string(), json!("agent"));
    map.insert(
        "name".to_string(),
        input.get("name").cloned().unwrap_or_else(|| json!("")),
    );
    if let Some(source) = input.get("source") {
        map.insert("source".to_string(), source.clone());
    }
    Value::Object(map)
}

fn build_subtask_part(session_id: &str, message_id: &str, input: &Value) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), json!(part_id_from_input(input)));
    map.insert("sessionID".to_string(), json!(session_id));
    map.insert("messageID".to_string(), json!(message_id));
    map.insert("type".to_string(), json!("subtask"));
    map.insert(
        "prompt".to_string(),
        input.get("prompt").cloned().unwrap_or_else(|| json!("")),
    );
    map.insert(
        "description".to_string(),
        input
            .get("description")
            .cloned()
            .unwrap_or_else(|| json!("")),
    );
    map.insert(
        "agent".to_string(),
        input.get("agent").cloned().unwrap_or_else(|| json!("")),
    );
    if let Some(model) = input.get("model") {
        map.insert("model".to_string(), model.clone());
    }
    if let Some(command) = input.get("command") {
        map.insert("command".to_string(), command.clone());
    }
    Value::Object(map)
}

fn normalize_part(session_id: &str, message_id: &str, input: &Value) -> Value {
    match input.get("type").and_then(|v| v.as_str()) {
        Some("file") => build_file_part(session_id, message_id, input),
        Some("agent") => build_agent_part(session_id, message_id, input),
        Some("subtask") => build_subtask_part(session_id, message_id, input),
        _ => build_text_part(
            session_id,
            message_id,
            input
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim(),
        ),
    }
}

fn message_id_for_sequence(sequence: u64) -> String {
    format!("msg_{:020}", sequence)
}

fn unique_assistant_message_id(
    runtime: &OpenCodeSessionRuntime,
    parent_id: Option<&String>,
    sequence: u64,
) -> String {
    let base = match parent_id {
        Some(parent) => format!("{parent}_assistant"),
        None => message_id_for_sequence(sequence),
    };
    if runtime.message_id_for_item.values().any(|id| id == &base) {
        format!("{base}_{:020}", sequence)
    } else {
        base
    }
}

fn set_item_text_delta_capability(
    runtime: &mut OpenCodeSessionRuntime,
    item_id: Option<&str>,
    native_item_id: Option<&str>,
    supports_text_deltas: bool,
) {
    for key in [item_id, native_item_id].into_iter().flatten() {
        if supports_text_deltas {
            runtime.non_text_item_ids.remove(key);
        } else {
            runtime.non_text_item_ids.insert(key.to_string());
        }
    }
}

fn item_delta_is_non_text(
    runtime: &OpenCodeSessionRuntime,
    item_id: Option<&str>,
    native_item_id: Option<&str>,
) -> bool {
    [item_id, native_item_id]
        .into_iter()
        .flatten()
        .any(|key| runtime.non_text_item_ids.contains(key))
}

fn item_supports_text_deltas(item: &UniversalItem) -> bool {
    if item.kind != ItemKind::Message {
        return false;
    }
    if !matches!(item.role.as_ref(), Some(ItemRole::Assistant)) {
        return false;
    }
    if item.content.is_empty() {
        return true;
    }
    item.content
        .iter()
        .any(|part| matches!(part, ContentPart::Text { .. }))
}

fn extract_message_text_from_content(parts: &[ContentPart]) -> Option<String> {
    let mut text = String::new();
    for part in parts {
        if let ContentPart::Text { text: chunk } = part {
            text.push_str(chunk);
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn extract_text_from_content(parts: &[ContentPart]) -> Option<String> {
    let mut text = String::new();
    for part in parts {
        match part {
            ContentPart::Text { text: chunk } => {
                text.push_str(chunk);
            }
            ContentPart::Json { json } => {
                if let Ok(chunk) = serde_json::to_string(json) {
                    text.push_str(&chunk);
                }
            }
            ContentPart::Status { label, detail } => {
                text.push_str(label);
                if let Some(detail) = detail {
                    if !detail.is_empty() {
                        text.push_str(": ");
                        text.push_str(detail);
                    }
                }
            }
            _ => {}
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn build_text_part_with_id(session_id: &str, message_id: &str, part_id: &str, text: &str) -> Value {
    json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "text",
        "text": text,
    })
}

fn build_reasoning_part(
    session_id: &str,
    message_id: &str,
    part_id: &str,
    text: &str,
    now: i64,
) -> Value {
    json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "reasoning",
        "text": text,
        "metadata": {},
        "time": {"start": now, "end": now},
    })
}

fn build_tool_part(
    session_id: &str,
    message_id: &str,
    part_id: &str,
    call_id: &str,
    tool: &str,
    state: Value,
) -> Value {
    json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "tool",
        "callID": call_id,
        "tool": tool,
        "state": state,
        "metadata": {},
    })
}

fn file_source_from_diff(path: &str, diff: &str) -> Value {
    json!({
        "type": "file",
        "path": path,
        "text": {
            "value": diff,
            "start": 0,
            "end": diff.len() as i64,
        }
    })
}

fn build_file_part_from_path(
    session_id: &str,
    message_id: &str,
    path: &str,
    mime: &str,
    diff: Option<&str>,
) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), json!(next_id("part_", &PART_COUNTER)));
    map.insert("sessionID".to_string(), json!(session_id));
    map.insert("messageID".to_string(), json!(message_id));
    map.insert("type".to_string(), json!("file"));
    map.insert("mime".to_string(), json!(mime));
    map.insert("url".to_string(), json!(format!("file://{}", path)));
    map.insert("filename".to_string(), json!(path));
    if let Some(diff) = diff {
        map.insert("source".to_string(), file_source_from_diff(path, diff));
    }
    Value::Object(map)
}

fn session_event(event_type: &str, session: &Value) -> Value {
    json!({
        "type": event_type,
        "properties": {"info": session}
    })
}

fn message_event(event_type: &str, message: &Value) -> Value {
    let session_id = message
        .get("sessionID")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let mut props = serde_json::Map::new();
    props.insert("info".to_string(), message.clone());
    if let Some(session_id) = session_id {
        props.insert("sessionID".to_string(), json!(session_id));
    }
    Value::Object({
        let mut map = serde_json::Map::new();
        map.insert("type".to_string(), json!(event_type));
        map.insert("properties".to_string(), Value::Object(props));
        map
    })
}

fn part_event_with_delta(event_type: &str, part: &Value, delta: Option<&str>) -> Value {
    let mut props = serde_json::Map::new();
    props.insert("part".to_string(), part.clone());
    if let Some(session_id) = part.get("sessionID").and_then(|v| v.as_str()) {
        props.insert("sessionID".to_string(), json!(session_id));
    }
    if let Some(message_id) = part.get("messageID").and_then(|v| v.as_str()) {
        props.insert("messageID".to_string(), json!(message_id));
    }
    if let Some(delta) = delta {
        props.insert("delta".to_string(), json!(delta));
    }
    Value::Object({
        let mut map = serde_json::Map::new();
        map.insert("type".to_string(), json!(event_type));
        map.insert("properties".to_string(), Value::Object(props));
        map
    })
}

fn part_event(event_type: &str, part: &Value) -> Value {
    part_event_with_delta(event_type, part, None)
}

fn emit_file_edited(state: &OpenCodeState, path: &str) {
    state.emit_event(json!({
        "type": "file.edited",
        "properties": {"file": path}
    }));
}

fn emit_session_idle(state: &OpenCodeState, session_id: &str) {
    state.emit_event(json!({
        "type": "session.status",
        "properties": {"sessionID": session_id, "status": {"type": "idle"}}
    }));
    state.emit_event(json!({
        "type": "session.idle",
        "properties": {"sessionID": session_id}
    }));
}

fn emit_session_error(
    state: &OpenCodeState,
    session_id: &str,
    message: &str,
    code: Option<&str>,
    details: Option<Value>,
) {
    let mut error = serde_json::Map::new();
    error.insert("data".to_string(), json!({"message": message}));
    if let Some(code) = code {
        error.insert("code".to_string(), json!(code));
    }
    if let Some(details) = details {
        error.insert("details".to_string(), details);
    }
    state.emit_event(json!({
        "type": "session.error",
        "properties": {"sessionID": session_id, "error": Value::Object(error)}
    }));
}

fn permission_event(event_type: &str, permission: &Value) -> Value {
    json!({
        "type": event_type,
        "properties": permission
    })
}

fn question_event(event_type: &str, question: &Value) -> Value {
    json!({
        "type": event_type,
        "properties": question
    })
}

fn message_id_from_info(info: &Value) -> Option<String> {
    info.get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
}

async fn upsert_message_info(state: &OpenCodeState, session_id: &str, info: Value) -> Vec<Value> {
    let mut messages = state.messages.lock().await;
    let entry = messages.entry(session_id.to_string()).or_default();
    let message_id = message_id_from_info(&info);
    if let Some(message_id) = message_id.clone() {
        if let Some(existing) = entry.iter_mut().find(|record| {
            message_id_from_info(&record.info).as_deref() == Some(message_id.as_str())
        }) {
            existing.info = info.clone();
        } else {
            entry.push(OpenCodeMessageRecord {
                info: info.clone(),
                parts: Vec::new(),
            });
        }
        entry.sort_by(|a, b| {
            let a_id = message_id_from_info(&a.info).unwrap_or_default();
            let b_id = message_id_from_info(&b.info).unwrap_or_default();
            a_id.cmp(&b_id)
        });
    }
    entry.iter().map(|record| record.info.clone()).collect()
}

async fn upsert_message_part(
    state: &OpenCodeState,
    session_id: &str,
    message_id: &str,
    part: Value,
) {
    let mut messages = state.messages.lock().await;
    let entry = messages.entry(session_id.to_string()).or_default();
    let record = if let Some(record) = entry
        .iter_mut()
        .find(|record| message_id_from_info(&record.info).as_deref() == Some(message_id))
    {
        record
    } else {
        entry.push(OpenCodeMessageRecord {
            info: json!({"id": message_id, "sessionID": session_id, "role": "assistant", "time": {"created": 0}}),
            parts: Vec::new(),
        });
        entry.last_mut().expect("record just inserted")
    };

    let part_id = part.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(existing) = record
        .parts
        .iter_mut()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(part_id))
    {
        *existing = part;
    } else {
        record.parts.push(part);
    }
    // Preserve insertion order so UI rendering matches stream chronology.
    // Sorting by synthetic part IDs can reorder text/tool parts unexpectedly.
}

async fn session_directory(state: &OpenCodeState, session_id: &str) -> String {
    let sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get(session_id) {
        return session.directory.clone();
    }
    std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(|v| v.to_string()))
        .unwrap_or_else(|| ".".to_string())
}

#[derive(Default)]
struct ToolContentInfo {
    call_id: Option<String>,
    tool_name: Option<String>,
    arguments: Option<String>,
    output: Option<String>,
    file_refs: Vec<(String, FileAction, Option<String>)>,
}

fn extract_tool_content(parts: &[ContentPart]) -> ToolContentInfo {
    let mut info = ToolContentInfo::default();
    for part in parts {
        match part {
            ContentPart::ToolCall {
                name,
                arguments,
                call_id,
            } => {
                info.call_id = Some(call_id.clone());
                info.tool_name = Some(name.clone());
                info.arguments = Some(arguments.clone());
            }
            ContentPart::ToolResult { call_id, output } => {
                info.call_id = Some(call_id.clone());
                info.output = Some(output.clone());
            }
            ContentPart::FileRef { path, action, diff } => {
                info.file_refs
                    .push((path.clone(), action.clone(), diff.clone()));
            }
            _ => {}
        }
    }
    info
}

fn tool_input_from_arguments(arguments: Option<&str>) -> Value {
    let Some(arguments) = arguments else {
        return json!({});
    };
    if let Ok(value) = serde_json::from_str::<Value>(arguments) {
        if value.is_object() {
            return value;
        }
    }
    json!({ "arguments": arguments })
}

fn patterns_from_metadata(metadata: &Option<Value>) -> Vec<String> {
    let mut patterns = Vec::new();
    let Some(metadata) = metadata else {
        return patterns;
    };
    if let Some(path) = metadata.get("path").and_then(|v| v.as_str()) {
        patterns.push(path.to_string());
    }
    if let Some(paths) = metadata.get("paths").and_then(|v| v.as_array()) {
        for value in paths {
            if let Some(path) = value.as_str() {
                patterns.push(path.to_string());
            }
        }
    }
    if let Some(patterns_value) = metadata.get("patterns").and_then(|v| v.as_array()) {
        for value in patterns_value {
            if let Some(pattern) = value.as_str() {
                patterns.push(pattern.to_string());
            }
        }
    }
    patterns
}

fn turn_error_from_metadata(metadata: &Option<Value>) -> Option<(String, Option<Value>)> {
    let error = metadata.as_ref()?.get("error")?;
    let message = error
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("Turn failed")
        .to_string();
    Some((message, Some(error.clone())))
}

async fn apply_universal_event(state: Arc<OpenCodeAppState>, event: UniversalEvent) {
    match event.event_type {
        UniversalEventType::ItemStarted | UniversalEventType::ItemCompleted => {
            if let UniversalEventData::Item(ItemEventData { item }) = &event.data {
                apply_item_event(state, event.clone(), item.clone()).await;
            }
        }
        UniversalEventType::TurnStarted => {
            state
                .opencode
                .update_runtime(&event.session_id, |runtime| {
                    runtime.turn_in_progress = true;
                })
                .await;
            let session_id = event.session_id.clone();
            state.opencode.emit_event(json!({
                "type": "session.status",
                "properties": {"sessionID": session_id, "status": {"type": "busy"}}
            }));
        }
        UniversalEventType::TurnEnded => {
            let turn_data = match &event.data {
                UniversalEventData::Turn(data) => Some(data.clone()),
                _ => None,
            };
            let mut should_emit_idle = false;
            state
                .opencode
                .update_runtime(&event.session_id, |runtime| {
                    let was_turn_in_progress = runtime.turn_in_progress;
                    runtime.active_assistant_message_id = None;
                    runtime.turn_in_progress = false;
                    runtime.open_tool_calls.clear();
                    should_emit_idle = was_turn_in_progress;
                })
                .await;
            if let Some(turn_data) = turn_data {
                if let Some((message, details)) = turn_error_from_metadata(&turn_data.metadata) {
                    emit_session_error(&state.opencode, &event.session_id, &message, None, details);
                }
            }
            if !should_emit_idle {
                return;
            }
            emit_session_idle(&state.opencode, &event.session_id);
        }
        UniversalEventType::ItemDelta => {
            if let UniversalEventData::ItemDelta(ItemDeltaData {
                item_id,
                native_item_id,
                delta,
            }) = &event.data
            {
                apply_item_delta(
                    state,
                    event.clone(),
                    item_id.clone(),
                    native_item_id.clone(),
                    delta.clone(),
                )
                .await;
            }
        }
        UniversalEventType::SessionEnded => {
            let mut should_emit_idle = false;
            state
                .opencode
                .update_runtime(&event.session_id, |runtime| {
                    should_emit_idle = runtime.turn_in_progress;
                    runtime.turn_in_progress = false;
                    runtime.active_assistant_message_id = None;
                    runtime.open_tool_calls.clear();
                })
                .await;
            if should_emit_idle {
                emit_session_idle(&state.opencode, &event.session_id);
            }
        }
        UniversalEventType::PermissionRequested | UniversalEventType::PermissionResolved => {
            if let UniversalEventData::Permission(permission) = &event.data {
                apply_permission_event(state, event.clone(), permission.clone()).await;
            }
        }
        UniversalEventType::QuestionRequested | UniversalEventType::QuestionResolved => {
            if let UniversalEventData::Question(question) = &event.data {
                apply_question_event(state, event.clone(), question.clone()).await;
            }
        }
        UniversalEventType::Error => {
            if let UniversalEventData::Error(error) = &event.data {
                let session_id = event.session_id.clone();
                let mut should_emit_idle = false;
                state
                    .opencode
                    .update_runtime(&session_id, |runtime| {
                        let was_turn_in_progress = runtime.turn_in_progress;
                        runtime.turn_in_progress = false;
                        runtime.active_assistant_message_id = None;
                        should_emit_idle = was_turn_in_progress;
                    })
                    .await;
                emit_session_error(
                    &state.opencode,
                    &session_id,
                    &error.message,
                    error.code.as_deref(),
                    error.details.clone(),
                );
                if should_emit_idle {
                    emit_session_idle(&state.opencode, &session_id);
                }
            }
        }
        _ => {}
    }
}

async fn apply_permission_event(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    permission: PermissionEventData,
) {
    // Suppress question-tool permissions (AskUserQuestion/ExitPlanMode) — these are
    // handled internally via reply_question/reject_question, not exposed as permissions.
    if is_question_tool_action(&permission.action) {
        return;
    }
    let session_id = event.session_id.clone();
    match permission.status {
        PermissionStatus::Requested => {
            let record = OpenCodePermissionRecord {
                id: permission.permission_id.clone(),
                session_id: session_id.clone(),
                permission: permission.action.clone(),
                patterns: patterns_from_metadata(&permission.metadata),
                metadata: permission.metadata.clone().unwrap_or_else(|| json!({})),
                always: Vec::new(),
                tool: None,
            };
            let value = record.to_value();
            let mut permissions = state.opencode.permissions.lock().await;
            permissions.insert(record.id.clone(), record);
            drop(permissions);
            state
                .opencode
                .emit_event(permission_event("permission.asked", &value));
        }
        PermissionStatus::Accept
        | PermissionStatus::AcceptForSession
        | PermissionStatus::Reject => {
            let reply = match permission.status {
                PermissionStatus::Accept => "once",
                PermissionStatus::AcceptForSession => "always",
                PermissionStatus::Reject => "reject",
                PermissionStatus::Requested => "once",
            };
            let event_value = json!({
                "sessionID": session_id,
                "requestID": permission.permission_id,
                "reply": reply,
            });
            let mut permissions = state.opencode.permissions.lock().await;
            permissions.remove(&permission.permission_id);
            drop(permissions);
            state
                .opencode
                .emit_event(permission_event("permission.replied", &event_value));
        }
    }
}

async fn apply_question_event(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    question: QuestionEventData,
) {
    let session_id = event.session_id.clone();
    match question.status {
        QuestionStatus::Requested => {
            let options: Vec<Value> = question
                .options
                .iter()
                .map(|option| {
                    json!({
                        "label": option,
                        "description": ""
                    })
                })
                .collect();
            let question_info = json!({
                "header": "Question",
                "question": question.prompt,
                "options": options,
            });
            let record = OpenCodeQuestionRecord {
                id: question.question_id.clone(),
                session_id: session_id.clone(),
                questions: vec![question_info],
                tool: None,
            };
            let value = record.to_value();
            let mut questions = state.opencode.questions.lock().await;
            questions.insert(record.id.clone(), record);
            drop(questions);
            state
                .opencode
                .emit_event(question_event("question.asked", &value));
        }
        QuestionStatus::Answered => {
            let answers = question
                .response
                .clone()
                .map(|answer| vec![vec![answer]])
                .unwrap_or_else(|| Vec::<Vec<String>>::new());
            let event_value = json!({
                "sessionID": session_id,
                "requestID": question.question_id,
                "answers": answers,
            });
            let mut questions = state.opencode.questions.lock().await;
            questions.remove(&question.question_id);
            drop(questions);
            state
                .opencode
                .emit_event(question_event("question.replied", &event_value));
        }
        QuestionStatus::Rejected => {
            let event_value = json!({
                "sessionID": session_id,
                "requestID": question.question_id,
            });
            let mut questions = state.opencode.questions.lock().await;
            questions.remove(&question.question_id);
            drop(questions);
            state
                .opencode
                .emit_event(question_event("question.rejected", &event_value));
        }
    }
}

async fn apply_item_event(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    item: UniversalItem,
) {
    let session_id = event.session_id.clone();
    let item_id_key = if item.item_id.is_empty() {
        None
    } else {
        Some(item.item_id.clone())
    };
    let native_id_key = item.native_item_id.clone();
    let supports_text_deltas = item_supports_text_deltas(&item);
    let is_user_item = matches!(item.role.as_ref(), Some(ItemRole::User));
    let _ = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            set_item_text_delta_capability(
                runtime,
                item_id_key.as_deref(),
                native_id_key.as_deref(),
                supports_text_deltas,
            );
            if is_user_item {
                if let Some(item_key) = item_id_key.as_ref() {
                    runtime.user_item_ids.insert(item_key.clone());
                }
                if let Some(native_key) = native_id_key.as_ref() {
                    runtime.user_item_ids.insert(native_key.clone());
                }
            }
        })
        .await;

    if matches!(item.kind, ItemKind::ToolCall | ItemKind::ToolResult) {
        apply_tool_item_event(state, event, item).await;
        return;
    }
    if item.kind != ItemKind::Message {
        return;
    }
    if is_user_item {
        return;
    }
    let mut message_id: Option<String> = None;
    let mut parent_id: Option<String> = None;
    let runtime = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            parent_id = item
                .parent_id
                .as_ref()
                .and_then(|parent| runtime.message_id_for_item.get(parent).cloned())
                .or_else(|| runtime.last_user_message_id.clone());
            if let Some(existing) = item_id_key
                .clone()
                .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                .or_else(|| {
                    native_id_key
                        .clone()
                        .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                })
                .or_else(|| runtime.active_assistant_message_id.clone())
            {
                message_id = Some(existing);
            } else {
                let new_id =
                    unique_assistant_message_id(runtime, parent_id.as_ref(), event.sequence);
                message_id = Some(new_id);
            }
            if let Some(id) = message_id.clone() {
                if let Some(item_key) = item_id_key.clone() {
                    runtime.message_id_for_item.insert(item_key, id.clone());
                }
                if let Some(native_key) = native_id_key.clone() {
                    runtime.message_id_for_item.insert(native_key, id.clone());
                }
            }
        })
        .await;
    let message_id = message_id.unwrap_or_else(|| {
        unique_assistant_message_id(&runtime, parent_id.as_ref(), event.sequence)
    });
    let parent_id = parent_id.or_else(|| runtime.last_user_message_id.clone());
    let agent = runtime
        .last_agent
        .clone()
        .unwrap_or_else(|| default_agent_mode().to_string());
    let provider_id = runtime
        .last_model_provider
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_PROVIDER_ID.to_string());
    let model_id = runtime
        .last_model_id
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_MODEL_ID.to_string());
    let directory = session_directory(&state.opencode, &session_id).await;
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();

    let mut info = build_assistant_message(
        &session_id,
        &message_id,
        parent_id.as_deref().unwrap_or(""),
        now,
        &directory,
        &worktree,
        &agent,
        &provider_id,
        &model_id,
    );
    if event.event_type == UniversalEventType::ItemCompleted {
        if let Some(obj) = info.as_object_mut() {
            if let Some(time) = obj.get_mut("time").and_then(|v| v.as_object_mut()) {
                time.insert("completed".to_string(), json!(now));
            }
        }
    }
    upsert_message_info(&state.opencode, &session_id, info.clone()).await;
    state
        .opencode
        .emit_event(message_event("message.updated", &info));

    let mut runtime = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            if runtime.last_user_message_id.is_none() {
                runtime.last_user_message_id = parent_id.clone();
            }
            runtime.active_assistant_message_id = Some(message_id.clone());
        })
        .await;

    if let Some(text) = extract_message_text_from_content(&item.content) {
        if event.event_type == UniversalEventType::ItemStarted {
            // Reset streaming text state for a new assistant item.
            let _ = state
                .opencode
                .update_runtime(&session_id, |runtime| {
                    runtime.text_by_message.remove(&message_id);
                    runtime.part_id_by_message.remove(&message_id);
                    runtime.messages_with_text_deltas.remove(&message_id);
                })
                .await;
        } else {
            // If text was streamed via deltas, keep segment ordering as emitted and
            // avoid replacing the latest segment with full completed text.
            let has_streamed_text = runtime.messages_with_text_deltas.contains(&message_id);
            if !has_streamed_text {
                let part_id = runtime
                    .part_id_by_message
                    .get(&message_id)
                    .cloned()
                    .unwrap_or_else(|| next_id("part_", &PART_COUNTER));
                let final_text = runtime
                    .text_by_message
                    .get(&message_id)
                    .filter(|t| !t.is_empty())
                    .cloned()
                    .unwrap_or_else(|| text.clone());
                let part = build_text_part_with_id(&session_id, &message_id, &part_id, &final_text);
                upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &part));
                let _ = state
                    .opencode
                    .update_runtime(&session_id, |runtime| {
                        runtime
                            .text_by_message
                            .insert(message_id.clone(), final_text.clone());
                        runtime
                            .part_id_by_message
                            .insert(message_id.clone(), part_id.clone());
                    })
                    .await;
            }
        }
    }

    for part in item.content.iter() {
        match part {
            ContentPart::Reasoning { text, .. } => {
                let part_id = next_id("part_", &PART_COUNTER);
                let reasoning_part =
                    build_reasoning_part(&session_id, &message_id, &part_id, text, now);
                upsert_message_part(
                    &state.opencode,
                    &session_id,
                    &message_id,
                    reasoning_part.clone(),
                )
                .await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &reasoning_part));
            }
            ContentPart::ToolCall {
                name,
                arguments,
                call_id,
            } => {
                let part_id = runtime
                    .tool_part_by_call
                    .entry(call_id.clone())
                    .or_insert_with(|| next_id("part_", &PART_COUNTER))
                    .clone();
                let input_value = tool_input_from_arguments(Some(arguments.as_str()));
                let state_value = json!({
                    "status": "pending",
                    "input": input_value,
                    "raw": arguments,
                });
                let tool_part = build_tool_part(
                    &session_id,
                    &message_id,
                    &part_id,
                    call_id,
                    name,
                    state_value,
                );
                upsert_message_part(&state.opencode, &session_id, &message_id, tool_part.clone())
                    .await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &tool_part));
                let _ = state
                    .opencode
                    .update_runtime(&session_id, |runtime| {
                        runtime
                            .tool_part_by_call
                            .insert(call_id.clone(), part_id.clone());
                        runtime
                            .tool_message_by_call
                            .insert(call_id.clone(), message_id.clone());
                        runtime
                            .tool_name_by_call
                            .insert(call_id.clone(), name.clone());
                        runtime
                            .tool_args_by_call
                            .insert(call_id.clone(), arguments.clone());
                        runtime.open_tool_calls.insert(call_id.clone());
                        // Start a new text segment after tool activity.
                        runtime.part_id_by_message.remove(&message_id);
                        runtime.text_by_message.remove(&message_id);
                    })
                    .await;
            }
            ContentPart::ToolResult { call_id, output } => {
                let part_id = runtime
                    .tool_part_by_call
                    .entry(call_id.clone())
                    .or_insert_with(|| next_id("part_", &PART_COUNTER))
                    .clone();
                // Resolve tool name from stored ToolCall data
                let tool_name = runtime
                    .tool_name_by_call
                    .get(call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                // Resolve input from stored ToolCall arguments
                let input_value = runtime
                    .tool_args_by_call
                    .get(call_id)
                    .and_then(|args| {
                        tool_input_from_arguments(Some(args.as_str()))
                            .as_object()
                            .cloned()
                    })
                    .map(Value::Object)
                    .unwrap_or_else(|| json!({}));
                let state_value = json!({
                    "status": "completed",
                    "input": input_value,
                    "output": output,
                    "title": "Tool result",
                    "metadata": {},
                    "time": {"start": now, "end": now},
                    "attachments": [],
                });
                let tool_part = build_tool_part(
                    &session_id,
                    &message_id,
                    &part_id,
                    call_id,
                    &tool_name,
                    state_value,
                );
                upsert_message_part(&state.opencode, &session_id, &message_id, tool_part.clone())
                    .await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &tool_part));
                let _ = state
                    .opencode
                    .update_runtime(&session_id, |runtime| {
                        runtime
                            .tool_part_by_call
                            .insert(call_id.clone(), part_id.clone());
                        runtime
                            .tool_message_by_call
                            .insert(call_id.clone(), message_id.clone());
                        runtime.open_tool_calls.remove(call_id);
                        // Start a new text segment after tool activity.
                        runtime.part_id_by_message.remove(&message_id);
                        runtime.text_by_message.remove(&message_id);
                    })
                    .await;
            }
            ContentPart::FileRef { path, action, diff } => {
                let mime = match action {
                    FileAction::Patch => "text/x-diff",
                    _ => "text/plain",
                };
                let part = build_file_part_from_path(
                    &session_id,
                    &message_id,
                    path,
                    mime,
                    diff.as_deref(),
                );
                upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &part));
                if matches!(action, FileAction::Write | FileAction::Patch) {
                    emit_file_edited(&state.opencode, path);
                }
            }
            ContentPart::Image { path, mime } => {
                let mime = mime.as_deref().unwrap_or("image/png");
                let part = build_file_part_from_path(&session_id, &message_id, path, mime, None);
                upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &part));
            }
            _ => {}
        }
    }
}

async fn apply_tool_item_event(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    item: UniversalItem,
) {
    let session_id = event.session_id.clone();
    let tool_info = extract_tool_content(&item.content);
    let call_id = match tool_info.call_id.clone() {
        Some(call_id) => call_id,
        None => return,
    };

    let item_id_key = if item.item_id.is_empty() {
        None
    } else {
        Some(item.item_id.clone())
    };
    let native_id_key = item.native_item_id.clone();
    let mut message_id: Option<String> = None;
    let mut parent_id: Option<String> = None;
    let runtime = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            parent_id = item
                .parent_id
                .as_ref()
                .and_then(|parent| runtime.message_id_for_item.get(parent).cloned())
                .or_else(|| runtime.last_user_message_id.clone());
            if let Some(existing) = item_id_key
                .clone()
                .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                .or_else(|| {
                    native_id_key
                        .clone()
                        .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                })
                .or_else(|| runtime.tool_message_by_call.get(&call_id).cloned())
                .or_else(|| runtime.active_assistant_message_id.clone())
            {
                message_id = Some(existing);
            } else {
                let new_id =
                    unique_assistant_message_id(runtime, parent_id.as_ref(), event.sequence);
                message_id = Some(new_id);
            }
            if let Some(id) = message_id.clone() {
                if let Some(item_key) = item_id_key.clone() {
                    runtime.message_id_for_item.insert(item_key, id.clone());
                }
                if let Some(native_key) = native_id_key.clone() {
                    runtime.message_id_for_item.insert(native_key, id.clone());
                }
                runtime
                    .tool_message_by_call
                    .insert(call_id.clone(), id.clone());
            }
        })
        .await;

    let message_id = message_id.unwrap_or_else(|| {
        unique_assistant_message_id(&runtime, parent_id.as_ref(), event.sequence)
    });
    let parent_id = parent_id.or_else(|| runtime.last_user_message_id.clone());
    let agent = runtime
        .last_agent
        .clone()
        .unwrap_or_else(|| default_agent_mode().to_string());
    let provider_id = runtime
        .last_model_provider
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_PROVIDER_ID.to_string());
    let model_id = runtime
        .last_model_id
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_MODEL_ID.to_string());
    let directory = session_directory(&state.opencode, &session_id).await;
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();

    let info = build_assistant_message(
        &session_id,
        &message_id,
        parent_id.as_deref().unwrap_or(""),
        now,
        &directory,
        &worktree,
        &agent,
        &provider_id,
        &model_id,
    );
    upsert_message_info(&state.opencode, &session_id, info.clone()).await;
    state
        .opencode
        .emit_event(message_event("message.updated", &info));

    let mut attachments = Vec::new();
    if item.kind == ItemKind::ToolResult && event.event_type == UniversalEventType::ItemCompleted {
        for (path, action, diff) in tool_info.file_refs.iter() {
            let mime = match action {
                FileAction::Patch => "text/x-diff",
                _ => "text/plain",
            };
            let part =
                build_file_part_from_path(&session_id, &message_id, path, mime, diff.as_deref());
            upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
            state
                .opencode
                .emit_event(part_event("message.part.updated", &part));
            attachments.push(part.clone());
            if matches!(action, FileAction::Write | FileAction::Patch) {
                emit_file_edited(&state.opencode, path);
            }
        }
    }

    let part_id = runtime
        .tool_part_by_call
        .get(&call_id)
        .cloned()
        .unwrap_or_else(|| next_id("part_", &PART_COUNTER));
    // Resolve tool name: prefer current event's data, fall back to stored value from ToolCall
    let tool_name = tool_info
        .tool_name
        .clone()
        .or_else(|| runtime.tool_name_by_call.get(&call_id).cloned())
        .unwrap_or_else(|| "tool".to_string());
    // Resolve arguments: prefer current event's data, fall back to stored value from ToolCall
    let effective_arguments = tool_info
        .arguments
        .clone()
        .or_else(|| runtime.tool_args_by_call.get(&call_id).cloned());
    let input_value = tool_input_from_arguments(effective_arguments.as_deref());
    let raw_args = effective_arguments.clone().unwrap_or_default();
    let output_value = tool_info
        .output
        .clone()
        .or_else(|| extract_text_from_content(&item.content));

    let state_value = match event.event_type {
        UniversalEventType::ItemStarted => {
            if item.kind == ItemKind::ToolResult {
                json!({
                    "status": "running",
                    "input": input_value,
                    "time": {"start": now}
                })
            } else {
                json!({
                    "status": "pending",
                    "input": input_value,
                    "raw": raw_args,
                })
            }
        }
        UniversalEventType::ItemCompleted => {
            if item.kind == ItemKind::ToolResult {
                if matches!(item.status, ItemStatus::Failed) {
                    json!({
                        "status": "error",
                        "input": input_value,
                        "output": output_value.unwrap_or_else(|| "Tool failed".to_string()),
                        "metadata": {},
                        "time": {"start": now, "end": now},
                    })
                } else {
                    json!({
                        "status": "completed",
                        "input": input_value,
                        "output": output_value.unwrap_or_default(),
                        "title": "Tool result",
                        "metadata": {},
                        "time": {"start": now, "end": now},
                        "attachments": attachments,
                    })
                }
            } else {
                json!({
                    "status": "running",
                    "input": input_value,
                    "time": {"start": now},
                })
            }
        }
        _ => json!({
            "status": "pending",
            "input": input_value,
            "raw": raw_args,
        }),
    };

    let tool_part = build_tool_part(
        &session_id,
        &message_id,
        &part_id,
        &call_id,
        &tool_name,
        state_value,
    );
    upsert_message_part(&state.opencode, &session_id, &message_id, tool_part.clone()).await;
    state
        .opencode
        .emit_event(part_event("message.part.updated", &tool_part));

    let _ = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            runtime
                .tool_part_by_call
                .insert(call_id.clone(), part_id.clone());
            runtime
                .tool_message_by_call
                .insert(call_id.clone(), message_id.clone());
            // Persist tool name and arguments from ToolCall for later ToolResult events
            if let Some(name) = tool_info.tool_name.as_ref() {
                runtime
                    .tool_name_by_call
                    .insert(call_id.clone(), name.clone());
            }
            if let Some(args) = tool_info.arguments.as_ref() {
                runtime
                    .tool_args_by_call
                    .insert(call_id.clone(), args.clone());
            }
            if item.kind == ItemKind::ToolCall {
                runtime.open_tool_calls.insert(call_id.clone());
            }
            if item.kind == ItemKind::ToolResult
                && event.event_type == UniversalEventType::ItemCompleted
            {
                runtime.open_tool_calls.remove(&call_id);
            }
            // Start a new text segment after tool activity.
            runtime.part_id_by_message.remove(&message_id);
            runtime.text_by_message.remove(&message_id);
        })
        .await;
}

async fn apply_item_delta(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    item_id: String,
    native_item_id: Option<String>,
    delta: String,
) {
    let session_id = event.session_id.clone();
    let item_id_key = if item_id.is_empty() {
        None
    } else {
        Some(item_id)
    };
    let native_id_key = native_item_id;
    let mut message_id: Option<String> = None;
    let mut parent_id: Option<String> = None;
    let mut is_user_delta = false;
    let mut suppress_non_text_delta = false;
    let runtime = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            if item_delta_is_non_text(runtime, item_id_key.as_deref(), native_id_key.as_deref()) {
                suppress_non_text_delta = true;
                return;
            }
            let is_user_from_runtime = item_id_key
                .as_ref()
                .is_some_and(|value| runtime.user_item_ids.contains(value))
                || native_id_key
                    .as_ref()
                    .is_some_and(|value| runtime.user_item_ids.contains(value));
            let is_user_from_prefix = item_id_key
                .as_ref()
                .map(|value| value.starts_with("user_"))
                .unwrap_or(false)
                || native_id_key
                    .as_ref()
                    .map(|value| value.starts_with("user_"))
                    .unwrap_or(false);
            if is_user_from_runtime || is_user_from_prefix {
                is_user_delta = true;
                return;
            }
            parent_id = runtime.last_user_message_id.clone();
            if let Some(existing) = item_id_key
                .clone()
                .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                .or_else(|| {
                    native_id_key
                        .clone()
                        .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                })
                .or_else(|| runtime.active_assistant_message_id.clone())
            {
                message_id = Some(existing);
            } else {
                let new_id =
                    unique_assistant_message_id(runtime, parent_id.as_ref(), event.sequence);
                message_id = Some(new_id);
            }
            if let Some(id) = message_id.clone() {
                if let Some(item_key) = item_id_key.clone() {
                    runtime.message_id_for_item.insert(item_key, id.clone());
                }
                if let Some(native_key) = native_id_key.clone() {
                    runtime.message_id_for_item.insert(native_key, id.clone());
                }
            }
        })
        .await;
    if is_user_delta || suppress_non_text_delta {
        return;
    }
    let message_id = message_id.unwrap_or_else(|| {
        unique_assistant_message_id(&runtime, parent_id.as_ref(), event.sequence)
    });
    let parent_id = parent_id.or_else(|| runtime.last_user_message_id.clone());
    let directory = session_directory(&state.opencode, &session_id).await;
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    let agent = runtime
        .last_agent
        .clone()
        .unwrap_or_else(|| default_agent_mode().to_string());
    let provider_id = runtime
        .last_model_provider
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_PROVIDER_ID.to_string());
    let model_id = runtime
        .last_model_id
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_MODEL_ID.to_string());
    let info = build_assistant_message(
        &session_id,
        &message_id,
        parent_id.as_deref().unwrap_or(""),
        now,
        &directory,
        &worktree,
        &agent,
        &provider_id,
        &model_id,
    );
    upsert_message_info(&state.opencode, &session_id, info.clone()).await;
    state
        .opencode
        .emit_event(message_event("message.updated", &info));
    let mut text = runtime
        .text_by_message
        .get(&message_id)
        .cloned()
        .unwrap_or_default();
    text.push_str(&delta);
    let part_id = runtime
        .part_id_by_message
        .get(&message_id)
        .cloned()
        .unwrap_or_else(|| next_id("part_", &PART_COUNTER));
    let part = build_text_part_with_id(&session_id, &message_id, &part_id, &text);
    upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
    state.opencode.emit_event(part_event_with_delta(
        "message.part.updated",
        &part,
        Some(&delta),
    ));
    let _ = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            runtime.text_by_message.insert(message_id.clone(), text);
            runtime
                .part_id_by_message
                .insert(message_id.clone(), part_id.clone());
            runtime.messages_with_text_deltas.insert(message_id.clone());
        })
        .await;
}

/// Build OpenCode-compatible router.
pub fn build_opencode_router(state: Arc<OpenCodeAppState>) -> Router {
    Router::new()
        // Core metadata
        .route("/agent", get(oc_agent_list))
        .route("/command", get(oc_command_list))
        .route("/config", get(oc_config_get).patch(oc_config_patch))
        .route("/config/providers", get(oc_config_providers))
        .route("/event", get(oc_event_subscribe))
        .route("/global/event", get(oc_global_event))
        .route("/global/health", get(oc_global_health))
        .route(
            "/global/config",
            get(oc_global_config_get).patch(oc_global_config_patch),
        )
        .route("/global/dispose", post(oc_global_dispose))
        .route("/instance/dispose", post(oc_instance_dispose))
        .route("/log", post(oc_log))
        .route("/lsp", get(oc_lsp_status))
        .route("/formatter", get(oc_formatter_status))
        .route("/path", get(oc_path))
        .route("/vcs", get(oc_vcs))
        .route("/project", get(oc_project_list))
        .route("/project/current", get(oc_project_current))
        .route("/project/:projectID", patch(oc_project_update))
        // Sessions
        .route("/session", post(oc_session_create).get(oc_session_list))
        .route("/session/status", get(oc_session_status))
        .route(
            "/session/:sessionID",
            get(oc_session_get)
                .patch(oc_session_update)
                .delete(oc_session_delete),
        )
        .route("/session/:sessionID/abort", post(oc_session_abort))
        .route("/session/:sessionID/children", get(oc_session_children))
        .route("/session/:sessionID/init", post(oc_session_init))
        .route("/session/:sessionID/fork", post(oc_session_fork))
        .route("/session/:sessionID/diff", get(oc_session_diff))
        .route("/session/:sessionID/summarize", post(oc_session_summarize))
        .route(
            "/session/:sessionID/message",
            post(oc_session_message_create).get(oc_session_messages),
        )
        .route(
            "/session/:sessionID/message/:messageID",
            get(oc_session_message_get),
        )
        .route(
            "/session/:sessionID/message/:messageID/part/:partID",
            patch(oc_message_part_update).delete(oc_message_part_delete),
        )
        .route(
            "/session/:sessionID/prompt_async",
            post(oc_session_prompt_async),
        )
        .route("/session/:sessionID/command", post(oc_session_command))
        .route("/session/:sessionID/shell", post(oc_session_shell))
        .route("/session/:sessionID/revert", post(oc_session_revert))
        .route("/session/:sessionID/unrevert", post(oc_session_unrevert))
        .route(
            "/session/:sessionID/permissions/:permissionID",
            post(oc_session_permission_reply),
        )
        .route(
            "/session/:sessionID/share",
            post(oc_session_share).delete(oc_session_unshare),
        )
        .route("/session/:sessionID/todo", get(oc_session_todo))
        // Permissions + questions (global)
        .route("/permission", get(oc_permission_list))
        .route("/permission/:requestID/reply", post(oc_permission_reply))
        .route("/question", get(oc_question_list))
        .route("/question/:requestID/reply", post(oc_question_reply))
        .route("/question/:requestID/reject", post(oc_question_reject))
        // Providers
        .route("/provider", get(oc_provider_list))
        .route("/provider/auth", get(oc_provider_auth))
        .route(
            "/provider/:providerID/oauth/authorize",
            post(oc_provider_oauth_authorize),
        )
        .route(
            "/provider/:providerID/oauth/callback",
            post(oc_provider_oauth_callback),
        )
        // Auth
        .route("/auth/:providerID", put(oc_auth_set).delete(oc_auth_remove))
        // PTY
        .route("/pty", get(oc_pty_list).post(oc_pty_create))
        .route(
            "/pty/:ptyID",
            get(oc_pty_get).put(oc_pty_update).delete(oc_pty_delete),
        )
        .route("/pty/:ptyID/connect", get(oc_pty_connect))
        // Files
        .route("/file", get(oc_file_list))
        .route("/file/content", get(oc_file_content))
        .route("/file/status", get(oc_file_status))
        // Find
        .route("/find", get(oc_find_text))
        .route("/find/file", get(oc_find_files))
        .route("/find/symbol", get(oc_find_symbols))
        // MCP
        .route("/mcp", get(oc_mcp_list).post(oc_mcp_register))
        .route(
            "/mcp/:name/auth",
            post(oc_mcp_auth).delete(oc_mcp_auth_remove),
        )
        .route("/mcp/:name/auth/callback", post(oc_mcp_auth_callback))
        .route("/mcp/:name/auth/authenticate", post(oc_mcp_authenticate))
        .route("/mcp/:name/connect", post(oc_mcp_connect))
        .route("/mcp/:name/disconnect", post(oc_mcp_disconnect))
        // Experimental
        .route("/experimental/tool/ids", get(oc_tool_ids))
        .route("/experimental/tool", get(oc_tool_list))
        .route("/experimental/resource", get(oc_resource_list))
        .route(
            "/experimental/worktree",
            get(oc_worktree_list)
                .post(oc_worktree_create)
                .delete(oc_worktree_delete),
        )
        .route("/experimental/worktree/reset", post(oc_worktree_reset))
        // Skills
        .route("/skill", get(oc_skill_list))
        // TUI
        .route("/tui/control/next", get(oc_tui_next))
        .route("/tui/control/response", post(oc_tui_response))
        .route("/tui/append-prompt", post(oc_tui_append_prompt))
        .route("/tui/open-help", post(oc_tui_open_help))
        .route("/tui/open-sessions", post(oc_tui_open_sessions))
        .route("/tui/open-themes", post(oc_tui_open_themes))
        .route("/tui/open-models", post(oc_tui_open_models))
        .route("/tui/submit-prompt", post(oc_tui_submit_prompt))
        .route("/tui/clear-prompt", post(oc_tui_clear_prompt))
        .route("/tui/execute-command", post(oc_tui_execute_command))
        .route("/tui/show-toast", post(oc_tui_show_toast))
        .route("/tui/publish", post(oc_tui_publish))
        .route("/tui/select-session", post(oc_tui_select_session))
        .with_state(state)
}

// ===================================================================================
// Handler implementations
// ===================================================================================

#[utoipa::path(
    get,
    path = "/agent",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_agent_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let name = state.inner.branding.product_name();
    let agent = json!({
        "name": name,
        "description": format!("{name} compatibility layer"),
        "mode": "all",
        "native": false,
        "hidden": false,
        "permission": [],
        "options": {},
    });
    (StatusCode::OK, Json(json!([agent])))
}

#[utoipa::path(
    get,
    path = "/command",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_command_list(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) =
        proxy_native_opencode(&state, reqwest::Method::GET, "/command", &headers, None).await
    {
        return response;
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

#[utoipa::path(
    get,
    path = "/config",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_config_get(State(state): State<Arc<OpenCodeAppState>>, headers: HeaderMap) -> Response {
    if let Some(response) =
        proxy_native_opencode(&state, reqwest::Method::GET, "/config", &headers, None).await
    {
        return response;
    }
    (StatusCode::OK, Json(json!({}))).into_response()
}

#[utoipa::path(
    patch,
    path = "/config",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_config_patch(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::PATCH,
        "/config",
        &headers,
        Some(body.clone()),
    )
    .await
    {
        return response;
    }
    (StatusCode::OK, Json(body)).into_response()
}

#[utoipa::path(
    get,
    path = "/config/providers",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_config_providers(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let cache = opencode_model_cache(&state).await;
    let mut grouped: BTreeMap<String, Vec<&OpenCodeModelEntry>> = BTreeMap::new();
    for entry in &cache.entries {
        grouped
            .entry(entry.group_id.clone())
            .or_default()
            .push(entry);
    }
    let mut providers = Vec::new();
    let mut defaults = serde_json::Map::new();
    for (group_id, entries) in grouped {
        let mut models = serde_json::Map::new();
        for entry in entries {
            models.insert(entry.model.id.clone(), model_config_entry(entry));
        }
        let name = cache
            .group_names
            .get(&group_id)
            .cloned()
            .unwrap_or_else(|| group_id.clone());
        providers.push(json!({
            "id": group_id,
            "name": name,
            "source": "custom",
            "env": [],
            "key": "",
            "options": {},
            "models": Value::Object(models),
        }));
        if let Some(default_model) = cache.group_defaults.get(&group_id) {
            defaults.insert(group_id, Value::String(default_model.clone()));
        }
    }
    let providers = json!({
        "providers": providers,
        "default": Value::Object(defaults),
    });
    (StatusCode::OK, Json(providers))
}

fn parse_last_event_id(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

#[utoipa::path(
    get,
    path = "/event",
    responses((status = 200, description = "SSE event stream")),
    tag = "opencode"
)]
async fn oc_event_subscribe(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let last_event_id = parse_last_event_id(&headers);
    let receiver = state.opencode.subscribe();
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let branch = state.opencode.branch_name();
    state.opencode.emit_event(json!({
        "type": "server.connected",
        "properties": {}
    }));
    state.opencode.emit_event(json!({
        "type": "worktree.ready",
        "properties": {
            "name": directory,
            "branch": branch,
        }
    }));
    let replay_events = state.opencode.buffered_events_after(last_event_id);
    let replay_cursor = replay_events
        .last()
        .map(|event| event.id)
        .or(last_event_id)
        .unwrap_or(0);

    let heartbeat_payload = json!({
        "type": "server.heartbeat",
        "properties": {}
    });
    let stream = stream::unfold(
        (
            receiver,
            interval(std::time::Duration::from_secs(30)),
            VecDeque::from(replay_events),
            replay_cursor,
        ),
        move |(mut rx, mut ticker, mut replay, replay_cursor)| {
            let heartbeat = heartbeat_payload.clone();
            async move {
                if let Some(event) = replay.pop_front() {
                    let sse_event = Event::default()
                        .id(event.id.to_string())
                        .json_data(&event.payload)
                        .unwrap_or_else(|_| Event::default().data("{}"));
                    return Some((Ok(sse_event), (rx, ticker, replay, replay_cursor)));
                }

                loop {
                    tokio::select! {
                        _ = ticker.tick() => {
                            let sse_event = Event::default()
                                .json_data(&heartbeat)
                                .unwrap_or_else(|_| Event::default().data("{}"));
                            return Some((Ok(sse_event), (rx, ticker, replay, replay_cursor)));
                        }
                        event = rx.recv() => {
                            match event {
                                Ok(event) => {
                                    if event.id <= replay_cursor {
                                        continue;
                                    }
                                    let sse_event = Event::default()
                                        .id(event.id.to_string())
                                        .json_data(&event.payload)
                                        .unwrap_or_else(|_| Event::default().data("{}"));
                                    return Some((Ok(sse_event), (rx, ticker, replay, replay_cursor)));
                                }
                                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                    warn!(skipped, "opencode event stream lagged");
                                    return Some((Ok(Event::default().comment("lagged")), (rx, ticker, replay, replay_cursor)));
                                }
                                Err(broadcast::error::RecvError::Closed) => return None,
                            }
                        }
                    }
                }
            }
        },
    );

    Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
}

#[utoipa::path(
    get,
    path = "/global/event",
    responses((status = 200, description = "SSE event stream")),
    tag = "opencode"
)]
async fn oc_global_event(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let last_event_id = parse_last_event_id(&headers);
    let receiver = state.opencode.subscribe();
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let branch = state.opencode.branch_name();
    state.opencode.emit_event(json!({
        "type": "server.connected",
        "properties": {}
    }));
    state.opencode.emit_event(json!({
        "type": "worktree.ready",
        "properties": {
            "name": directory.clone(),
            "branch": branch,
        }
    }));
    let replay_events = state.opencode.buffered_events_after(last_event_id);
    let replay_cursor = replay_events
        .last()
        .map(|event| event.id)
        .or(last_event_id)
        .unwrap_or(0);

    let heartbeat_payload = json!({
        "payload": {
            "type": "server.heartbeat",
            "properties": {}
        }
    });
    let stream = stream::unfold(
        (
            receiver,
            interval(std::time::Duration::from_secs(30)),
            VecDeque::from(replay_events),
            replay_cursor,
        ),
        move |(mut rx, mut ticker, mut replay, replay_cursor)| {
            let directory = directory.clone();
            let heartbeat = heartbeat_payload.clone();
            async move {
                if let Some(event) = replay.pop_front() {
                    let payload = json!({"directory": directory, "payload": event.payload});
                    let sse_event = Event::default()
                        .id(event.id.to_string())
                        .json_data(&payload)
                        .unwrap_or_else(|_| Event::default().data("{}"));
                    return Some((Ok(sse_event), (rx, ticker, replay, replay_cursor)));
                }

                loop {
                    tokio::select! {
                        _ = ticker.tick() => {
                            let sse_event = Event::default()
                                .json_data(&heartbeat)
                                .unwrap_or_else(|_| Event::default().data("{}"));
                            return Some((Ok(sse_event), (rx, ticker, replay, replay_cursor)));
                        }
                        event = rx.recv() => {
                            match event {
                                Ok(event) => {
                                    if event.id <= replay_cursor {
                                        continue;
                                    }
                                    let payload = json!({"directory": directory, "payload": event.payload});
                                    let sse_event = Event::default()
                                        .id(event.id.to_string())
                                        .json_data(&payload)
                                        .unwrap_or_else(|_| Event::default().data("{}"));
                                    return Some((Ok(sse_event), (rx, ticker, replay, replay_cursor)));
                                }
                                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                    warn!(skipped, "opencode global event stream lagged");
                                    return Some((Ok(Event::default().comment("lagged")), (rx, ticker, replay, replay_cursor)));
                                }
                                Err(broadcast::error::RecvError::Closed) => return None,
                            }
                        }
                    }
                }
            }
        },
    );

    Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
}

#[utoipa::path(
    get,
    path = "/global/health",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_global_health() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "healthy": true,
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
}

#[utoipa::path(
    get,
    path = "/global/config",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_global_config_get(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::GET,
        "/global/config",
        &headers,
        None,
    )
    .await
    {
        return response;
    }
    (StatusCode::OK, Json(json!({}))).into_response()
}

#[utoipa::path(
    patch,
    path = "/global/config",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_global_config_patch(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::PATCH,
        "/global/config",
        &headers,
        Some(body.clone()),
    )
    .await
    {
        return response;
    }
    (StatusCode::OK, Json(body)).into_response()
}

#[utoipa::path(
    post,
    path = "/global/dispose",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_global_dispose() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/instance/dispose",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_instance_dispose() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/log",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_log() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/lsp",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_lsp_status() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/formatter",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_formatter_status() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/path",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_path(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    (
        StatusCode::OK,
        Json(json!({
            "home": state.opencode.home_dir(),
            "state": state.opencode.state_dir(),
            "config": state.opencode.config_dir(),
            "worktree": worktree,
            "directory": directory,
        })),
    )
}

#[utoipa::path(
    get,
    path = "/vcs",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_vcs(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "branch": state.opencode.branch_name(),
        })),
    )
}

#[utoipa::path(
    get,
    path = "/project",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_project_list(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    let project = json!({
        "id": state.opencode.default_project_id.clone(),
        "worktree": worktree,
        "vcs": "git",
        "name": "sandbox-agent",
        "time": {"created": now, "updated": now},
        "sandboxes": [],
    });
    (StatusCode::OK, Json(json!([project])))
}

#[utoipa::path(
    get,
    path = "/project/current",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_project_current(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    (
        StatusCode::OK,
        Json(json!({
            "id": state.opencode.default_project_id.clone(),
            "worktree": worktree,
            "vcs": "git",
            "name": "sandbox-agent",
            "time": {"created": now, "updated": now},
            "sandboxes": [],
        })),
    )
}

#[utoipa::path(
    patch,
    path = "/project/{projectID}",
    params(("projectID" = String, Path, description = "Project ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_project_update(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(_project_id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    oc_project_current(State(state), headers).await
}

#[utoipa::path(
    post,
    path = "/session",
    request_body = OpenCodeCreateSessionRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_create(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    body: Option<Json<OpenCodeCreateSessionRequest>>,
) -> impl IntoResponse {
    let body = body.map(|j| j.0).unwrap_or(OpenCodeCreateSessionRequest {
        title: None,
        parent_id: None,
        permission: None,
        permission_mode: None,
        model: None,
        provider_id: None,
        model_id: None,
        variant: None,
    });
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let now = state.opencode.now_ms();
    let id = next_id("ses_", &SESSION_COUNTER);
    let slug = format!("session-{}", id);
    let title = body.title.unwrap_or_else(|| format!("Session {}", id));
    let permission_mode = body.permission_mode.clone();
    let requested_provider = body
        .model
        .as_ref()
        .and_then(|v| v.get("providerID"))
        .and_then(|v| v.as_str())
        .or(body.provider_id.as_deref());
    let requested_model = body
        .model
        .as_ref()
        .and_then(|v| v.get("modelID"))
        .and_then(|v| v.as_str())
        .or(body.model_id.as_deref());
    let record = OpenCodeSessionRecord {
        id: id.clone(),
        slug,
        project_id: state.opencode.default_project_id.clone(),
        directory,
        parent_id: body.parent_id,
        title,
        version: "0".to_string(),
        created_at: now,
        updated_at: now,
        share_url: None,
        permission_mode: permission_mode.clone(),
    };

    let session_value = record.to_value();

    let mut sessions = state.opencode.sessions.lock().await;
    sessions.insert(id.clone(), record);
    drop(sessions);

    let (session_agent, provider_id, model_id) =
        resolve_session_agent(&state, &id, requested_provider, requested_model).await;
    let session_agent_id = AgentId::parse(&session_agent).unwrap_or_else(default_agent_id);
    let backing_model = backing_model_for_agent(session_agent_id, &provider_id, &model_id);
    let backing_variant = body.variant.clone();
    if let Err(err) = ensure_backing_session(
        &state,
        &id,
        &session_agent,
        backing_model,
        backing_variant,
        permission_mode,
    )
    .await
    {
        let mut sessions = state.opencode.sessions.lock().await;
        sessions.remove(&id);
        drop(sessions);
        return sandbox_error_response(err).into_response();
    }

    state
        .opencode
        .emit_event(session_event("session.created", &session_value));

    (StatusCode::OK, Json(session_value)).into_response()
}

#[utoipa::path(
    get,
    path = "/session",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let sessions = state.inner.session_manager().list_sessions().await;
    let project_id = &state.opencode.default_project_id;
    let mut values: Vec<Value> = sessions
        .iter()
        .map(|s| session_info_to_opencode_value(s, project_id))
        .collect();
    let mut seen_session_ids: HashSet<String> = sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    let compat_sessions = state.opencode.sessions.lock().await;
    for (session_id, session) in compat_sessions.iter() {
        if seen_session_ids.insert(session_id.clone()) {
            values.push(session.to_value());
        }
    }
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_session_get(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    _headers: HeaderMap,
    _query: Query<DirectoryQuery>,
) -> impl IntoResponse {
    let project_id = &state.opencode.default_project_id;
    if let Some(info) = state
        .inner
        .session_manager()
        .get_session_info(&session_id)
        .await
    {
        return (
            StatusCode::OK,
            Json(session_info_to_opencode_value(&info, project_id)),
        )
            .into_response();
    }
    let sessions = state.opencode.sessions.lock().await;
    if let Some(session) = sessions.get(&session_id) {
        return (StatusCode::OK, Json(session.to_value())).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    patch,
    path = "/session/{sessionID}",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = OpenCodeUpdateSessionRequest,
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_session_update(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<OpenCodeUpdateSessionRequest>,
) -> impl IntoResponse {
    let mut sessions = state.opencode.sessions.lock().await;
    if let Some(session) = sessions.get_mut(&session_id) {
        if update_requests_model_change(&body) {
            return bad_request(OPENCODE_MODEL_CHANGE_AFTER_SESSION_CREATE_ERROR).into_response();
        }
        if let Some(title) = body.title {
            if let Err(err) = state
                .inner
                .session_manager()
                .set_session_title(&session_id, title.clone())
                .await
            {
                return sandbox_error_response(err).into_response();
            }
            session.title = title;
            session.updated_at = state.opencode.now_ms();
        }
        let value = session.to_value();
        state
            .opencode
            .emit_event(session_event("session.updated", &value));
        return (StatusCode::OK, Json(value)).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    delete,
    path = "/session/{sessionID}",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_session_delete(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let mut sessions = state.opencode.sessions.lock().await;
    if let Some(session) = sessions.remove(&session_id) {
        drop(sessions);
        if let Err(err) = state
            .inner
            .session_manager()
            .delete_session(&session_id)
            .await
        {
            return sandbox_error_response(err).into_response();
        }
        state
            .opencode
            .emit_event(session_event("session.deleted", &session.to_value()));
        return bool_ok(true).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    get,
    path = "/session/status",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_status(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let sessions = state.inner.session_manager().list_sessions().await;
    let runtimes = state.opencode.session_runtime.lock().await;
    let mut status_map = serde_json::Map::new();
    for s in &sessions {
        let status = if runtimes
            .get(&s.session_id)
            .map(|runtime| runtime.turn_in_progress)
            .unwrap_or(false)
        {
            "busy"
        } else {
            "idle"
        };
        status_map.insert(s.session_id.clone(), json!({"type": status}));
    }
    (StatusCode::OK, Json(Value::Object(status_map)))
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/abort",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_abort(
    State(_state): State<Arc<OpenCodeAppState>>,
    Path(_session_id): Path<String>,
) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/children",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_children() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/init",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionInitRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_init(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    body: Option<Json<SessionInitRequest>>,
) -> impl IntoResponse {
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let _ = state.opencode.ensure_session(&session_id, directory).await;
    let body = body.map(|json| json.0).unwrap_or(SessionInitRequest {
        provider_id: None,
        model_id: None,
        message_id: None,
    });
    let requested_provider = body
        .provider_id
        .as_deref()
        .filter(|value| !value.is_empty());
    let requested_model = body.model_id.as_deref().filter(|value| !value.is_empty());
    if requested_provider.is_none() && requested_model.is_none() {
        return bool_ok(true).into_response();
    }
    if requested_provider.is_none() || requested_model.is_none() {
        return bad_request("providerID and modelID are required when selecting a model")
            .into_response();
    }
    let (session_agent, provider_id, model_id) =
        resolve_session_agent(&state, &session_id, requested_provider, requested_model).await;
    let session_agent_id = AgentId::parse(&session_agent).unwrap_or_else(default_agent_id);
    let backing_model = backing_model_for_agent(session_agent_id, &provider_id, &model_id);
    let session_permission_mode = {
        let sessions = state.opencode.sessions.lock().await;
        sessions
            .get(&session_id)
            .and_then(|s| s.permission_mode.clone())
    };
    if let Err(err) = ensure_backing_session(
        &state,
        &session_id,
        &session_agent,
        backing_model,
        None,
        session_permission_mode,
    )
    .await
    {
        return sandbox_error_response(err).into_response();
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/fork",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_fork(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let now = state.opencode.now_ms();
    let id = next_id("ses_", &SESSION_COUNTER);
    let slug = format!("session-{}", id);
    let title = format!("Fork of {}", session_id);
    let parent_permission_mode = {
        let sessions = state.opencode.sessions.lock().await;
        sessions
            .get(&session_id)
            .and_then(|s| s.permission_mode.clone())
    };
    let record = OpenCodeSessionRecord {
        id: id.clone(),
        slug,
        project_id: state.opencode.default_project_id.clone(),
        directory,
        parent_id: Some(session_id),
        title,
        version: "0".to_string(),
        created_at: now,
        updated_at: now,
        share_url: None,
        permission_mode: parent_permission_mode,
    };

    let value = record.to_value();
    let mut sessions = state.opencode.sessions.lock().await;
    sessions.insert(id.clone(), record);
    drop(sessions);

    state
        .opencode
        .emit_event(session_event("session.created", &value));

    (StatusCode::OK, Json(value))
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/diff",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_diff() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/summarize",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionSummarizeRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_summarize(Json(body): Json<SessionSummarizeRequest>) -> impl IntoResponse {
    if body.provider_id.is_none() || body.model_id.is_none() {
        return bad_request("providerID and modelID are required");
    }
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/message",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_messages(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let messages = state.opencode.messages.lock().await;
    let entries = messages.get(&session_id).cloned().unwrap_or_default();
    let values: Vec<Value> = entries
        .into_iter()
        .map(|record| json!({"info": record.info, "parts": record.parts}))
        .collect();
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/message",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionMessageRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_message_create(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<SessionMessageRequest>,
) -> impl IntoResponse {
    if std::env::var("OPENCODE_COMPAT_LOG_BODY").is_ok() {
        tracing::info!(
            target = "sandbox_agent::opencode",
            ?body,
            "opencode prompt body"
        );
    }
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let _ = state
        .opencode
        .ensure_session(&session_id, directory.clone())
        .await;
    let worktree = state.opencode.worktree_for(&directory);
    let agent_mode = normalize_agent_mode(body.agent.clone());
    let requested_provider = body
        .model
        .as_ref()
        .and_then(|v| v.get("providerID"))
        .and_then(|v| v.as_str());
    let requested_model = body
        .model
        .as_ref()
        .and_then(|v| v.get("modelID"))
        .and_then(|v| v.as_str());
    let (session_agent, provider_id, model_id) =
        resolve_session_agent(&state, &session_id, requested_provider, requested_model).await;
    let session_agent_id = AgentId::parse(&session_agent).unwrap_or_else(default_agent_id);
    let backing_model = backing_model_for_agent(session_agent_id, &provider_id, &model_id);
    let backing_variant = body.variant.clone();

    let parts_input = body.parts.unwrap_or_default();
    if parts_input.is_empty() {
        return bad_request("parts are required").into_response();
    }

    let now = state.opencode.now_ms();
    let user_message_id = body
        .message_id
        .clone()
        .unwrap_or_else(|| next_id("msg_", &MESSAGE_COUNTER));

    let mut user_message = build_user_message(
        &session_id,
        &user_message_id,
        now,
        &agent_mode,
        &provider_id,
        &model_id,
    );
    if let Some(obj) = user_message.as_object_mut() {
        if let Some(time) = obj.get_mut("time").and_then(|v| v.as_object_mut()) {
            time.insert("completed".to_string(), json!(now));
        }
    }

    let parts: Vec<Value> = parts_input
        .iter()
        .map(|part| normalize_part(&session_id, &user_message_id, part))
        .collect();

    upsert_message_info(&state.opencode, &session_id, user_message.clone()).await;
    for part in &parts {
        upsert_message_part(&state.opencode, &session_id, &user_message_id, part.clone()).await;
    }

    state
        .opencode
        .emit_event(message_event("message.updated", &user_message));
    for part in &parts {
        state
            .opencode
            .emit_event(part_event("message.part.updated", part));
    }

    let _ = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            runtime.last_user_message_id = Some(user_message_id.clone());
            runtime.active_assistant_message_id = None;
            runtime.last_agent = Some(agent_mode.clone());
            runtime.last_model_provider = Some(provider_id.clone());
            runtime.last_model_id = Some(model_id.clone());
        })
        .await;

    let session_permission_mode = {
        let sessions = state.opencode.sessions.lock().await;
        sessions
            .get(&session_id)
            .and_then(|s| s.permission_mode.clone())
    };

    if let Err(err) = ensure_backing_session(
        &state,
        &session_id,
        &session_agent,
        backing_model,
        backing_variant,
        session_permission_mode,
    )
    .await
    {
        tracing::warn!(
            target = "sandbox_agent::opencode",
            ?err,
            "failed to ensure backing session"
        );
        emit_session_error(&state.opencode, &session_id, &err.to_string(), None, None);
        return sandbox_error_response(err).into_response();
    } else {
        ensure_session_stream(state.clone(), session_id.clone()).await;
    }

    let prompt_text = parts_input
        .iter()
        .find_map(|part| part.get("text").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    if !prompt_text.is_empty() {
        if let Err(err) = state
            .inner
            .session_manager()
            .send_message(session_id.clone(), prompt_text, Vec::new())
            .await
        {
            let mut should_emit_idle = false;
            let _ = state
                .opencode
                .update_runtime(&session_id, |runtime| {
                    should_emit_idle = runtime.turn_in_progress;
                    runtime.turn_in_progress = false;
                    runtime.active_assistant_message_id = None;
                    runtime.open_tool_calls.clear();
                })
                .await;
            tracing::warn!(
                target = "sandbox_agent::opencode",
                ?err,
                "failed to send message to backing agent"
            );
            emit_session_error(&state.opencode, &session_id, &err.to_string(), None, None);
            if should_emit_idle {
                emit_session_idle(&state.opencode, &session_id);
            }
            return sandbox_error_response(err).into_response();
        }
    }

    let assistant_message = build_assistant_message(
        &session_id,
        &format!("{user_message_id}_pending"),
        &user_message_id,
        now,
        &directory,
        &worktree,
        &agent_mode,
        &provider_id,
        &model_id,
    );

    (
        StatusCode::OK,
        Json(json!({
            "info": assistant_message,
            "parts": [],
        })),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/message/{messageID}",
    params(
        ("sessionID" = String, Path, description = "Session ID"),
        ("messageID" = String, Path, description = "Message ID")
    ),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_session_message_get(
    State(state): State<Arc<OpenCodeAppState>>,
    Path((session_id, message_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let messages = state.opencode.messages.lock().await;
    if let Some(entries) = messages.get(&session_id) {
        if let Some(record) = entries.iter().find(|record| {
            record
                .info
                .get("id")
                .and_then(|v| v.as_str())
                .map(|id| id == message_id)
                .unwrap_or(false)
        }) {
            return (
                StatusCode::OK,
                Json(json!({
                    "info": record.info.clone(),
                    "parts": record.parts.clone()
                })),
            )
                .into_response();
        }
    }
    not_found("Message not found").into_response()
}

#[utoipa::path(
    patch,
    path = "/session/{sessionID}/message/{messageID}/part/{partID}",
    params(
        ("sessionID" = String, Path, description = "Session ID"),
        ("messageID" = String, Path, description = "Message ID"),
        ("partID" = String, Path, description = "Part ID")
    ),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_message_part_update(
    State(state): State<Arc<OpenCodeAppState>>,
    Path((session_id, message_id, part_id)): Path<(String, String, String)>,
    Json(mut part_value): Json<Value>,
) -> impl IntoResponse {
    if let Some(obj) = part_value.as_object_mut() {
        obj.insert("id".to_string(), json!(part_id));
        obj.insert("sessionID".to_string(), json!(session_id));
        obj.insert("messageID".to_string(), json!(message_id));
    }

    state
        .opencode
        .emit_event(part_event("message.part.updated", &part_value));

    (StatusCode::OK, Json(part_value))
}

#[utoipa::path(
    delete,
    path = "/session/{sessionID}/message/{messageID}/part/{partID}",
    params(
        ("sessionID" = String, Path, description = "Session ID"),
        ("messageID" = String, Path, description = "Message ID"),
        ("partID" = String, Path, description = "Part ID")
    ),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_message_part_delete(
    State(state): State<Arc<OpenCodeAppState>>,
    Path((session_id, message_id, part_id)): Path<(String, String, String)>,
) -> impl IntoResponse {
    let part_value = json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "text",
        "text": "",
    });
    state
        .opencode
        .emit_event(part_event("message.part.removed", &part_value));
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/prompt_async",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionMessageRequest,
    responses((status = 204)),
    tag = "opencode"
)]
async fn oc_session_prompt_async(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<SessionMessageRequest>,
) -> impl IntoResponse {
    let _ = oc_session_message_create(
        State(state),
        Path(session_id),
        headers,
        Query(query),
        Json(body),
    )
    .await;
    StatusCode::NO_CONTENT
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/command",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionCommandRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_command(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<SessionCommandRequest>,
) -> impl IntoResponse {
    if body.command.is_none() || body.arguments.is_none() {
        return bad_request("command and arguments are required").into_response();
    }
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    let assistant_message_id = next_id("msg_", &MESSAGE_COUNTER);
    let agent = normalize_agent_mode(body.agent.clone());
    let assistant_message = build_assistant_message(
        &session_id,
        &assistant_message_id,
        "msg_parent",
        now,
        &directory,
        &worktree,
        &agent,
        OPENCODE_DEFAULT_PROVIDER_ID,
        OPENCODE_DEFAULT_MODEL_ID,
    );

    (
        StatusCode::OK,
        Json(json!({
            "info": assistant_message,
            "parts": [],
        })),
    )
        .into_response()
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/shell",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionShellRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_shell(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<SessionShellRequest>,
) -> impl IntoResponse {
    if body.command.is_none() || body.agent.is_none() {
        return bad_request("agent and command are required").into_response();
    }
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    let assistant_message_id = next_id("msg_", &MESSAGE_COUNTER);
    let assistant_message = build_assistant_message(
        &session_id,
        &assistant_message_id,
        "msg_parent",
        now,
        &directory,
        &worktree,
        &normalize_agent_mode(body.agent.clone()),
        body.model
            .as_ref()
            .and_then(|v| v.get("providerID"))
            .and_then(|v| v.as_str())
            .unwrap_or(OPENCODE_DEFAULT_PROVIDER_ID),
        body.model
            .as_ref()
            .and_then(|v| v.get("modelID"))
            .and_then(|v| v.as_str())
            .unwrap_or(OPENCODE_DEFAULT_MODEL_ID),
    );
    (StatusCode::OK, Json(assistant_message)).into_response()
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/revert",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_revert(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    oc_session_get(State(state), Path(session_id), headers, Query(query)).await
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/unrevert",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_unrevert(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    oc_session_get(State(state), Path(session_id), headers, Query(query)).await
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/permissions/{permissionID}",
    params(
        ("sessionID" = String, Path, description = "Session ID"),
        ("permissionID" = String, Path, description = "Permission ID")
    ),
    request_body = PermissionReplyRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_permission_reply(
    State(state): State<Arc<OpenCodeAppState>>,
    Path((session_id, permission_id)): Path<(String, String)>,
    Json(body): Json<PermissionReplyRequest>,
) -> impl IntoResponse {
    let reply = match parse_permission_reply_value(body.response.as_deref()) {
        Ok(reply) => reply,
        Err(message) => return bad_request(&message).into_response(),
    };
    match state
        .inner
        .session_manager()
        .reply_permission(&session_id, &permission_id, reply)
        .await
    {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/share",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_share(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let mut sessions = state.opencode.sessions.lock().await;
    if let Some(session) = sessions.get_mut(&session_id) {
        session.share_url = Some(format!("https://share.local/{}", session_id));
        let value = session.to_value();
        return (StatusCode::OK, Json(value)).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    delete,
    path = "/session/{sessionID}/share",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_unshare(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let mut sessions = state.opencode.sessions.lock().await;
    if let Some(session) = sessions.get_mut(&session_id) {
        session.share_url = None;
        let value = session.to_value();
        return (StatusCode::OK, Json(value)).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/todo",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_todo() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/permission",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_permission_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let pending = state
        .inner
        .session_manager()
        .list_pending_permissions()
        .await;
    let mut values = Vec::new();
    for item in pending {
        let record = OpenCodePermissionRecord {
            id: item.permission_id,
            session_id: item.session_id,
            permission: item.action,
            patterns: patterns_from_metadata(&item.metadata),
            metadata: item.metadata.unwrap_or_else(|| json!({})),
            always: Vec::new(),
            tool: None,
        };
        values.push(record.to_value());
    }
    values.sort_by(|a, b| {
        let a_id = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let b_id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
        a_id.cmp(b_id)
    });
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    post,
    path = "/permission/{requestID}/reply",
    params(("requestID" = String, Path, description = "Permission request ID")),
    request_body = PermissionGlobalReplyRequest,
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_permission_reply(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(request_id): Path<String>,
    Json(body): Json<PermissionGlobalReplyRequest>,
) -> impl IntoResponse {
    let reply = match parse_permission_reply_value(body.reply.as_deref()) {
        Ok(reply) => reply,
        Err(message) => return bad_request(&message).into_response(),
    };
    let session_id = state
        .inner
        .session_manager()
        .list_pending_permissions()
        .await
        .into_iter()
        .find(|item| item.permission_id == request_id)
        .map(|item| item.session_id);
    let Some(session_id) = session_id else {
        return not_found("Permission request not found").into_response();
    };
    match state
        .inner
        .session_manager()
        .reply_permission(&session_id, &request_id, reply)
        .await
    {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/question",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_question_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let pending = state.inner.session_manager().list_pending_questions().await;
    let mut values = Vec::new();
    for item in pending {
        let options: Vec<Value> = item
            .options
            .iter()
            .map(|option| json!({"label": option, "description": ""}))
            .collect();
        let record = OpenCodeQuestionRecord {
            id: item.question_id,
            session_id: item.session_id,
            questions: vec![json!({
                "header": "Question",
                "question": item.prompt,
                "options": options,
            })],
            tool: None,
        };
        values.push(record.to_value());
    }
    values.sort_by(|a, b| {
        let a_id = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let b_id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
        a_id.cmp(b_id)
    });
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    post,
    path = "/question/{requestID}/reply",
    params(("requestID" = String, Path, description = "Question request ID")),
    request_body = QuestionReplyBody,
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_question_reply(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(request_id): Path<String>,
    Json(body): Json<QuestionReplyBody>,
) -> impl IntoResponse {
    let session_id = state
        .inner
        .session_manager()
        .list_pending_questions()
        .await
        .into_iter()
        .find(|item| item.question_id == request_id)
        .map(|item| item.session_id);
    let Some(session_id) = session_id else {
        return not_found("Question request not found").into_response();
    };
    let answers = body.answers.unwrap_or_default();
    match state
        .inner
        .session_manager()
        .reply_question(&session_id, &request_id, answers)
        .await
    {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/question/{requestID}/reject",
    params(("requestID" = String, Path, description = "Question request ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_question_reject(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(request_id): Path<String>,
) -> impl IntoResponse {
    let session_id = state
        .inner
        .session_manager()
        .list_pending_questions()
        .await
        .into_iter()
        .find(|item| item.question_id == request_id)
        .map(|item| item.session_id);
    let Some(session_id) = session_id else {
        return not_found("Question request not found").into_response();
    };
    match state
        .inner
        .session_manager()
        .reject_question(&session_id, &request_id)
        .await
    {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/provider",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_provider_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let cache = opencode_model_cache(&state).await;
    let mut grouped: BTreeMap<String, Vec<&OpenCodeModelEntry>> = BTreeMap::new();
    for entry in &cache.entries {
        grouped
            .entry(entry.group_id.clone())
            .or_default()
            .push(entry);
    }
    let mut providers = Vec::new();
    let mut defaults = serde_json::Map::new();
    for (group_id, entries) in grouped {
        let mut models = serde_json::Map::new();
        for entry in entries {
            models.insert(entry.model.id.clone(), model_summary_entry(entry));
        }
        let name = cache
            .group_names
            .get(&group_id)
            .cloned()
            .unwrap_or_else(|| group_id.clone());
        providers.push(json!({
            "id": group_id,
            "name": name,
            "env": [],
            "models": Value::Object(models),
        }));
        if let Some(default_model) = cache.group_defaults.get(&group_id) {
            defaults.insert(group_id.clone(), Value::String(default_model.clone()));
        }
    }
    // Use the connected list from cache (based on credential availability)
    let providers = json!({
        "all": providers,
        "default": Value::Object(defaults),
        "connected": cache.connected
    });
    (StatusCode::OK, Json(providers))
}

#[utoipa::path(
    get,
    path = "/provider/auth",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_provider_auth(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let cache = opencode_model_cache(&state).await;
    let mut auth_map = serde_json::Map::new();
    for group_id in cache.group_names.keys() {
        auth_map.insert(group_id.clone(), json!([]));
    }
    (StatusCode::OK, Json(Value::Object(auth_map)))
}

#[utoipa::path(
    post,
    path = "/provider/{providerID}/oauth/authorize",
    params(("providerID" = String, Path, description = "Provider ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_provider_oauth_authorize(Path(provider_id): Path<String>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "url": format!("https://auth.local/{}/authorize", provider_id),
            "method": "auto",
            "instructions": "stub",
        })),
    )
}

#[utoipa::path(
    post,
    path = "/provider/{providerID}/oauth/callback",
    params(("providerID" = String, Path, description = "Provider ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_provider_oauth_callback(Path(_provider_id): Path<String>) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    put,
    path = "/auth/{providerID}",
    params(("providerID" = String, Path, description = "Provider ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_auth_set(
    Path(_provider_id): Path<String>,
    Json(_body): Json<Value>,
) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    delete,
    path = "/auth/{providerID}",
    params(("providerID" = String, Path, description = "Provider ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_auth_remove(Path(_provider_id): Path<String>) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/pty",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_pty_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let ptys = state.opencode.ptys.lock().await;
    let values: Vec<Value> = ptys.values().map(|p| p.to_value()).collect();
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    post,
    path = "/pty",
    request_body = PtyCreateRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_pty_create(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<PtyCreateRequest>,
) -> impl IntoResponse {
    let directory = state
        .opencode
        .directory_for(&headers, query.directory.as_ref());
    let id = next_id("pty_", &PTY_COUNTER);
    let record = OpenCodePtyRecord {
        id: id.clone(),
        title: body.title.unwrap_or_else(|| "PTY".to_string()),
        command: body.command.unwrap_or_else(|| "bash".to_string()),
        args: body.args.unwrap_or_default(),
        cwd: body.cwd.unwrap_or_else(|| directory),
        status: "running".to_string(),
        pid: 0,
    };
    let value = record.to_value();
    let mut ptys = state.opencode.ptys.lock().await;
    ptys.insert(id, record);
    drop(ptys);

    state
        .opencode
        .emit_event(json!({"type": "pty.created", "properties": {"pty": value}}));

    (StatusCode::OK, Json(value))
}

#[utoipa::path(
    get,
    path = "/pty/{ptyID}",
    params(("ptyID" = String, Path, description = "Pty ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_pty_get(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(pty_id): Path<String>,
) -> impl IntoResponse {
    let ptys = state.opencode.ptys.lock().await;
    if let Some(pty) = ptys.get(&pty_id) {
        return (StatusCode::OK, Json(pty.to_value())).into_response();
    }
    not_found("PTY not found").into_response()
}

#[utoipa::path(
    put,
    path = "/pty/{ptyID}",
    params(("ptyID" = String, Path, description = "Pty ID")),
    request_body = String,
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_pty_update(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(pty_id): Path<String>,
    Json(body): Json<PtyCreateRequest>,
) -> impl IntoResponse {
    let mut ptys = state.opencode.ptys.lock().await;
    if let Some(pty) = ptys.get_mut(&pty_id) {
        if let Some(title) = body.title {
            pty.title = title;
        }
        if let Some(command) = body.command {
            pty.command = command;
        }
        if let Some(args) = body.args {
            pty.args = args;
        }
        if let Some(cwd) = body.cwd {
            pty.cwd = cwd;
        }
        let value = pty.to_value();
        state
            .opencode
            .emit_event(json!({"type": "pty.updated", "properties": {"pty": value}}));
        return (StatusCode::OK, Json(value)).into_response();
    }
    not_found("PTY not found").into_response()
}

#[utoipa::path(
    delete,
    path = "/pty/{ptyID}",
    params(("ptyID" = String, Path, description = "Pty ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_pty_delete(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(pty_id): Path<String>,
) -> impl IntoResponse {
    let mut ptys = state.opencode.ptys.lock().await;
    if let Some(pty) = ptys.remove(&pty_id) {
        state
            .opencode
            .emit_event(json!({"type": "pty.deleted", "properties": {"pty": pty.to_value()}}));
        return bool_ok(true).into_response();
    }
    not_found("PTY not found").into_response()
}

#[utoipa::path(
    get,
    path = "/pty/{ptyID}/connect",
    params(("ptyID" = String, Path, description = "Pty ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_pty_connect(Path(_pty_id): Path<String>) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/file",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_file_list() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/file/content",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_file_content(Query(query): Query<FileContentQuery>) -> impl IntoResponse {
    if query.path.is_none() {
        return bad_request("path is required").into_response();
    }
    (
        StatusCode::OK,
        Json(json!({
            "type": "text",
            "content": "",
        })),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/file/status",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_file_status() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([]))).into_response()
}

#[utoipa::path(
    get,
    path = "/find",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_find_text(Query(query): Query<FindTextQuery>) -> impl IntoResponse {
    if query.pattern.is_none() {
        return bad_request("pattern is required").into_response();
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

#[utoipa::path(
    get,
    path = "/find/file",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_find_files(Query(query): Query<FindFilesQuery>) -> impl IntoResponse {
    if query.query.is_none() {
        return bad_request("query is required").into_response();
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

#[utoipa::path(
    get,
    path = "/find/symbol",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_find_symbols(Query(query): Query<FindSymbolsQuery>) -> impl IntoResponse {
    if query.query.is_none() {
        return bad_request("query is required").into_response();
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

#[utoipa::path(
    get,
    path = "/mcp",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_list() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({})))
}

#[utoipa::path(
    post,
    path = "/mcp",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_register() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({})))
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/auth",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_auth(Path(_name): Path<String>, _body: Option<Json<Value>>) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"status": "needs_auth"})))
}

#[utoipa::path(
    delete,
    path = "/mcp/{name}/auth",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_auth_remove(Path(_name): Path<String>) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"status": "disabled"})))
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/auth/callback",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_auth_callback(
    Path(_name): Path<String>,
    _body: Option<Json<Value>>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"status": "needs_auth"})))
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/auth/authenticate",
    params(("name" = String, Path, description = "MCP server name")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_authenticate(
    Path(_name): Path<String>,
    _body: Option<Json<Value>>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"status": "needs_auth"})))
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/connect",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_connect(Path(_name): Path<String>) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/disconnect",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_disconnect(Path(_name): Path<String>) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/experimental/tool/ids",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tool_ids() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/experimental/tool",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tool_list(Query(query): Query<ToolQuery>) -> impl IntoResponse {
    if query.provider.is_none() || query.model.is_none() {
        return bad_request("provider and model are required").into_response();
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

#[utoipa::path(
    get,
    path = "/experimental/resource",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_resource_list() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({})))
}

#[utoipa::path(
    get,
    path = "/experimental/worktree",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_worktree_list(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    (StatusCode::OK, Json(json!([worktree])))
}

#[utoipa::path(
    post,
    path = "/experimental/worktree",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_worktree_create(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    (
        StatusCode::OK,
        Json(json!({
            "name": "worktree",
            "branch": state.opencode.branch_name(),
            "directory": worktree,
        })),
    )
}

#[utoipa::path(
    delete,
    path = "/experimental/worktree",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_worktree_delete() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/experimental/worktree/reset",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_worktree_reset() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/skill",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_skill_list() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/tui/control/next",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_next(State(state): State<Arc<OpenCodeAppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::GET,
        "/tui/control/next",
        &headers,
        None,
    )
    .await
    {
        return response;
    }
    (StatusCode::OK, Json(json!({"path": "", "body": {}}))).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/control/response",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_response(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/control/response",
        &headers,
        body.map(|json| json.0),
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/append-prompt",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_append_prompt(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/append-prompt",
        &headers,
        body.map(|json| json.0),
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/open-help",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_open_help(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/open-help",
        &headers,
        None,
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/open-sessions",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_open_sessions(
    State(_state): State<Arc<OpenCodeAppState>>,
    _headers: HeaderMap,
) -> Response {
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/open-themes",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_open_themes(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/open-themes",
        &headers,
        None,
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/open-models",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_open_models(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/open-models",
        &headers,
        None,
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/submit-prompt",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_submit_prompt(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/submit-prompt",
        &headers,
        body.map(|json| json.0),
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/clear-prompt",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_clear_prompt(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/clear-prompt",
        &headers,
        None,
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/execute-command",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_execute_command(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/execute-command",
        &headers,
        body.map(|json| json.0),
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/show-toast",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_show_toast(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/show-toast",
        &headers,
        body.map(|json| json.0),
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/publish",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_publish(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(response) = proxy_native_opencode(
        &state,
        reqwest::Method::POST,
        "/tui/publish",
        &headers,
        body.map(|json| json.0),
    )
    .await
    {
        return response;
    }
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/tui/select-session",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_select_session(
    State(state): State<Arc<OpenCodeAppState>>,
    _headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(Json(body)) = body {
        // Emit a tui.session.select event so the TUI navigates to the session.
        let session_id = body
            .get("sessionID")
            .and_then(Value::as_str)
            .unwrap_or_default();
        state.opencode.emit_event(json!({
            "type": "tui.session.select",
            "properties": {
                "sessionID": session_id
            }
        }));
    }
    bool_ok(true).into_response()
}

#[derive(OpenApi)]
#[openapi(
    paths(
        oc_agent_list,
        oc_command_list,
        oc_config_get,
        oc_config_patch,
        oc_config_providers,
        oc_event_subscribe,
        oc_global_event,
        oc_global_health,
        oc_global_config_get,
        oc_global_config_patch,
        oc_global_dispose,
        oc_instance_dispose,
        oc_log,
        oc_lsp_status,
        oc_formatter_status,
        oc_path,
        oc_vcs,
        oc_project_list,
        oc_project_current,
        oc_project_update,
        oc_session_create,
        oc_session_list,
        oc_session_get,
        oc_session_update,
        oc_session_delete,
        oc_session_status,
        oc_session_abort,
        oc_session_children,
        oc_session_init,
        oc_session_fork,
        oc_session_diff,
        oc_session_summarize,
        oc_session_messages,
        oc_session_message_create,
        oc_session_message_get,
        oc_message_part_update,
        oc_message_part_delete,
        oc_session_prompt_async,
        oc_session_command,
        oc_session_shell,
        oc_session_revert,
        oc_session_unrevert,
        oc_session_permission_reply,
        oc_session_share,
        oc_session_unshare,
        oc_session_todo,
        oc_permission_list,
        oc_permission_reply,
        oc_question_list,
        oc_question_reply,
        oc_question_reject,
        oc_provider_list,
        oc_provider_auth,
        oc_provider_oauth_authorize,
        oc_provider_oauth_callback,
        oc_auth_set,
        oc_auth_remove,
        oc_pty_list,
        oc_pty_create,
        oc_pty_get,
        oc_pty_update,
        oc_pty_delete,
        oc_pty_connect,
        oc_file_list,
        oc_file_content,
        oc_file_status,
        oc_find_text,
        oc_find_files,
        oc_find_symbols,
        oc_mcp_list,
        oc_mcp_register,
        oc_mcp_auth,
        oc_mcp_auth_remove,
        oc_mcp_auth_callback,
        oc_mcp_authenticate,
        oc_mcp_connect,
        oc_mcp_disconnect,
        oc_tool_ids,
        oc_tool_list,
        oc_resource_list,
        oc_worktree_list,
        oc_worktree_create,
        oc_worktree_delete,
        oc_worktree_reset,
        oc_skill_list,
        oc_tui_next,
        oc_tui_response,
        oc_tui_append_prompt,
        oc_tui_open_help,
        oc_tui_open_sessions,
        oc_tui_open_themes,
        oc_tui_open_models,
        oc_tui_submit_prompt,
        oc_tui_clear_prompt,
        oc_tui_execute_command,
        oc_tui_show_toast,
        oc_tui_publish,
        oc_tui_select_session
    ),
    components(schemas(
        OpenCodeCreateSessionRequest,
        OpenCodeUpdateSessionRequest,
        SessionMessageRequest,
        SessionCommandRequest,
        SessionShellRequest,
        SessionSummarizeRequest,
        PermissionReplyRequest,
        PermissionGlobalReplyRequest,
        QuestionReplyBody,
        PtyCreateRequest
    )),
    tags((name = "opencode", description = "OpenCode compatibility API"))
)]
pub struct OpenCodeApiDoc;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::universal_events::ReasoningVisibility;

    fn assistant_item(content: Vec<ContentPart>) -> UniversalItem {
        UniversalItem {
            item_id: "itm_assistant".to_string(),
            native_item_id: Some("native_assistant".to_string()),
            parent_id: None,
            kind: ItemKind::Message,
            role: Some(ItemRole::Assistant),
            content,
            status: ItemStatus::InProgress,
        }
    }

    #[test]
    fn extract_message_text_ignores_non_text_parts() {
        let parts = vec![
            ContentPart::Status {
                label: "Thinking".to_string(),
                detail: Some("Preparing friendly brief response".to_string()),
            },
            ContentPart::Reasoning {
                text: "Preparing friendly brief response".to_string(),
                visibility: ReasoningVisibility::Public,
            },
            ContentPart::Text {
                text: "Hey! How can I help?".to_string(),
            },
            ContentPart::Json {
                json: serde_json::json!({"ignored": true}),
            },
        ];

        assert_eq!(
            extract_message_text_from_content(&parts),
            Some("Hey! How can I help?".to_string())
        );
    }

    #[test]
    fn item_supports_text_deltas_only_for_assistant_text_messages() {
        assert!(item_supports_text_deltas(&assistant_item(Vec::new())));
        assert!(item_supports_text_deltas(&assistant_item(vec![
            ContentPart::Text {
                text: "hello".to_string(),
            }
        ])));
        assert!(!item_supports_text_deltas(&assistant_item(vec![
            ContentPart::Reasoning {
                text: "internal".to_string(),
                visibility: ReasoningVisibility::Private,
            }
        ])));

        let user = UniversalItem {
            item_id: "itm_user".to_string(),
            native_item_id: Some("native_user".to_string()),
            parent_id: None,
            kind: ItemKind::Message,
            role: Some(ItemRole::User),
            content: vec![ContentPart::Text {
                text: "hello".to_string(),
            }],
            status: ItemStatus::InProgress,
        };
        assert!(!item_supports_text_deltas(&user));

        let status = UniversalItem {
            item_id: "itm_status".to_string(),
            native_item_id: Some("native_status".to_string()),
            parent_id: None,
            kind: ItemKind::Status,
            role: Some(ItemRole::Assistant),
            content: vec![ContentPart::Status {
                label: "thinking".to_string(),
                detail: None,
            }],
            status: ItemStatus::InProgress,
        };
        assert!(!item_supports_text_deltas(&status));
    }

    #[test]
    fn text_delta_capability_blocks_non_text_item_ids() {
        let mut runtime = OpenCodeSessionRuntime::default();
        set_item_text_delta_capability(&mut runtime, Some("itm_1"), Some("native_1"), false);
        assert!(item_delta_is_non_text(
            &runtime,
            Some("itm_1"),
            Some("native_1")
        ));

        set_item_text_delta_capability(&mut runtime, Some("itm_1"), Some("native_1"), true);
        assert!(!item_delta_is_non_text(
            &runtime,
            Some("itm_1"),
            Some("native_1")
        ));
    }
}
