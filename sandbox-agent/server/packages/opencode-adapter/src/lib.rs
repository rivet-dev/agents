use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::sse::{Event, KeepAlive};
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures::stream;
use futures::{Stream, StreamExt};
use sandbox_agent_opencode_server_manager::OpenCodeServerManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use tokio::sync::{broadcast, Mutex, OnceCell};
use tokio::time::interval;
use tracing::warn;

const DEFAULT_REPLAY_MAX_EVENTS: usize = 50;
const DEFAULT_REPLAY_MAX_CHARS: usize = 12_000;
const EVENT_LOG_SIZE: usize = 4096;
const EVENT_CHANNEL_SIZE: usize = 2048;
const MODEL_CHANGE_ERROR: &str = "OpenCode compatibility currently does not support changing the model after creating a session. Export with /export and load in to a new session.";

// ---------------------------------------------------------------------------
// AcpDispatch trait — allows the adapter to dispatch to real ACP agents
// without depending on the `sandbox-agent` crate (which would be circular).
// ---------------------------------------------------------------------------

/// Stream of raw JSON-RPC payloads from the ACP agent process.
pub type AcpPayloadStream = Pin<Box<dyn Stream<Item = Value> + Send>>;

#[derive(Debug)]
pub enum AcpDispatchResult {
    Response(Value),
    Accepted,
}

/// Trait for dispatching JSON-RPC payloads to ACP agent process instances.
///
/// Implementors (e.g. `AcpProxyRuntime`) handle launching, bootstrapping, and
/// communicating with agent subprocesses via the ACP stdio bridge.
pub trait AcpDispatch: Send + Sync + 'static {
    /// Send a JSON-RPC payload to the agent process identified by `server_id`.
    /// If the instance does not exist yet and `bootstrap_agent` is provided,
    /// the implementation should create it for that agent.
    fn post(
        &self,
        server_id: &str,
        bootstrap_agent: Option<&str>,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<AcpDispatchResult, String>> + Send + '_>>;

    /// Open a stream of raw JSON-RPC notification payloads from the agent
    /// process. Each item is a `serde_json::Value` containing a complete
    /// JSON-RPC message (notification or response).
    fn notification_stream(
        &self,
        server_id: &str,
        last_event_id: Option<u64>,
    ) -> Pin<Box<dyn Future<Output = Result<AcpPayloadStream, String>> + Send + '_>>;

    /// Destroy the agent process instance.
    fn delete(
        &self,
        server_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;
}

pub struct OpenCodeAdapterConfig {
    pub auth_token: Option<String>,
    pub sqlite_path: Option<String>,
    pub replay_max_events: usize,
    pub replay_max_chars: usize,
    pub native_proxy_base_url: Option<String>,
    pub native_proxy_manager: Option<Arc<OpenCodeServerManager>>,
    /// Optional ACP dispatch backend. When `Some`, prompts for non-mock agents
    /// are routed through real ACP agent processes instead of the mock handler.
    pub acp_dispatch: Option<Arc<dyn AcpDispatch>>,
    /// Optional pre-built provider payload for `/provider` and `/config/providers`.
    /// When `None`, falls back to the hardcoded mock/amp/claude/codex list.
    pub provider_payload: Option<Value>,
}

impl Default for OpenCodeAdapterConfig {
    fn default() -> Self {
        Self {
            auth_token: None,
            sqlite_path: None,
            replay_max_events: DEFAULT_REPLAY_MAX_EVENTS,
            replay_max_chars: DEFAULT_REPLAY_MAX_CHARS,
            native_proxy_base_url: None,
            native_proxy_manager: None,
            acp_dispatch: None,
            provider_payload: None,
        }
    }
}

#[derive(Clone, Debug)]
struct OpenCodeStreamEvent {
    id: u64,
    payload: Value,
}

#[derive(Clone, Debug)]
struct SessionState {
    meta: SessionMeta,
    messages: Vec<MessageRecord>,
    status: String,
    always_permissions: HashSet<String>,
}

#[derive(Clone, Debug)]
struct MessageRecord {
    info: Value,
    parts: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SessionMeta {
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
    agent: String,
    provider_id: String,
    model_id: String,
    agent_session_id: String,
    last_connection_id: String,
    session_init_json: Option<Value>,
    destroyed_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
struct Projection {
    sessions: HashMap<String, SessionState>,
    permissions: HashMap<String, Value>,
    questions: HashMap<String, Value>,
}

#[derive(Debug, Clone)]
struct AcpPendingRequest {
    opencode_session_id: String,
    /// The JSON-RPC `id` from the ACP agent request (permission or question).
    jsonrpc_id: Value,
    kind: AcpPendingKind,
}

#[derive(Debug, Clone)]
enum AcpPendingKind {
    Permission,
    Question,
}

struct AdapterState {
    config: OpenCodeAdapterConfig,
    sqlite_path: String,
    sqlite_connect_options: SqliteConnectOptions,
    proxy_http_client: reqwest::Client,
    pool: OnceCell<SqlitePool>,
    initialized: OnceCell<()>,
    project_id: String,
    projection: Mutex<Projection>,
    pending_replay: Mutex<HashMap<String, String>>,
    agent_connections: Mutex<HashMap<String, String>>,
    event_broadcaster: broadcast::Sender<OpenCodeStreamEvent>,
    event_log: StdMutex<VecDeque<OpenCodeStreamEvent>>,
    next_event_id: AtomicU64,
    next_id: AtomicU64,
    /// Tracks which ACP server instances have been initialized (initialize + session/new sent).
    /// Key is the ACP server_id (e.g. "acp_ses_42"), value is the ACP sessionId from session/new.
    acp_initialized: Mutex<HashMap<String, String>>,
    /// Maps pending ACP JSON-RPC request IDs to (opencode_session_id, request_kind).
    /// Used to correlate permission/question requests from the agent SSE stream.
    acp_request_ids: Mutex<HashMap<String, AcpPendingRequest>>,
    /// Tracks the last user message ID per session so the SSE translation task
    /// can set the correct `parentID` on assistant messages.
    last_user_message_id: Mutex<HashMap<String, String>>,
}

impl AdapterState {
    async fn ensure_initialized(&self) -> Result<(), String> {
        self.initialized
            .get_or_try_init(|| async {
                let pool = self.pool().await?;
                sqlx::query("PRAGMA journal_mode=WAL;")
                    .execute(pool)
                    .await
                    .map_err(|err| err.to_string())?;
                sqlx::query("PRAGMA synchronous=NORMAL;")
                    .execute(pool)
                    .await
                    .map_err(|err| err.to_string())?;

                // Keep migration SQL in versioned files and run bootstrap migration here.
                sqlx::query(include_str!("../migrations/0001_init.sql"))
                    .execute(pool)
                    .await
                    .map_err(|err| err.to_string())?;

                self.rebuild_projection().await?;
                Ok(())
            })
            .await
            .map(|_| ())
    }

    async fn rebuild_projection(&self) -> Result<(), String> {
        let mut projection = Projection::default();
        let pool = self.pool().await?;

        let rows = sqlx::query(
            r#"SELECT s.id, s.agent, s.agent_session_id, s.last_connection_id, s.created_at, s.destroyed_at, s.session_init_json,
                      m.metadata_json
               FROM sessions s
               JOIN opencode_session_metadata m ON m.session_id = s.id
               ORDER BY s.created_at ASC, s.id ASC"#,
        )
        .fetch_all(pool)
        .await
        .map_err(|err| err.to_string())?;

        for row in rows {
            let id: String = row.try_get("id").map_err(|err| err.to_string())?;
            let agent: String = row.try_get("agent").map_err(|err| err.to_string())?;
            let agent_session_id: String = row
                .try_get("agent_session_id")
                .map_err(|err| err.to_string())?;
            let last_connection_id: String = row
                .try_get("last_connection_id")
                .map_err(|err| err.to_string())?;
            let created_at: i64 = row.try_get("created_at").map_err(|err| err.to_string())?;
            let destroyed_at: Option<i64> =
                row.try_get("destroyed_at").map_err(|err| err.to_string())?;
            let session_init_json: Option<String> = row
                .try_get("session_init_json")
                .map_err(|err| err.to_string())?;
            let metadata_json: String = row
                .try_get("metadata_json")
                .map_err(|err| err.to_string())?;

            let mut meta: SessionMeta =
                serde_json::from_str(&metadata_json).map_err(|err| err.to_string())?;
            meta.id = id.clone();
            meta.agent = agent;
            meta.agent_session_id = agent_session_id;
            meta.last_connection_id = last_connection_id;
            meta.created_at = created_at;
            meta.destroyed_at = destroyed_at;
            meta.session_init_json = session_init_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok());

            projection.sessions.insert(
                id,
                SessionState {
                    meta,
                    messages: Vec::new(),
                    status: "idle".to_string(),
                    always_permissions: HashSet::new(),
                },
            );
        }

        let event_rows = sqlx::query(
            r#"SELECT session_id, sender, payload_json
               FROM events
               ORDER BY created_at ASC, id ASC"#,
        )
        .fetch_all(pool)
        .await
        .map_err(|err| err.to_string())?;

        for row in event_rows {
            let session_id: String = row.try_get("session_id").map_err(|err| err.to_string())?;
            let sender: String = row.try_get("sender").map_err(|err| err.to_string())?;
            let payload_json: String =
                row.try_get("payload_json").map_err(|err| err.to_string())?;
            let payload: Value =
                serde_json::from_str(&payload_json).map_err(|err| err.to_string())?;
            apply_envelope(&mut projection, &session_id, &sender, &payload);
        }

        let mut guard = self.projection.lock().await;
        *guard = projection;
        Ok(())
    }

    fn emit_event(&self, payload: Value) {
        let event = OpenCodeStreamEvent {
            id: self.next_event_id.fetch_add(1, Ordering::Relaxed),
            payload,
        };

        if let Ok(mut guard) = self.event_log.lock() {
            guard.push_back(event.clone());
            while guard.len() > EVENT_LOG_SIZE {
                guard.pop_front();
            }
        }

        let _ = self.event_broadcaster.send(event);
    }

    fn buffered_events_after(&self, last_event_id: Option<u64>) -> Vec<OpenCodeStreamEvent> {
        let Some(last_event_id) = last_event_id else {
            return Vec::new();
        };
        let Ok(guard) = self.event_log.lock() else {
            return Vec::new();
        };
        guard
            .iter()
            .filter(|entry| entry.id > last_event_id)
            .cloned()
            .collect()
    }

    fn subscribe(&self) -> broadcast::Receiver<OpenCodeStreamEvent> {
        self.event_broadcaster.subscribe()
    }

    fn next_id(&self, prefix: &str) -> String {
        let value = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}{value}")
    }

    async fn current_connection_for_agent(&self, agent: &str) -> String {
        let mut guard = self.agent_connections.lock().await;
        guard
            .entry(agent.to_string())
            .or_insert_with(|| format!("conn_{}_{}", agent, now_ms()))
            .clone()
    }

    async fn pool(&self) -> Result<&SqlitePool, String> {
        self.pool
            .get_or_try_init(|| async {
                if let Some(parent) = PathBuf::from(&self.sqlite_path).parent() {
                    if !parent.as_os_str().is_empty() {
                        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                    }
                }
                SqlitePoolOptions::new()
                    .max_connections(1)
                    .connect_with(self.sqlite_connect_options.clone())
                    .await
                    .map_err(|err| err.to_string())
            })
            .await
    }

    async fn persist_session(&self, meta: &SessionMeta) -> Result<(), String> {
        let pool = self.pool().await?;
        let session_init_json = meta
            .session_init_json
            .as_ref()
            .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()));

        sqlx::query(
            r#"INSERT INTO sessions (
                id, agent, agent_session_id, last_connection_id, created_at, destroyed_at, session_init_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                agent = excluded.agent,
                agent_session_id = excluded.agent_session_id,
                last_connection_id = excluded.last_connection_id,
                created_at = excluded.created_at,
                destroyed_at = excluded.destroyed_at,
                session_init_json = excluded.session_init_json"#,
        )
        .bind(&meta.id)
        .bind(&meta.agent)
        .bind(&meta.agent_session_id)
        .bind(&meta.last_connection_id)
        .bind(meta.created_at)
        .bind(meta.destroyed_at)
        .bind(session_init_json)
        .execute(pool)
        .await
        .map_err(|err| err.to_string())?;

        let metadata_json = serde_json::to_string(meta).map_err(|err| err.to_string())?;
        sqlx::query(
            r#"INSERT INTO opencode_session_metadata (session_id, metadata_json)
               VALUES (?1, ?2)
               ON CONFLICT(session_id) DO UPDATE SET
                 metadata_json = excluded.metadata_json"#,
        )
        .bind(&meta.id)
        .bind(metadata_json)
        .execute(pool)
        .await
        .map_err(|err| err.to_string())?;

        Ok(())
    }

    async fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let pool = self.pool().await?;
        sqlx::query("DELETE FROM events WHERE session_id = ?1")
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(|err| err.to_string())?;
        sqlx::query("DELETE FROM opencode_session_metadata WHERE session_id = ?1")
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(|err| err.to_string())?;
        sqlx::query("DELETE FROM sessions WHERE id = ?1")
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    async fn persist_event(
        &self,
        session_id: &str,
        sender: &str,
        payload: &Value,
    ) -> Result<(), String> {
        let pool = self.pool().await?;
        let id = format!("evt_{}", self.next_id(""));
        let created_at = now_ms();
        let connection_id = {
            let projection = self.projection.lock().await;
            projection
                .sessions
                .get(session_id)
                .map(|state| state.meta.last_connection_id.clone())
                .unwrap_or_else(|| "conn_unknown".to_string())
        };
        sqlx::query(
            r#"INSERT INTO events (id, session_id, created_at, connection_id, sender, payload_json)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
        )
        .bind(id)
        .bind(session_id)
        .bind(created_at)
        .bind(connection_id)
        .bind(sender)
        .bind(serde_json::to_string(payload).map_err(|err| err.to_string())?)
        .execute(pool)
        .await
        .map_err(|err| err.to_string())?;

        let mut projection = self.projection.lock().await;
        apply_envelope(&mut projection, session_id, sender, payload);

        Ok(())
    }

    async fn collect_replay_events(
        &self,
        session_id: &str,
        max_events: usize,
    ) -> Result<Vec<Value>, String> {
        let pool = self.pool().await?;
        let rows = sqlx::query(
            r#"SELECT created_at, sender, payload_json
               FROM events
               WHERE session_id = ?1
               ORDER BY created_at ASC, id ASC"#,
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .map_err(|err| err.to_string())?;

        let mut values = Vec::new();
        for row in rows {
            let created_at: i64 = row.try_get("created_at").map_err(|err| err.to_string())?;
            let sender: String = row.try_get("sender").map_err(|err| err.to_string())?;
            let payload_json: String =
                row.try_get("payload_json").map_err(|err| err.to_string())?;
            let payload: Value =
                serde_json::from_str(&payload_json).map_err(|err| err.to_string())?;
            values.push(json!({
                "createdAt": created_at,
                "sender": sender,
                "payload": payload,
            }));
        }

        if values.len() > max_events {
            Ok(values.split_off(values.len() - max_events))
        } else {
            Ok(values)
        }
    }

    async fn maybe_restore_session(&self, session_id: &str) -> Result<(), String> {
        let (agent, stale) = {
            let projection = self.projection.lock().await;
            let Some(state) = projection.sessions.get(session_id) else {
                return Ok(());
            };
            (
                state.meta.agent.clone(),
                state.meta.last_connection_id.clone(),
            )
        };

        let current = self.current_connection_for_agent(&agent).await;
        if stale == current {
            return Ok(());
        }

        let replay_source = self
            .collect_replay_events(session_id, self.config.replay_max_events)
            .await?;
        let replay_text = build_replay_text(&replay_source, self.config.replay_max_chars);

        let request_id = self.next_id("oc_req_");
        let new_agent_session_id = format!("acp_{}", self.next_id("ses_"));
        let new_request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/new",
            "params": {
                "cwd": "/",
                "mcpServers": [],
            }
        });
        self.persist_event(session_id, "client", &new_request)
            .await?;

        let new_response = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "sessionId": new_agent_session_id,
            }
        });
        self.persist_event(session_id, "agent", &new_response)
            .await?;

        let mut updated_meta = None;
        {
            let mut projection = self.projection.lock().await;
            if let Some(session) = projection.sessions.get_mut(session_id) {
                session.meta.agent_session_id = new_agent_session_id;
                session.meta.last_connection_id = current;
                session.meta.destroyed_at = None;
                updated_meta = Some(session.meta.clone());
            }
        }
        if let Some(meta) = updated_meta {
            self.persist_session(&meta).await?;
        }

        if let Some(text) = replay_text {
            self.pending_replay
                .lock()
                .await
                .insert(session_id.to_string(), text);
        }

        Ok(())
    }

    async fn ensure_session(
        &self,
        session_id: &str,
        directory: String,
    ) -> Result<SessionMeta, String> {
        {
            let projection = self.projection.lock().await;
            if let Some(existing) = projection.sessions.get(session_id) {
                return Ok(existing.meta.clone());
            }
        }

        let now = now_ms();
        let connection_id = self.current_connection_for_agent("mock").await;
        let meta = SessionMeta {
            id: session_id.to_string(),
            slug: format!("session-{session_id}"),
            project_id: self.project_id.clone(),
            directory,
            parent_id: None,
            title: format!("Session {session_id}"),
            version: "0".to_string(),
            created_at: now,
            updated_at: now,
            share_url: None,
            permission_mode: None,
            agent: "mock".to_string(),
            provider_id: "mock".to_string(),
            model_id: "mock".to_string(),
            agent_session_id: format!("acp_{}", self.next_id("ses_")),
            last_connection_id: connection_id,
            session_init_json: Some(json!({"cwd": "/", "mcpServers": []})),
            destroyed_at: None,
        };

        self.persist_session(&meta).await?;

        let session_value = session_to_value(&meta);
        {
            let mut projection = self.projection.lock().await;
            projection.sessions.insert(
                session_id.to_string(),
                SessionState {
                    meta: meta.clone(),
                    messages: Vec::new(),
                    status: "idle".to_string(),
                    always_permissions: HashSet::new(),
                },
            );
        }

        self.emit_event(json!({
            "type": "session.created",
            "properties": { "info": session_value }
        }));

        Ok(meta)
    }
}

pub fn build_opencode_router(config: OpenCodeAdapterConfig) -> Result<Router, String> {
    let proxy_base_url = config
        .native_proxy_base_url
        .clone()
        .or_else(|| std::env::var("OPENCODE_COMPAT_PROXY_URL").ok())
        .and_then(normalize_proxy_base_url);
    let config = OpenCodeAdapterConfig {
        native_proxy_base_url: proxy_base_url,
        ..config
    };

    let sqlite_path = config
        .sqlite_path
        .clone()
        .or_else(|| std::env::var("OPENCODE_COMPAT_DB_PATH").ok())
        .or_else(|| {
            std::env::var("OPENCODE_COMPAT_STATE")
                .ok()
                .map(|base| format!("{base}/opencode-sessions.db"))
        })
        .unwrap_or_else(|| "/tmp/sandbox-agent-opencode.db".to_string());

    let connect = SqliteConnectOptions::from_str(&format!("sqlite://{sqlite_path}"))
        .map_err(|err| err.to_string())?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    let (event_broadcaster, _) = broadcast::channel(EVENT_CHANNEL_SIZE);

    let state = Arc::new(AdapterState {
        config,
        sqlite_path,
        sqlite_connect_options: connect,
        proxy_http_client: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new()),
        pool: OnceCell::new(),
        initialized: OnceCell::new(),
        project_id: format!("proj_{}", now_ms()),
        projection: Mutex::new(Projection::default()),
        pending_replay: Mutex::new(HashMap::new()),
        agent_connections: Mutex::new(HashMap::new()),
        event_broadcaster,
        event_log: StdMutex::new(VecDeque::new()),
        next_event_id: AtomicU64::new(1),
        next_id: AtomicU64::new(runtime_unique_seed()),
        acp_initialized: Mutex::new(HashMap::new()),
        acp_request_ids: Mutex::new(HashMap::new()),
        last_user_message_id: Mutex::new(HashMap::new()),
    });

    let mut router = Router::new()
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
        .route("/path", get(oc_path))
        .route("/vcs", get(oc_vcs))
        .route("/mcp", get(oc_mcp_status))
        .route("/lsp", get(oc_lsp_status))
        .route("/formatter", get(oc_formatter_status))
        .route("/experimental/resource", get(oc_experimental_resource))
        .route("/skill", get(oc_skill_list))
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
        .route("/project", get(oc_project_list).post(oc_project_current))
        .route("/project/current", get(oc_project_current))
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
        .route("/session/:sessionID/todo", get(oc_session_todo))
        .route("/session/:sessionID/summarize", post(oc_session_summarize))
        .route(
            "/session/:sessionID/message",
            get(oc_session_messages).post(oc_session_prompt),
        )
        .route(
            "/session/:sessionID/message/:messageID",
            get(oc_session_message_get),
        )
        .route(
            "/session/:sessionID/message/:messageID/part/:partID",
            patch(oc_part_update).delete(oc_part_delete),
        )
        .route(
            "/session/:sessionID/prompt_async",
            post(oc_session_prompt_async),
        )
        .route(
            "/session/:sessionID/permissions/:permissionID",
            post(oc_permission_respond),
        )
        .route("/permission", get(oc_permission_list))
        .route("/permission/:requestID/reply", post(oc_permission_reply))
        .route("/question", get(oc_question_list))
        .route("/question/:requestID/reply", post(oc_question_reply))
        .route("/question/:requestID/reject", post(oc_question_reject))
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
        .with_state(state.clone());

    if state.config.auth_token.is_some() {
        router = router.layer(axum::middleware::from_fn_with_state(state, require_token));
    }

    Ok(router)
}

async fn require_token(
    State(state): State<Arc<AdapterState>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, Response> {
    let Some(expected) = state.config.auth_token.as_deref() else {
        return Ok(next.run(request).await);
    };

    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    if bearer == Some(expected) {
        return Ok(next.run(request).await);
    }

    Err((
        StatusCode::UNAUTHORIZED,
        Json(json!({"errors":[{"message":"missing or invalid bearer token"}]})),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
struct DirectoryQuery {
    directory: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreateBody {
    title: Option<String>,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
    permission: Option<Value>,
    #[serde(alias = "permission_mode")]
    permission_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionUpdateBody {
    title: Option<String>,
    model: Option<Value>,
    #[serde(rename = "providerID", alias = "provider_id", alias = "providerId")]
    provider_id: Option<String>,
    #[serde(rename = "modelID", alias = "model_id", alias = "modelId")]
    model_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInitBody {
    #[serde(rename = "providerID")]
    provider_id: Option<String>,
    #[serde(rename = "modelID")]
    model_id: Option<String>,
    #[serde(rename = "messageID")]
    message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptBody {
    #[serde(rename = "messageID")]
    message_id: Option<String>,
    model: Option<ModelSelection>,
    #[serde(rename = "providerID", alias = "provider_id", alias = "providerId")]
    provider_id: Option<String>,
    #[serde(rename = "modelID", alias = "model_id", alias = "modelId")]
    model_id: Option<String>,
    agent: Option<String>,
    system: Option<String>,
    variant: Option<String>,
    parts: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelSelection {
    #[serde(rename = "providerID", alias = "provider_id", alias = "providerId")]
    provider_id: Option<String>,
    #[serde(rename = "modelID", alias = "model_id", alias = "modelId")]
    model_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PermissionRespondBody {
    response: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PermissionReplyBody {
    reply: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionReplyBody {
    answers: Option<Vec<Vec<String>>>,
}

async fn oc_agent_list(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    (
        StatusCode::OK,
        Json(json!([
            {
                "name": "Sandbox Agent",
                "description": "Sandbox Agent compatibility layer",
                "mode": "all",
                "native": false,
                "hidden": false,
                "permission": [],
                "options": {},
            }
        ])),
    )
        .into_response()
}

async fn oc_command_list(State(state): State<Arc<AdapterState>>, headers: HeaderMap) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    if let Some(response) =
        proxy_native_opencode(&state, reqwest::Method::GET, "/command", &headers, None).await
    {
        return response;
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

async fn oc_config_get(State(state): State<Arc<AdapterState>>, headers: HeaderMap) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    if let Some(response) =
        proxy_native_opencode(&state, reqwest::Method::GET, "/config", &headers, None).await
    {
        return response;
    }
    (
        StatusCode::OK,
        Json(json!({
            "mcp": {},
            "agent": {},
            "provider": {},
        })),
    )
        .into_response()
}

async fn oc_config_patch(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_config_providers(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    let providers = provider_payload(&state);
    let mut payload = providers.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("providers".to_string(), providers["all"].clone());
    }
    (StatusCode::OK, Json(payload)).into_response()
}

async fn oc_event_subscribe(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let _ = state.ensure_initialized().await;

    let directory = resolve_directory(&headers, query.directory.as_ref());
    let replay = state.buffered_events_after(parse_last_event_id(&headers));
    let receiver = state.subscribe();

    state.emit_event(json!({"type":"server.connected","properties":{}}));
    state.emit_event(
        json!({"type":"worktree.ready","properties":{"name": directory, "branch": "main"}}),
    );

    let stream = stream::unfold(
        (
            receiver,
            VecDeque::from(replay),
            interval(Duration::from_secs(30)),
        ),
        |(mut rx, mut replay, mut ticker)| async move {
            if let Some(item) = replay.pop_front() {
                let evt = Event::default()
                    .id(item.id.to_string())
                    .json_data(item.payload)
                    .unwrap_or_else(|_| Event::default().data("{}"));
                return Some((Ok(evt), (rx, replay, ticker)));
            }

            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let evt = Event::default().json_data(json!({"type":"server.heartbeat","properties":{}}))
                            .unwrap_or_else(|_| Event::default().data("{}"));
                        return Some((Ok(evt), (rx, replay, ticker)));
                    }
                    item = rx.recv() => {
                        match item {
                            Ok(payload) => {
                                let evt = Event::default()
                                    .id(payload.id.to_string())
                                    .json_data(payload.payload)
                                    .unwrap_or_else(|_| Event::default().data("{}"));
                                return Some((Ok(evt), (rx, replay, ticker)));
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                }
            }
        },
    );

    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

async fn oc_global_event(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    oc_event_subscribe(State(state), headers, Query(query)).await
}

async fn oc_global_health() -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "healthy": true,
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
        .into_response()
}

async fn oc_global_config_get(
    State(state): State<Arc<AdapterState>>,
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
    oc_config_get(State(state), headers).await
}

async fn oc_global_config_patch(
    State(state): State<Arc<AdapterState>>,
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
    oc_config_patch(State(state), headers, Json(body)).await
}

async fn oc_global_dispose() -> Response {
    bool_ok(true).into_response()
}

async fn oc_instance_dispose() -> Response {
    bool_ok(true).into_response()
}

async fn oc_path(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let directory = resolve_directory(&headers, query.directory.as_ref());
    (
        StatusCode::OK,
        Json(json!({
            "home": std::env::var("HOME").unwrap_or_else(|_| "/".to_string()),
            "state": std::env::var("OPENCODE_COMPAT_STATE").unwrap_or_else(|_| "/tmp".to_string()),
            "config": std::env::var("OPENCODE_COMPAT_CONFIG").unwrap_or_else(|_| "/tmp".to_string()),
            "worktree": directory,
            "directory": resolve_directory(&headers, query.directory.as_ref()),
        })),
    )
        .into_response()
}

async fn oc_vcs(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    (StatusCode::OK, Json(json!({"branch":"main"}))).into_response()
}

async fn oc_mcp_status(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    (StatusCode::OK, Json(json!({}))).into_response()
}

async fn oc_lsp_status(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

async fn oc_formatter_status(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

async fn oc_experimental_resource(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

async fn oc_skill_list() -> Response {
    (StatusCode::OK, Json(json!([]))).into_response()
}

async fn oc_tui_next(State(state): State<Arc<AdapterState>>, headers: HeaderMap) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_response(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_append_prompt(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_open_help(State(state): State<Arc<AdapterState>>, headers: HeaderMap) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_open_sessions() -> Response {
    bool_ok(true).into_response()
}

async fn oc_tui_open_themes(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_open_models(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_submit_prompt(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_clear_prompt(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_execute_command(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_show_toast(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_tui_publish(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
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

async fn oc_project_list(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    let directory = resolve_directory(&headers, query.directory.as_ref());
    let now = now_ms();
    (
        StatusCode::OK,
        Json(json!([{
            "id": state.project_id,
            "worktree": directory,
            "vcs": "git",
            "name": "sandbox-agent",
            "time": {"created": now, "updated": now},
        }])),
    )
        .into_response()
}

async fn oc_project_current(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    let directory = resolve_directory(&headers, query.directory.as_ref());
    let now = now_ms();
    (
        StatusCode::OK,
        Json(json!({
            "id": state.project_id,
            "worktree": directory,
            "vcs": "git",
            "name": "sandbox-agent",
            "time": {"created": now, "updated": now},
        })),
    )
        .into_response()
}

async fn oc_session_create(
    State(state): State<Arc<AdapterState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    body: Option<Json<SessionCreateBody>>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let body = body.map(|value| value.0).unwrap_or(SessionCreateBody {
        title: None,
        parent_id: None,
        permission: None,
        permission_mode: None,
    });

    let id = state.next_id("ses_");
    let now = now_ms();
    let directory = resolve_directory(&headers, query.directory.as_ref());

    let default_agent = "mock";
    let connection_id = state.current_connection_for_agent(default_agent).await;
    let meta = SessionMeta {
        id: id.clone(),
        slug: format!("session-{id}"),
        project_id: state.project_id.clone(),
        directory,
        parent_id: body.parent_id,
        title: body.title.unwrap_or_else(|| format!("Session {id}")),
        version: "0".to_string(),
        created_at: now,
        updated_at: now,
        share_url: None,
        permission_mode: body.permission_mode,
        agent: default_agent.to_string(),
        provider_id: default_agent.to_string(),
        model_id: default_model_for_provider(default_agent)
            .unwrap_or("default")
            .to_string(),
        agent_session_id: format!("acp_{}", state.next_id("ses_")),
        last_connection_id: connection_id,
        session_init_json: Some(json!({"cwd": "/", "mcpServers": []})),
        destroyed_at: None,
    };

    if let Err(err) = state.persist_session(&meta).await {
        return internal_error(err);
    }

    {
        let mut projection = state.projection.lock().await;
        projection.sessions.insert(
            id,
            SessionState {
                meta: meta.clone(),
                messages: Vec::new(),
                status: "idle".to_string(),
                always_permissions: HashSet::new(),
            },
        );
    }

    let value = session_to_value(&meta);
    state.emit_event(json!({"type":"session.created","properties":{"info":value}}));

    (StatusCode::OK, Json(value)).into_response()
}

async fn oc_session_list(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let projection = state.projection.lock().await;
    let mut values = projection
        .sessions
        .values()
        .map(|session| session_to_value(&session.meta))
        .collect::<Vec<_>>();
    values.sort_by(|a, b| {
        let a_id = a.get("id").and_then(Value::as_str).unwrap_or_default();
        let b_id = b.get("id").and_then(Value::as_str).unwrap_or_default();
        a_id.cmp(b_id)
    });

    (StatusCode::OK, Json(values)).into_response()
}

async fn oc_session_get(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let projection = state.projection.lock().await;
    let Some(session) = projection.sessions.get(&session_id) else {
        return not_found("Session not found");
    };

    (StatusCode::OK, Json(session_to_value(&session.meta))).into_response()
}

async fn oc_session_update(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
    Json(body): Json<SessionUpdateBody>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    if body.model.is_some() || body.provider_id.is_some() || body.model_id.is_some() {
        return bad_request(MODEL_CHANGE_ERROR);
    }

    let meta = {
        let mut projection = state.projection.lock().await;
        let Some(session) = projection.sessions.get_mut(&session_id) else {
            return not_found("Session not found");
        };

        if let Some(title) = body.title {
            session.meta.title = title;
            session.meta.updated_at = now_ms();
        }

        session.meta.clone()
    };

    if let Err(err) = state.persist_session(&meta).await {
        return internal_error(err);
    }

    let value = session_to_value(&meta);
    state.emit_event(json!({"type":"session.updated","properties":{"info":value}}));
    (StatusCode::OK, Json(value)).into_response()
}

async fn oc_session_delete(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let removed = {
        let mut projection = state.projection.lock().await;
        projection.permissions.retain(|_, value| {
            value
                .get("sessionID")
                .and_then(Value::as_str)
                .map(|id| id != session_id)
                .unwrap_or(true)
        });
        projection.questions.retain(|_, value| {
            value
                .get("sessionID")
                .and_then(Value::as_str)
                .map(|id| id != session_id)
                .unwrap_or(true)
        });
        projection.sessions.remove(&session_id)
    };

    let Some(session) = removed else {
        return not_found("Session not found");
    };

    if let Err(err) = state.delete_session(&session_id).await {
        return internal_error(err);
    }

    // Clean up the ACP server instance if one was created for this session.
    let server_id = session.meta.agent_session_id.clone();
    if state
        .acp_initialized
        .lock()
        .await
        .remove(&server_id)
        .is_some()
    {
        if let Some(dispatch) = state.config.acp_dispatch.as_ref() {
            if let Err(err) = dispatch.delete(&server_id).await {
                warn!(
                    ?err,
                    "failed to delete ACP server instance on session delete"
                );
            }
        }
    }

    // Clean up any pending ACP requests for this session.
    state
        .acp_request_ids
        .lock()
        .await
        .retain(|_, req| req.opencode_session_id != session_id);

    let value = session_to_value(&session.meta);
    state.emit_event(json!({"type":"session.deleted","properties":{"info":value}}));

    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_session_status(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    let projection = state.projection.lock().await;
    let mut map = serde_json::Map::new();
    for (id, session) in &projection.sessions {
        map.insert(id.clone(), json!({"type": session.status}));
    }
    (StatusCode::OK, Json(Value::Object(map))).into_response()
}

async fn oc_session_abort(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let mut should_emit_idle = false;
    {
        let mut projection = state.projection.lock().await;
        let Some(session) = projection.sessions.get_mut(&session_id) else {
            return not_found("Session not found");
        };
        if session.status != "idle" {
            session.status = "idle".to_string();
            should_emit_idle = true;
        }
        projection.permissions.retain(|_, value| {
            value.get("sessionID").and_then(Value::as_str) != Some(session_id.as_str())
        });
        projection.questions.retain(|_, value| {
            value.get("sessionID").and_then(Value::as_str) != Some(session_id.as_str())
        });
    }

    if should_emit_idle {
        let payload = json!({"jsonrpc":"2.0","method":"_sandboxagent/opencode/status","params":{"status":"idle"}});
        if let Err(err) = state.persist_event(&session_id, "agent", &payload).await {
            warn!(?err, "failed to persist abort idle status envelope");
        }
        state.emit_event(json!({"type":"session.idle","properties":{"sessionID":session_id}}));
    }

    // Send session/cancel to the ACP agent if dispatch is available.
    if let Some(dispatch) = state.config.acp_dispatch.as_ref() {
        let agent_session_id = {
            let projection = state.projection.lock().await;
            projection
                .sessions
                .get(&session_id)
                .map(|s| s.meta.agent_session_id.clone())
        };
        if let Some(server_id) = agent_session_id {
            let acp_session_id = state.acp_initialized.lock().await.get(&server_id).cloned();
            if let Some(acp_sid) = acp_session_id {
                let cancel_id = state.next_id("oc_rpc_");
                let cancel_payload = json!({
                    "jsonrpc": "2.0",
                    "id": cancel_id,
                    "method": "session/cancel",
                    "params": {
                        "sessionId": acp_sid,
                    }
                });
                if let Err(err) = dispatch.post(&server_id, None, cancel_payload).await {
                    warn!(?err, "failed to send session/cancel to ACP agent");
                }
            }
        }
    }

    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_session_children() -> Response {
    (StatusCode::OK, Json(json!([]))).into_response()
}

async fn oc_session_init(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    body: Option<Json<SessionInitBody>>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let directory = resolve_directory(&headers, query.directory.as_ref());
    if let Err(err) = state.ensure_session(&session_id, directory).await {
        return internal_error(err);
    }

    let body = body.map(|json| json.0).unwrap_or(SessionInitBody {
        provider_id: None,
        model_id: None,
        message_id: None,
    });

    if body.provider_id.is_none() && body.model_id.is_none() {
        return (StatusCode::OK, Json(json!(true))).into_response();
    }

    if body.provider_id.is_none() || body.model_id.is_none() {
        return bad_request("providerID and modelID are required when selecting a model");
    }

    let provider_id = body.provider_id.unwrap_or_else(|| "mock".to_string());
    let model_id = body.model_id.unwrap_or_else(|| "mock".to_string());

    let meta = {
        let mut projection = state.projection.lock().await;
        let Some(session) = projection.sessions.get_mut(&session_id) else {
            return not_found("Session not found");
        };
        let has_messages = !session.messages.is_empty();
        let selection_changed =
            session.meta.provider_id != provider_id || session.meta.model_id != model_id;
        if has_messages && selection_changed {
            return bad_request(MODEL_CHANGE_ERROR);
        }
        session.meta.provider_id = provider_id.clone();
        session.meta.model_id = model_id.clone();
        session.meta.agent = provider_to_agent(&provider_id);
        session.meta.updated_at = now_ms();
        session.meta.clone()
    };

    if let Err(err) = state.persist_session(&meta).await {
        return internal_error(err);
    }

    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_session_fork(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let parent = {
        let projection = state.projection.lock().await;
        projection.sessions.get(&session_id).cloned()
    };
    let Some(parent) = parent else {
        return not_found("Session not found");
    };

    let id = state.next_id("ses_");
    let now = now_ms();
    let directory = resolve_directory(&headers, query.directory.as_ref());
    let connection_id = state.current_connection_for_agent(&parent.meta.agent).await;

    let meta = SessionMeta {
        id: id.clone(),
        slug: format!("session-{id}"),
        project_id: state.project_id.clone(),
        directory,
        parent_id: Some(session_id),
        title: format!("Fork of {}", parent.meta.title),
        version: "0".to_string(),
        created_at: now,
        updated_at: now,
        share_url: None,
        permission_mode: parent.meta.permission_mode.clone(),
        agent: parent.meta.agent.clone(),
        provider_id: parent.meta.provider_id.clone(),
        model_id: parent.meta.model_id.clone(),
        agent_session_id: format!("acp_{}", state.next_id("ses_")),
        last_connection_id: connection_id,
        session_init_json: parent.meta.session_init_json.clone(),
        destroyed_at: None,
    };

    if let Err(err) = state.persist_session(&meta).await {
        return internal_error(err);
    }

    {
        let mut projection = state.projection.lock().await;
        projection.sessions.insert(
            id.clone(),
            SessionState {
                meta: meta.clone(),
                messages: Vec::new(),
                status: "idle".to_string(),
                always_permissions: HashSet::new(),
            },
        );
    }

    let value = session_to_value(&meta);
    state.emit_event(json!({"type":"session.created","properties":{"info":value}}));

    (StatusCode::OK, Json(value)).into_response()
}

async fn oc_session_diff() -> Response {
    (StatusCode::OK, Json(json!([]))).into_response()
}

async fn oc_session_todo() -> Response {
    (StatusCode::OK, Json(json!([]))).into_response()
}

async fn oc_session_summarize(Json(body): Json<Value>) -> Response {
    if body.get("providerID").is_none() || body.get("modelID").is_none() {
        return bad_request("providerID and modelID are required");
    }
    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_session_messages(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let projection = state.projection.lock().await;
    let Some(session) = projection.sessions.get(&session_id) else {
        return not_found("Session not found");
    };

    let values = session
        .messages
        .iter()
        .map(|record| json!({"info": record.info, "parts": record.parts}))
        .collect::<Vec<_>>();

    (StatusCode::OK, Json(values)).into_response()
}

async fn oc_session_prompt(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<PromptBody>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let directory = resolve_directory(&headers, query.directory.as_ref());
    let mut meta = match state.ensure_session(&session_id, directory.clone()).await {
        Ok(meta) => meta,
        Err(err) => return internal_error(err),
    };

    let explicit_model_selection = prompt_has_explicit_model_selection(&body);
    let requested_selection = resolve_selection_from_prompt(&body);
    if explicit_model_selection && requested_selection.is_none() {
        return bad_request("providerID and modelID are required when selecting a model");
    }

    let has_messages = {
        let projection = state.projection.lock().await;
        projection
            .sessions
            .get(&session_id)
            .map(|session| !session.messages.is_empty())
            .unwrap_or(false)
    };

    if let Some(selection) = requested_selection.as_ref() {
        let selection_changed =
            meta.provider_id != selection.provider_id || meta.model_id != selection.model_id;
        if has_messages && selection_changed {
            return bad_request(MODEL_CHANGE_ERROR);
        }
        meta.provider_id = selection.provider_id.clone();
        meta.model_id = selection.model_id.clone();
        meta.agent = selection.agent.clone();
    } else if let Some(agent) = body.agent.as_ref() {
        if has_messages && meta.agent != *agent {
            return bad_request(MODEL_CHANGE_ERROR);
        }
        meta.agent = agent.clone();
    }

    let parts_input = body.parts.unwrap_or_default();
    if parts_input.is_empty() {
        return bad_request("parts are required");
    }

    if let Some(session_mode) = {
        let projection = state.projection.lock().await;
        projection
            .sessions
            .get(&session_id)
            .and_then(|session| session.meta.permission_mode.clone())
    } {
        meta.permission_mode = Some(session_mode);
    }

    {
        let mut projection = state.projection.lock().await;
        if let Some(session) = projection.sessions.get_mut(&session_id) {
            session.meta.agent = meta.agent.clone();
            session.meta.provider_id = meta.provider_id.clone();
            session.meta.model_id = meta.model_id.clone();
            session.meta.updated_at = now_ms();
            meta = session.meta.clone();
        }
    }

    if let Err(err) = state.persist_session(&meta).await {
        return internal_error(err);
    }

    if let Err(err) = state.maybe_restore_session(&session_id).await {
        return internal_error(err);
    }

    // Re-read meta after maybe_restore_session, which may have generated a new
    // agent_session_id (e.g. when the agent changed from "mock" to a real agent
    // and the connection_id differs).
    {
        let projection = state.projection.lock().await;
        if let Some(session) = projection.sessions.get(&session_id) {
            meta = session.meta.clone();
        }
    }

    let user_message_id = body
        .message_id
        .clone()
        .unwrap_or_else(|| state.next_id("msg_"));
    let now = now_ms();

    let user_info = build_user_message(
        &session_id,
        &user_message_id,
        now,
        &meta.agent,
        &meta.provider_id,
        &meta.model_id,
        body.system.as_deref(),
    );
    let user_parts = normalize_parts(&session_id, &user_message_id, &parts_input);

    let replay_injected = state.pending_replay.lock().await.remove(&session_id);
    let outbound_prompt_parts = if let Some(replay_text) = replay_injected {
        let mut prompt = vec![json!({"type":"text", "text": replay_text})];
        prompt.extend(parts_input.clone());
        prompt
    } else {
        parts_input.clone()
    };

    let prompt_envelope = json!({
        "jsonrpc": "2.0",
        "id": state.next_id("oc_req_"),
        "method": "session/prompt",
        "params": {
            "sessionId": meta.agent_session_id,
            "prompt": outbound_prompt_parts,
            "sessionID": session_id,
            "message": {
                "info": user_info,
                "parts": user_parts,
            }
        }
    });
    if let Err(err) = state
        .persist_event(&session_id, "client", &prompt_envelope)
        .await
    {
        return internal_error(err);
    }

    state.emit_event(message_event("message.updated", &user_info));
    for part in &user_parts {
        state.emit_event(json!({
            "type":"message.part.updated",
            "properties":{
                "sessionID": session_id,
                "messageID": user_message_id,
                "part": part
            }
        }));
    }

    // Track the user message ID so the SSE translation task can set
    // parentID on assistant messages.
    state
        .last_user_message_id
        .lock()
        .await
        .insert(session_id.clone(), user_message_id.clone());

    if let Err(err) = set_session_status(&state, &session_id, "busy").await {
        return internal_error(err);
    }

    // -----------------------------------------------------------------------
    // ACP dispatch path — route to real agent processes when acp_dispatch is
    // configured and the resolved agent is not "mock".
    // -----------------------------------------------------------------------
    tracing::info!(
        session_id = %session_id,
        agent = %meta.agent,
        provider_id = %meta.provider_id,
        model_id = %meta.model_id,
        has_acp_dispatch = state.config.acp_dispatch.is_some(),
        "prompt dispatch decision"
    );
    if let Some(dispatch) = state.config.acp_dispatch.as_ref() {
        if meta.agent != "mock" {
            let server_id = meta.agent_session_id.clone();

            tracing::info!(server_id = %server_id, agent = %meta.agent, "entering ACP dispatch path");

            // Bootstrap the ACP server instance if this is the first prompt.
            let needs_init = !state.acp_initialized.lock().await.contains_key(&server_id);
            if needs_init {
                tracing::info!(server_id = %server_id, "bootstrapping ACP session (initialize + session/new)");
                // 1) initialize
                let init_id = state.next_id("oc_rpc_");
                let init_payload = json!({
                    "jsonrpc": "2.0",
                    "id": init_id,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": 1,
                        "capabilities": {},
                        "clientInfo": {
                            "name": "sandbox-agent-opencode-adapter",
                            "version": "0.1.0"
                        },
                        "_meta": {
                            "sandboxagent.dev": {
                                "agent": meta.agent.clone()
                            }
                        }
                    }
                });
                match dispatch
                    .post(&server_id, Some(&meta.agent), init_payload)
                    .await
                {
                    Ok(AcpDispatchResult::Response(ref resp)) => {
                        if let Some(err) = resp.get("error") {
                            tracing::error!(server_id = %server_id, error = %err, "ACP initialize returned JSON-RPC error");
                            let _ = set_session_status(&state, &session_id, "idle").await;
                            return internal_error(format!("ACP initialize error: {err}"));
                        }
                        tracing::info!(server_id = %server_id, "ACP initialize succeeded");
                    }
                    Ok(AcpDispatchResult::Accepted) => {
                        tracing::info!(server_id = %server_id, "ACP initialize accepted");
                    }
                    Err(err) => {
                        let _ = set_session_status(&state, &session_id, "idle").await;
                        return internal_error(format!("ACP initialize failed: {err}"));
                    }
                }

                // 2) session/new
                let new_id = state.next_id("oc_rpc_");
                let new_payload = json!({
                    "jsonrpc": "2.0",
                    "id": new_id,
                    "method": "session/new",
                    "params": {
                        "cwd": directory,
                        "mcpServers": [],
                        "_meta": {
                            "sandboxagent.dev": {
                                "model": meta.model_id.clone()
                            }
                        }
                    }
                });
                let acp_session_id = match dispatch.post(&server_id, None, new_payload).await {
                    Ok(AcpDispatchResult::Response(ref resp)) => {
                        if let Some(err) = resp.get("error") {
                            tracing::error!(server_id = %server_id, error = %err, "ACP session/new returned JSON-RPC error");
                            let _ = set_session_status(&state, &session_id, "idle").await;
                            return internal_error(format!("ACP session/new error: {err}"));
                        }
                        let sid = resp
                            .pointer("/result/sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        tracing::info!(server_id = %server_id, acp_session_id = %sid, "ACP session/new succeeded");
                        sid
                    }
                    Ok(AcpDispatchResult::Accepted) => {
                        tracing::info!(server_id = %server_id, "ACP session/new accepted");
                        String::new()
                    }
                    Err(err) => {
                        let _ = set_session_status(&state, &session_id, "idle").await;
                        return internal_error(format!("ACP session/new failed: {err}"));
                    }
                };

                // 3) Start SSE translation task.
                match dispatch.notification_stream(&server_id, None).await {
                    Ok(stream) => {
                        let state_for_task = state.clone();
                        let session_id_for_task = session_id.clone();
                        let directory_for_task = directory.clone();
                        let agent_for_task = meta.agent.clone();
                        let provider_for_task = meta.provider_id.clone();
                        let model_for_task = meta.model_id.clone();
                        tokio::spawn(acp_sse_translation_task(
                            state_for_task,
                            stream,
                            session_id_for_task,
                            directory_for_task,
                            agent_for_task,
                            provider_for_task,
                            model_for_task,
                        ));
                    }
                    Err(err) => {
                        warn!(
                            ?err,
                            "failed to open ACP SSE stream; events will not be translated"
                        );
                    }
                }

                state
                    .acp_initialized
                    .lock()
                    .await
                    .insert(server_id.clone(), acp_session_id);
            }

            // 4) Send session/prompt
            let acp_session_id = state
                .acp_initialized
                .lock()
                .await
                .get(&server_id)
                .cloned()
                .unwrap_or_default();
            let prompt_id = state.next_id("oc_rpc_");
            let prompt_payload = json!({
                "jsonrpc": "2.0",
                "id": prompt_id,
                "method": "session/prompt",
                "params": {
                    "sessionId": acp_session_id,
                    "prompt": outbound_prompt_parts,
                }
            });
            // dispatch.post() blocks until the agent returns the session/prompt
            // response.  The response is also broadcast to the notification stream
            // so the SSE translation task sees it in-order after all session/update
            // notifications and can emit session.idle at the right time.
            match dispatch.post(&server_id, None, prompt_payload).await {
                Ok(AcpDispatchResult::Response(ref resp)) => {
                    if let Some(err) = resp.get("error") {
                        tracing::error!(server_id = %server_id, error = %err, "ACP session/prompt returned JSON-RPC error");
                        let _ = set_session_status(&state, &session_id, "idle").await;
                        return internal_error(format!("ACP session/prompt error: {err}"));
                    }
                    tracing::info!(server_id = %server_id, "ACP session/prompt response received (turn completion delegated to SSE task)");
                }
                Ok(AcpDispatchResult::Accepted) => {
                    tracing::info!(server_id = %server_id, "ACP session/prompt accepted (streaming)");
                }
                Err(err) => {
                    let _ = set_session_status(&state, &session_id, "idle").await;
                    return internal_error(format!("ACP session/prompt failed: {err}"));
                }
            };

            // The SSE translation task handles session.idle and streamed
            // content, but the HTTP response needs the pending assistant
            // message envelope so the client can correlate future events.
            let assistant_message = build_assistant_message(
                &session_id,
                &format!("{user_message_id}_pending"),
                &user_message_id,
                now,
                &directory,
                &meta.agent,
                &meta.provider_id,
                &meta.model_id,
            );
            return (
                StatusCode::OK,
                Json(json!({
                    "info": assistant_message,
                    "parts": [],
                })),
            )
                .into_response();
        }
    }

    let prompt_text = parts_input
        .iter()
        .find_map(|part| part.get("text").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();

    let auto_allow = {
        let projection = state.projection.lock().await;
        projection
            .sessions
            .get(&session_id)
            .map(|session| session.always_permissions.contains("execute"))
            .unwrap_or(false)
    };

    if prompt_text.to_ascii_lowercase().contains("permission") {
        let request_id = state.next_id("perm_");
        let permission_request = json!({
            "id": request_id,
            "sessionID": session_id,
            "permission": "execute",
            "patterns": ["*"],
            "metadata": {},
            "always": [],
        });
        let asked = json!({
            "jsonrpc":"2.0",
            "method":"_sandboxagent/opencode/permission_asked",
            "params":{"request": permission_request}
        });
        if let Err(err) = state.persist_event(&session_id, "agent", &asked).await {
            return internal_error(err);
        }
        state.emit_event(json!({"type":"permission.asked","properties":permission_request}));

        if auto_allow {
            if let Err(err) =
                resolve_permission_inner(&state, &session_id, &request_id, "always").await
            {
                return internal_error(err);
            }
        }

        let assistant_info = build_assistant_message(
            &session_id,
            &format!("{user_message_id}_pending"),
            &user_message_id,
            now,
            &directory,
            &meta.agent,
            &meta.provider_id,
            &meta.model_id,
        );

        return (
            StatusCode::OK,
            Json(json!({"info": assistant_info, "parts": []})),
        )
            .into_response();
    }

    if prompt_text.to_ascii_lowercase().contains("question") {
        let request_id = state.next_id("q_");
        let question_request = json!({
            "id": request_id,
            "sessionID": session_id,
            "questions": [{
                "question": "Choose one option",
                "header": "Question",
                "options": [
                    {"label":"Yes","description":"Accept"},
                    {"label":"No","description":"Reject"}
                ],
                "multiple": false,
                "custom": true
            }]
        });
        let asked = json!({
            "jsonrpc":"2.0",
            "method":"_sandboxagent/opencode/question_asked",
            "params":{"request": question_request}
        });
        if let Err(err) = state.persist_event(&session_id, "agent", &asked).await {
            return internal_error(err);
        }
        state.emit_event(json!({"type":"question.asked","properties":question_request}));

        let assistant_info = build_assistant_message(
            &session_id,
            &format!("{user_message_id}_pending"),
            &user_message_id,
            now,
            &directory,
            &meta.agent,
            &meta.provider_id,
            &meta.model_id,
        );

        return (
            StatusCode::OK,
            Json(json!({"info": assistant_info, "parts": []})),
        )
            .into_response();
    }

    tokio::time::sleep(Duration::from_millis(120)).await;

    if prompt_text.to_ascii_lowercase().contains("error") {
        state.emit_event(json!({
            "type":"session.error",
            "properties":{
                "sessionID": session_id,
                "error": {"name":"UnknownError","data":{"message":"mock process crashed"}}
            }
        }));
        let err_env = json!({
            "jsonrpc":"2.0",
            "method":"_sandboxagent/opencode/error",
            "params":{"message":"mock process crashed"}
        });
        if let Err(err) = state.persist_event(&session_id, "agent", &err_env).await {
            return internal_error(err);
        }
        if let Err(err) = set_session_status(&state, &session_id, "idle").await {
            return internal_error(err);
        }

        let assistant_info = build_assistant_message(
            &session_id,
            &format!("{user_message_id}_error"),
            &user_message_id,
            now,
            &directory,
            &meta.agent,
            &meta.provider_id,
            &meta.model_id,
        );

        return (
            StatusCode::OK,
            Json(json!({"info": assistant_info, "parts": []})),
        )
            .into_response();
    }

    let assistant_message_id = format!("{user_message_id}_assistant");
    let assistant_info = build_completed_assistant_message(
        &session_id,
        &assistant_message_id,
        &user_message_id,
        now,
        &directory,
        &meta.agent,
        &meta.provider_id,
        &meta.model_id,
    );

    let mut assistant_parts = Vec::<Value>::new();

    if prompt_text.to_ascii_lowercase().contains("tool") {
        let tool_part = json!({
            "id": state.next_id("part_"),
            "sessionID": session_id,
            "messageID": assistant_message_id,
            "type": "tool",
            "callID": state.next_id("call_"),
            "tool": "bash",
            "state": {
                "status": "completed",
                "input": {"command": "echo tool"},
                "output": "ok",
                "title": "bash",
                "metadata": {},
                "time": {"start": now, "end": now}
            }
        });
        let file_part = json!({
            "id": state.next_id("part_"),
            "sessionID": session_id,
            "messageID": assistant_message_id,
            "type": "file",
            "mime": "text/plain",
            "filename": "README.md",
            "url": "file:///README.md",
        });

        assistant_parts.push(tool_part.clone());
        assistant_parts.push(file_part.clone());

        state.emit_event(json!({
            "type":"message.part.updated",
            "properties":{
                "sessionID": session_id,
                "messageID": assistant_message_id,
                "part": tool_part
            }
        }));
        state.emit_event(json!({
            "type":"message.part.updated",
            "properties":{
                "sessionID": session_id,
                "messageID": assistant_message_id,
                "part": file_part
            }
        }));
        state.emit_event(
            json!({"type":"file.edited","properties":{"sessionID":session_id, "path":"README.md"}}),
        );
    } else {
        let response_text = if prompt_text.trim().is_empty() {
            "OK".to_string()
        } else {
            prompt_text.clone()
        };
        let text_part = json!({
            "id": state.next_id("part_"),
            "sessionID": session_id,
            "messageID": assistant_message_id,
            "type": "text",
            "text": response_text,
        });
        assistant_parts.push(text_part.clone());
        state.emit_event(json!({
            "type":"message.part.updated",
            "properties":{
                "sessionID": session_id,
                "messageID": assistant_message_id,
                "part": text_part
            }
        }));
    }

    let assistant_env = json!({
        "jsonrpc": "2.0",
        "method": "_sandboxagent/opencode/message",
        "params": {
            "message": {
                "info": assistant_info,
                "parts": assistant_parts,
            }
        }
    });
    if let Err(err) = state
        .persist_event(&session_id, "agent", &assistant_env)
        .await
    {
        return internal_error(err);
    }

    state.emit_event(message_event("message.updated", &assistant_info));

    if let Err(err) = set_session_status(&state, &session_id, "idle").await {
        return internal_error(err);
    }

    let projection = state.projection.lock().await;
    let parts = projection
        .sessions
        .get(&session_id)
        .and_then(|session| {
            session
                .messages
                .iter()
                .find(|message| {
                    message.info.get("id").and_then(Value::as_str)
                        == Some(assistant_message_id.as_str())
                })
                .map(|message| message.parts.clone())
        })
        .unwrap_or_default();

    (
        StatusCode::OK,
        Json(json!({"info": assistant_info, "parts": parts})),
    )
        .into_response()
}

async fn oc_session_message_get(
    State(state): State<Arc<AdapterState>>,
    Path((session_id, message_id)): Path<(String, String)>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let projection = state.projection.lock().await;
    let Some(session) = projection.sessions.get(&session_id) else {
        return not_found("Session not found");
    };

    let Some(record) = session.messages.iter().find(|message| {
        message.info.get("id").and_then(Value::as_str) == Some(message_id.as_str())
    }) else {
        return not_found("Message not found");
    };

    (
        StatusCode::OK,
        Json(json!({
            "id": message_id,
            "info": record.info,
            "parts": record.parts,
        })),
    )
        .into_response()
}

async fn oc_part_update(
    State(state): State<Arc<AdapterState>>,
    Path((session_id, message_id, part_id)): Path<(String, String, String)>,
    Json(mut part): Json<Value>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    if let Some(obj) = part.as_object_mut() {
        obj.insert("id".to_string(), json!(part_id.clone()));
        obj.insert("sessionID".to_string(), json!(session_id.clone()));
        obj.insert("messageID".to_string(), json!(message_id.clone()));
    }

    {
        let mut projection = state.projection.lock().await;
        if let Some(session) = projection.sessions.get_mut(&session_id) {
            if let Some(message) = session.messages.iter_mut().find(|record| {
                record.info.get("id").and_then(Value::as_str) == Some(message_id.as_str())
            }) {
                if let Some(existing) = message.parts.iter_mut().find(|candidate| {
                    candidate.get("id").and_then(Value::as_str) == Some(part_id.as_str())
                }) {
                    *existing = part.clone();
                } else {
                    message.parts.push(part.clone());
                }
            }
        }
    }

    state.emit_event(json!({
        "type":"message.part.updated",
        "properties":{
            "sessionID": session_id,
            "messageID": message_id,
            "part": part.clone()
        }
    }));

    (StatusCode::OK, Json(part)).into_response()
}

async fn oc_part_delete(
    State(state): State<Arc<AdapterState>>,
    Path((session_id, message_id, part_id)): Path<(String, String, String)>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    {
        let mut projection = state.projection.lock().await;
        if let Some(session) = projection.sessions.get_mut(&session_id) {
            if let Some(message) = session.messages.iter_mut().find(|record| {
                record.info.get("id").and_then(Value::as_str) == Some(message_id.as_str())
            }) {
                message.parts.retain(|part| {
                    part.get("id").and_then(Value::as_str) != Some(part_id.as_str())
                });
            }
        }
    }

    state.emit_event(json!({
        "type":"message.part.removed",
        "properties": {"sessionID": session_id, "messageID": message_id, "partID": part_id}
    }));

    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_session_prompt_async(
    State(state): State<Arc<AdapterState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    query: Query<DirectoryQuery>,
    Json(body): Json<PromptBody>,
) -> Response {
    let _ = oc_session_prompt(State(state), Path(session_id), headers, query, Json(body)).await;

    StatusCode::NO_CONTENT.into_response()
}

async fn oc_permission_respond(
    State(state): State<Arc<AdapterState>>,
    Path((session_id, permission_id)): Path<(String, String)>,
    Json(body): Json<PermissionRespondBody>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let reply = match body.response.as_deref() {
        Some("allow") => "once",
        Some("deny") => "reject",
        Some("always") => "always",
        _ => "once",
    };

    if let Err(err) = resolve_permission_inner(&state, &session_id, &permission_id, reply).await {
        return internal_error(err);
    }

    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_permission_reply(
    State(state): State<Arc<AdapterState>>,
    Path(request_id): Path<String>,
    Json(body): Json<PermissionReplyBody>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let reply = body.reply.unwrap_or_else(|| "once".to_string());
    let session_id = {
        let projection = state.projection.lock().await;
        projection
            .permissions
            .get(&request_id)
            .and_then(|value| value.get("sessionID"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    };

    let Some(session_id) = session_id else {
        return not_found("Permission request not found");
    };

    if let Err(err) = resolve_permission_inner(&state, &session_id, &request_id, &reply).await {
        return internal_error(err);
    }

    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_permission_list(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let projection = state.projection.lock().await;
    let mut values = projection.permissions.values().cloned().collect::<Vec<_>>();
    values.sort_by(|a, b| {
        let a_id = a.get("id").and_then(Value::as_str).unwrap_or_default();
        let b_id = b.get("id").and_then(Value::as_str).unwrap_or_default();
        a_id.cmp(b_id)
    });
    (StatusCode::OK, Json(values)).into_response()
}

async fn oc_question_list(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let projection = state.projection.lock().await;
    let mut values = projection.questions.values().cloned().collect::<Vec<_>>();
    values.sort_by(|a, b| {
        let a_id = a.get("id").and_then(Value::as_str).unwrap_or_default();
        let b_id = b.get("id").and_then(Value::as_str).unwrap_or_default();
        a_id.cmp(b_id)
    });
    (StatusCode::OK, Json(values)).into_response()
}

async fn oc_question_reply(
    State(state): State<Arc<AdapterState>>,
    Path(request_id): Path<String>,
    Json(body): Json<QuestionReplyBody>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let session_id = {
        let projection = state.projection.lock().await;
        projection
            .questions
            .get(&request_id)
            .and_then(|value| value.get("sessionID"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    };

    let Some(session_id) = session_id else {
        return not_found("Question request not found");
    };

    let answers = body.answers.unwrap_or_default();

    // Forward the answer to the ACP agent if there's a pending request.
    let pending = state.acp_request_ids.lock().await.remove(&request_id);

    if let Some(pending) = &pending {
        if let Some(dispatch) = state.config.acp_dispatch.as_ref() {
            let agent_session_id = {
                let projection = state.projection.lock().await;
                projection
                    .sessions
                    .get(&session_id)
                    .map(|s| s.meta.agent_session_id.clone())
            };
            if let Some(server_id) = agent_session_id {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": pending.jsonrpc_id,
                    "result": {
                        "outcome": "selected",
                        "_meta": {
                            "sandboxagent.dev": {
                                "answers": answers
                            }
                        }
                    }
                });
                if let Err(err) = dispatch.post(&server_id, None, response).await {
                    warn!(?err, "failed to forward question response to ACP agent");
                }
            }
        }
    }

    let envelope = json!({
        "jsonrpc":"2.0",
        "method":"_sandboxagent/opencode/question_replied",
        "params":{"requestID": request_id, "answers": answers}
    });
    if let Err(err) = state.persist_event(&session_id, "agent", &envelope).await {
        return internal_error(err);
    }

    state.emit_event(json!({
        "type":"question.replied",
        "properties": {
            "sessionID": session_id,
            "requestID": request_id,
            "answers": answers,
        }
    }));

    if let Err(err) = set_session_status(&state, &session_id, "idle").await {
        return internal_error(err);
    }

    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_question_reject(
    State(state): State<Arc<AdapterState>>,
    Path(request_id): Path<String>,
) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }

    let session_id = {
        let projection = state.projection.lock().await;
        projection
            .questions
            .get(&request_id)
            .and_then(|value| value.get("sessionID"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    };

    let Some(session_id) = session_id else {
        return not_found("Question request not found");
    };

    // Forward rejection to the ACP agent if there's a pending request.
    let pending = state.acp_request_ids.lock().await.remove(&request_id);

    if let Some(pending) = &pending {
        if let Some(dispatch) = state.config.acp_dispatch.as_ref() {
            let agent_session_id = {
                let projection = state.projection.lock().await;
                projection
                    .sessions
                    .get(&session_id)
                    .map(|s| s.meta.agent_session_id.clone())
            };
            if let Some(server_id) = agent_session_id {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": pending.jsonrpc_id,
                    "result": {
                        "outcome": "rejected"
                    }
                });
                if let Err(err) = dispatch.post(&server_id, None, response).await {
                    warn!(?err, "failed to forward question rejection to ACP agent");
                }
            }
        }
    }

    let envelope = json!({
        "jsonrpc":"2.0",
        "method":"_sandboxagent/opencode/question_rejected",
        "params":{"requestID": request_id}
    });
    if let Err(err) = state.persist_event(&session_id, "agent", &envelope).await {
        return internal_error(err);
    }

    state.emit_event(json!({
        "type":"question.rejected",
        "properties": {
            "sessionID": session_id,
            "requestID": request_id,
        }
    }));

    if let Err(err) = set_session_status(&state, &session_id, "idle").await {
        return internal_error(err);
    }

    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn oc_provider_list(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    (StatusCode::OK, Json(provider_payload(&state))).into_response()
}

async fn oc_provider_auth(State(state): State<Arc<AdapterState>>) -> Response {
    if let Err(err) = state.ensure_initialized().await {
        return internal_error(err);
    }
    (StatusCode::OK, Json(json!({"mock": [], "amp": []}))).into_response()
}

async fn oc_provider_oauth_authorize(Path(provider_id): Path<String>) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "url": format!("https://auth.local/{provider_id}/authorize"),
            "method": "auto",
            "instructions": "stub",
        })),
    )
        .into_response()
}

async fn oc_provider_oauth_callback() -> Response {
    (StatusCode::OK, Json(json!(true))).into_response()
}

async fn resolve_permission_inner(
    state: &Arc<AdapterState>,
    session_id: &str,
    permission_id: &str,
    reply: &str,
) -> Result<(), String> {
    // If there's a pending ACP request for this permission, forward the
    // response to the agent process.
    let pending = state.acp_request_ids.lock().await.remove(permission_id);

    if let Some(pending) = &pending {
        if let Some(dispatch) = state.config.acp_dispatch.as_ref() {
            let agent_session_id = {
                let projection = state.projection.lock().await;
                projection
                    .sessions
                    .get(session_id)
                    .map(|s| s.meta.agent_session_id.clone())
            };
            if let Some(server_id) = agent_session_id {
                let option_kind = match reply {
                    "always" => "allow_always",
                    "reject" | "deny" => "reject_once",
                    _ => "allow_once",
                };
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": pending.jsonrpc_id,
                    "result": {
                        "outcome": "selected",
                        "selectedOption": {
                            "kind": option_kind
                        }
                    }
                });
                if let Err(err) = dispatch.post(&server_id, None, response).await {
                    warn!(?err, "failed to forward permission response to ACP agent");
                }
            }
        }
    }

    let envelope = json!({
        "jsonrpc":"2.0",
        "method":"_sandboxagent/opencode/permission_replied",
        "params": {
            "requestID": permission_id,
            "reply": reply,
        }
    });
    state.persist_event(session_id, "agent", &envelope).await?;

    state.emit_event(json!({
        "type":"permission.replied",
        "properties": {
            "sessionID": session_id,
            "requestID": permission_id,
            "reply": reply,
        }
    }));

    if reply == "always" {
        let mut projection = state.projection.lock().await;
        if let Some(session) = projection.sessions.get_mut(session_id) {
            session.always_permissions.insert("execute".to_string());
        }
    }

    set_session_status(state, session_id, "idle").await
}

async fn set_session_status(
    state: &Arc<AdapterState>,
    session_id: &str,
    status: &str,
) -> Result<(), String> {
    let updated_meta = {
        let mut projection = state.projection.lock().await;
        let Some(session) = projection.sessions.get_mut(session_id) else {
            return Err(format!("session '{session_id}' not found"));
        };
        session.status = status.to_string();
        session.meta.updated_at = now_ms();
        session.meta.clone()
    };
    state.persist_session(&updated_meta).await?;

    let env = json!({
        "jsonrpc":"2.0",
        "method":"_sandboxagent/opencode/status",
        "params":{"status": status}
    });
    state.persist_event(session_id, "agent", &env).await?;

    state.emit_event(json!({
        "type":"session.status",
        "properties": {
            "sessionID": session_id,
            "status": {"type": status},
        }
    }));

    if status == "idle" {
        state.emit_event(json!({
            "type":"session.idle",
            "properties": {"sessionID": session_id}
        }));
    }

    Ok(())
}

fn apply_envelope(projection: &mut Projection, session_id: &str, _sender: &str, payload: &Value) {
    let Some(method) = payload.get("method").and_then(Value::as_str) else {
        return;
    };

    match method {
        "session/prompt" => {
            if let Some(message) = payload
                .get("params")
                .and_then(|params| params.get("message"))
                .and_then(Value::as_object)
            {
                let info = message.get("info").cloned().unwrap_or_else(|| json!({}));
                let parts = message
                    .get("parts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Some(session) = projection.sessions.get_mut(session_id) {
                    upsert_message(session, info, parts);
                    session.status = "busy".to_string();
                }
            }
        }
        "_sandboxagent/opencode/message" => {
            if let Some(message) = payload
                .get("params")
                .and_then(|params| params.get("message"))
                .and_then(Value::as_object)
            {
                let info = message.get("info").cloned().unwrap_or_else(|| json!({}));
                let parts = message
                    .get("parts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Some(session) = projection.sessions.get_mut(session_id) {
                    upsert_message(session, info, parts);
                }
            }
        }
        "_sandboxagent/opencode/status" => {
            let status = payload
                .get("params")
                .and_then(|params| params.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("idle")
                .to_string();
            if let Some(session) = projection.sessions.get_mut(session_id) {
                session.status = status;
            }
        }
        "_sandboxagent/opencode/permission_asked" => {
            if let Some(request) = payload
                .get("params")
                .and_then(|params| params.get("request"))
                .cloned()
            {
                if let Some(id) = request.get("id").and_then(Value::as_str) {
                    projection.permissions.insert(id.to_string(), request);
                }
                if let Some(session) = projection.sessions.get_mut(session_id) {
                    session.status = "busy".to_string();
                }
            }
        }
        "_sandboxagent/opencode/permission_replied" => {
            if let Some(request_id) = payload
                .get("params")
                .and_then(|params| params.get("requestID"))
                .and_then(Value::as_str)
            {
                let reply = payload
                    .get("params")
                    .and_then(|params| params.get("reply"))
                    .and_then(Value::as_str)
                    .unwrap_or("once");
                projection.permissions.remove(request_id);
                if reply == "always" {
                    if let Some(session) = projection.sessions.get_mut(session_id) {
                        session.always_permissions.insert("execute".to_string());
                    }
                }
            }
        }
        "_sandboxagent/opencode/question_asked" => {
            if let Some(request) = payload
                .get("params")
                .and_then(|params| params.get("request"))
                .cloned()
            {
                if let Some(id) = request.get("id").and_then(Value::as_str) {
                    projection.questions.insert(id.to_string(), request);
                }
                if let Some(session) = projection.sessions.get_mut(session_id) {
                    session.status = "busy".to_string();
                }
            }
        }
        "_sandboxagent/opencode/question_replied" => {
            if let Some(request_id) = payload
                .get("params")
                .and_then(|params| params.get("requestID"))
                .and_then(Value::as_str)
            {
                projection.questions.remove(request_id);
            }
        }
        "_sandboxagent/opencode/question_rejected" => {
            if let Some(request_id) = payload
                .get("params")
                .and_then(|params| params.get("requestID"))
                .and_then(Value::as_str)
            {
                projection.questions.remove(request_id);
            }
        }
        _ => {}
    }
}

fn upsert_message(session: &mut SessionState, info: Value, parts: Vec<Value>) {
    let message_id = info.get("id").and_then(Value::as_str).unwrap_or_default();
    if let Some(existing) = session
        .messages
        .iter_mut()
        .find(|message| message.info.get("id").and_then(Value::as_str) == Some(message_id))
    {
        // Merge new info fields into existing info rather than replacing.
        // This prevents partial info (e.g. just {"id":"..."}) from overwriting
        // a complete record with role, parentID, etc.
        if let (Some(existing_obj), Some(new_obj)) =
            (existing.info.as_object_mut(), info.as_object())
        {
            for (key, value) in new_obj {
                existing_obj.insert(key.clone(), value.clone());
            }
        } else {
            existing.info = info;
        }
        for part in parts {
            let part_id = part.get("id").and_then(Value::as_str).unwrap_or_default();
            if let Some(existing_part) = existing
                .parts
                .iter_mut()
                .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(part_id))
            {
                *existing_part = part;
            } else {
                existing.parts.push(part);
            }
        }
        return;
    }

    session.messages.push(MessageRecord { info, parts });
}

fn provider_payload(state: &Arc<AdapterState>) -> Value {
    // Use pre-built provider data from config when available (built from
    // real agent config options in router.rs).
    if let Some(payload) = state.config.provider_payload.as_ref() {
        return payload.clone();
    }

    // Fallback: hardcoded mock/amp/claude/codex list for standalone testing.
    let mock_model = model_entry("mock", "Mock", "Mock", true, true, true, true, 8192, 4096);
    let amp_model = model_entry(
        "smart", "Smart", "Amp", false, false, true, true, 8192, 4096,
    );
    let claude_default = model_entry(
        "default",
        "Default (recommended)",
        "Claude",
        false,
        false,
        true,
        true,
        200_000,
        8_192,
    );
    let claude_sonnet = model_entry(
        "sonnet", "Sonnet", "Claude", false, false, true, true, 200_000, 8_192,
    );
    let codex_default = model_entry(
        "gpt-5", "GPT-5", "Codex", true, true, true, true, 200_000, 16_384,
    );

    json!({
        "all": [
            {
                "id": "mock",
                "name": "Mock",
                "env": [],
                "models": { "mock": mock_model },
            },
            {
                "id": "amp",
                "name": "Amp",
                "env": [],
                "models": { "smart": amp_model },
            }
            ,
            {
                "id": "claude",
                "name": "Claude",
                "env": [],
                "models": {
                    "default": claude_default,
                    "sonnet": claude_sonnet,
                },
            },
            {
                "id": "codex",
                "name": "Codex",
                "env": [],
                "models": { "gpt-5": codex_default },
            }
        ],
        "default": {
            "mock": "mock",
            "amp": "smart",
            "claude": "default",
            "codex": "gpt-5",
        },
        "connected": ["mock", "amp", "claude", "codex"],
    })
}

fn model_entry(
    id: &str,
    name: &str,
    family: &str,
    attachment: bool,
    reasoning: bool,
    temperature: bool,
    tool_call: bool,
    context: i64,
    output: i64,
) -> Value {
    json!({
        "id": id,
        "name": name,
        "family": family,
        "release_date": "1970-01-01",
        "attachment": attachment,
        "reasoning": reasoning,
        "temperature": temperature,
        "tool_call": tool_call,
        "limit": {
            "context": context,
            "output": output,
        },
        "options": {},
    })
}

fn build_user_message(
    session_id: &str,
    message_id: &str,
    now: i64,
    agent: &str,
    provider_id: &str,
    model_id: &str,
    system: Option<&str>,
) -> Value {
    let mut value = json!({
        "id": message_id,
        "sessionID": session_id,
        "role": "user",
        "time": {"created": now, "completed": now},
        "agent": agent,
        "model": {
            "providerID": provider_id,
            "modelID": model_id,
        },
    });

    if let Some(system) = system {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("system".to_string(), json!(system));
        }
    }

    value
}

fn build_assistant_message(
    session_id: &str,
    message_id: &str,
    parent_id: &str,
    now: i64,
    directory: &str,
    agent: &str,
    provider_id: &str,
    model_id: &str,
) -> Value {
    json!({
        "id": message_id,
        "sessionID": session_id,
        "role": "assistant",
        "time": {"created": now},
        "parentID": parent_id,
        "modelID": model_id,
        "providerID": provider_id,
        "mode": "default",
        "agent": agent,
        "finish": "stop",
        "path": {
            "cwd": directory,
            "root": directory,
        },
        "cost": 0,
        "tokens": {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache": {"read": 0, "write": 0},
        },
    })
}

/// Build a finalized assistant message with `time.completed` set.
fn build_completed_assistant_message(
    session_id: &str,
    message_id: &str,
    parent_id: &str,
    now: i64,
    directory: &str,
    agent: &str,
    provider_id: &str,
    model_id: &str,
) -> Value {
    json!({
        "id": message_id,
        "sessionID": session_id,
        "role": "assistant",
        "time": {"created": now, "completed": now},
        "parentID": parent_id,
        "modelID": model_id,
        "providerID": provider_id,
        "mode": "default",
        "agent": agent,
        "finish": "stop",
        "path": {
            "cwd": directory,
            "root": directory,
        },
        "cost": 0,
        "tokens": {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache": {"read": 0, "write": 0},
        },
    })
}

/// Wrap a message info Value into a `message.updated` SSE event, matching
/// the reference OpenCode format which includes `sessionID` at the
/// `properties` level alongside `info`.
fn message_event(event_type: &str, message: &Value) -> Value {
    let session_id = message
        .get("sessionID")
        .and_then(Value::as_str)
        .map(|v| v.to_string());
    let mut props = serde_json::Map::new();
    props.insert("info".to_string(), message.clone());
    if let Some(session_id) = session_id {
        props.insert("sessionID".to_string(), json!(session_id));
    }
    json!({
        "type": event_type,
        "properties": Value::Object(props),
    })
}

fn normalize_parts(session_id: &str, message_id: &str, input: &[Value]) -> Vec<Value> {
    input
        .iter()
        .enumerate()
        .map(|(index, part)| {
            let id = part
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("part_{}_{}", message_id, index));

            if let Some(text) = part.get("text").and_then(Value::as_str) {
                json!({
                    "id": id,
                    "sessionID": session_id,
                    "messageID": message_id,
                    "type": "text",
                    "text": text,
                })
            } else {
                let mut cloned = part.clone();
                if let Some(obj) = cloned.as_object_mut() {
                    obj.insert("id".to_string(), json!(id));
                    obj.insert("sessionID".to_string(), json!(session_id));
                    obj.insert("messageID".to_string(), json!(message_id));
                }
                cloned
            }
        })
        .collect()
}

fn session_to_value(meta: &SessionMeta) -> Value {
    let mut value = json!({
        "id": meta.id,
        "slug": meta.slug,
        "projectID": meta.project_id,
        "directory": meta.directory,
        "title": meta.title,
        "version": meta.version,
        "time": {
            "created": meta.created_at,
            "updated": meta.updated_at,
        },
        // Compatibility extras used by tests and bridge logic.
        "agent": meta.agent,
        "model": meta.model_id,
        "providerID": meta.provider_id,
    });

    if let Some(parent_id) = &meta.parent_id {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("parentID".to_string(), json!(parent_id));
        }
    }

    if let Some(share_url) = &meta.share_url {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("share".to_string(), json!({"url": share_url}));
        }
    }

    if let Some(permission_mode) = &meta.permission_mode {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("permissionMode".to_string(), json!(permission_mode));
        }
    }

    value
}

fn provider_to_agent(provider_id: &str) -> String {
    match provider_id {
        "amp" => "amp".to_string(),
        "codex" => "codex".to_string(),
        "claude" => "claude".to_string(),
        "opencode" => "opencode".to_string(),
        _ => "mock".to_string(),
    }
}

#[derive(Debug, Clone)]
struct RequestedSelection {
    provider_id: String,
    model_id: String,
    agent: String,
}

fn prompt_has_explicit_model_selection(body: &PromptBody) -> bool {
    body.model.is_some() || body.provider_id.is_some() || body.model_id.is_some()
}

fn resolve_selection_from_prompt(body: &PromptBody) -> Option<RequestedSelection> {
    let mut provider_id = body.provider_id.clone().or_else(|| {
        body.model
            .as_ref()
            .and_then(|model| model.provider_id.clone())
    });
    let mut model_id = body
        .model_id
        .clone()
        .or_else(|| body.model.as_ref().and_then(|model| model.model_id.clone()));

    if provider_id.is_none() {
        if let Some(agent) = body.agent.as_deref() {
            if let Some((default_provider, default_model)) = default_for_agent(agent) {
                provider_id = Some(default_provider.to_string());
                if model_id.is_none() {
                    model_id = Some(default_model.to_string());
                }
            }
        }
    }

    if provider_id.is_none() {
        if let Some(model) = model_id.as_deref() {
            provider_id = provider_for_model(model).map(ToOwned::to_owned);
        }
    }

    if model_id.is_none() {
        if let Some(provider) = provider_id.as_deref() {
            model_id = default_model_for_provider(provider).map(ToOwned::to_owned);
        }
    }

    let provider_id = provider_id?;
    let model_id = model_id?;
    Some(RequestedSelection {
        agent: provider_to_agent(&provider_id),
        provider_id,
        model_id,
    })
}

fn default_model_for_provider(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "mock" => Some("mock"),
        "amp" => Some("smart"),
        "claude" => Some("default"),
        "codex" => Some("gpt-5"),
        _ => None,
    }
}

fn provider_for_model(model_id: &str) -> Option<&'static str> {
    match model_id {
        "mock" => Some("mock"),
        "smart" | "rush" | "deep" | "free" => Some("amp"),
        _ if model_id.starts_with("amp-") => Some("amp"),
        "default" | "sonnet" | "haiku" | "opus" => Some("claude"),
        _ if model_id.starts_with("claude-") => Some("claude"),
        _ if model_id.starts_with("gpt-") => Some("codex"),
        _ if model_id.contains('/') => Some("opencode"),
        _ if model_id.starts_with("opencode/") => Some("opencode"),
        _ => None,
    }
}

fn default_for_agent(agent: &str) -> Option<(&'static str, &'static str)> {
    match agent {
        "mock" => Some(("mock", "mock")),
        "amp" => Some(("amp", "smart")),
        "claude" => Some(("claude", "default")),
        "codex" => Some(("codex", "gpt-5")),
        _ => None,
    }
}

fn build_replay_text(events: &[Value], max_chars: usize) -> Option<String> {
    if events.is_empty() {
        return None;
    }

    let prefix = "Previous session history is replayed below as JSON-RPC envelopes. Use it as context before responding to the latest user prompt.\n";
    let mut text = prefix.to_string();

    for event in events {
        let line = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
        if text.len() + line.len() + 1 > max_chars {
            text.push_str("\n[history truncated]");
            break;
        }
        text.push_str(&line);
        text.push('\n');
    }

    Some(text)
}

fn parse_last_event_id(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn resolve_directory(headers: &HeaderMap, query_directory: Option<&String>) -> String {
    if let Some(value) = query_directory {
        return value.clone();
    }

    if let Ok(value) = std::env::var("OPENCODE_COMPAT_DIRECTORY") {
        if !value.trim().is_empty() {
            return value;
        }
    }

    if let Some(value) = headers
        .get("x-opencode-directory")
        .and_then(|v| v.to_str().ok())
    {
        if !value.trim().is_empty() {
            return value.to_string();
        }
    }

    std::env::current_dir()
        .ok()
        .and_then(|path| path.to_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "/".to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn runtime_unique_seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ ((std::process::id() as u64) << 32)
}

// ---------------------------------------------------------------------------
// ACP SSE event translation — reads the raw ACP SSE stream from the agent
// process and emits translated OpenCode-compatible events.
// ---------------------------------------------------------------------------

async fn acp_sse_translation_task(
    state: Arc<AdapterState>,
    mut stream: AcpPayloadStream,
    session_id: String,
    directory: String,
    agent: String,
    provider_id: String,
    model_id: String,
) {
    tracing::info!(session_id = %session_id, agent = %agent, "ACP SSE translation task started");

    // Running assistant message ID (set on first update, used to group parts).
    let mut assistant_message_id: Option<String> = None;
    let mut part_counter: u64 = 0;
    // Accumulated text for the current streaming text part.
    let mut text_accum = String::new();
    let mut text_part_id: Option<String> = None;

    while let Some(payload) = stream.next().await {
        // Determine whether this is a notification (no `id`) or a response.
        let method = payload.get("method").and_then(Value::as_str);
        let has_result = payload.get("result").is_some();
        let has_error = payload.get("error").is_some();
        let jsonrpc_id = payload.get("id").cloned();

        tracing::debug!(
            session_id = %session_id,
            method = ?method,
            has_result,
            has_error,
            "ACP SSE event received"
        );

        match method {
            // --- Text / tool streaming updates ---
            Some("session/update") => {
                // Lazily assign an assistant_message_id for grouping parts.
                // Only set it here (not for every event) so that response
                // events for initialize/session/new don't accidentally set
                // it and trigger the turn-completion guard.
                if assistant_message_id.is_none() {
                    // Derive from the user message ID so that lexicographic
                    // sorting in the TUI places the assistant AFTER the user.
                    let user_id = state
                        .last_user_message_id
                        .lock()
                        .await
                        .get(&*session_id)
                        .cloned()
                        .unwrap_or_else(|| state.next_id("msg_"));
                    assistant_message_id = Some(format!("{user_id}_assistant"));
                }
                let msg_id = assistant_message_id.as_deref().unwrap();
                let params = payload.get("params").cloned().unwrap_or(json!({}));
                translate_session_update(
                    &state,
                    &session_id,
                    msg_id,
                    &mut part_counter,
                    &mut text_accum,
                    &mut text_part_id,
                    &directory,
                    &agent,
                    &provider_id,
                    &model_id,
                    &params,
                )
                .await;
            }

            // --- Permission request from agent ---
            Some("session/request_permission") => {
                let request_id = state.next_id("perm_");
                let params = payload.get("params").cloned().unwrap_or(json!({}));
                let permission_request = json!({
                    "id": request_id,
                    "sessionID": session_id,
                    "permission": params.get("permission").and_then(Value::as_str).unwrap_or("execute"),
                    "patterns": params.get("patterns").cloned().unwrap_or(json!(["*"])),
                    "metadata": params.get("metadata").cloned().unwrap_or(json!({})),
                    "always": [],
                });

                // Save the mapping so we can respond to the agent when the user replies.
                if let Some(jrpc_id) = jsonrpc_id {
                    state.acp_request_ids.lock().await.insert(
                        request_id.clone(),
                        AcpPendingRequest {
                            opencode_session_id: session_id.clone(),
                            jsonrpc_id: jrpc_id,
                            kind: AcpPendingKind::Permission,
                        },
                    );
                }

                let asked = json!({
                    "jsonrpc":"2.0",
                    "method":"_sandboxagent/opencode/permission_asked",
                    "params":{"request": permission_request}
                });
                if let Err(err) = state.persist_event(&session_id, "agent", &asked).await {
                    warn!(?err, "failed to persist permission_asked event");
                }
                state
                    .emit_event(json!({"type":"permission.asked","properties":permission_request}));
            }

            // --- Question request from agent ---
            Some("_sandboxagent/session/request_question") => {
                let request_id = state.next_id("q_");
                let params = payload.get("params").cloned().unwrap_or(json!({}));
                let question_request = json!({
                    "id": request_id,
                    "sessionID": session_id,
                    "questions": params.get("questions").cloned().unwrap_or(json!([])),
                });

                if let Some(jrpc_id) = jsonrpc_id {
                    state.acp_request_ids.lock().await.insert(
                        request_id.clone(),
                        AcpPendingRequest {
                            opencode_session_id: session_id.clone(),
                            jsonrpc_id: jrpc_id,
                            kind: AcpPendingKind::Question,
                        },
                    );
                }

                let asked = json!({
                    "jsonrpc":"2.0",
                    "method":"_sandboxagent/opencode/question_asked",
                    "params":{"request": question_request}
                });
                if let Err(err) = state.persist_event(&session_id, "agent", &asked).await {
                    warn!(?err, "failed to persist question_asked event");
                }
                state.emit_event(json!({"type":"question.asked","properties":question_request}));
            }

            // --- Session ended notification ---
            Some("_sandboxagent/session/ended") => {
                let params = payload.get("params").cloned().unwrap_or(json!({}));
                let reason = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let error_message = params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(reason);

                state.emit_event(json!({
                    "type":"session.error",
                    "properties":{
                        "sessionID": session_id,
                        "error": {"name":"AgentError","data":{"message": error_message}}
                    }
                }));
                let _ = set_session_status(&state, &session_id, "idle").await;
                break;
            }

            // --- Not a notification: might be a response to session/prompt ---
            // Responses to initialize/session/new are also broadcast (they
            // arrive in order before prompt responses).  Only treat it as a
            // turn completion when we've already received content events
            // (assistant_message_id is set by session/update handling).
            None if (has_result || has_error) && assistant_message_id.is_some() => {
                // The session/prompt response signals turn completion.
                if has_error {
                    let error_msg = payload
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("agent error");
                    state.emit_event(json!({
                        "type":"session.error",
                        "properties":{
                            "sessionID": session_id,
                            "error": {"name":"AgentError","data":{"message": error_msg}}
                        }
                    }));
                }

                // Persist any remaining accumulated text part.
                if let Some(tid) = text_part_id.take() {
                    let msg_id = assistant_message_id.as_deref().unwrap_or("");
                    let part = json!({
                        "id": tid,
                        "sessionID": session_id,
                        "messageID": msg_id,
                        "type": "text",
                        "text": text_accum,
                    });
                    let env = json!({
                        "jsonrpc":"2.0",
                        "method":"_sandboxagent/opencode/message",
                        "params":{"message":{"info":{"id": msg_id},"parts":[part]}}
                    });
                    if let Err(err) = state.persist_event(&session_id, "agent", &env).await {
                        warn!(?err, "failed to persist ACP text part at turn end");
                    }
                    text_accum.clear();
                }

                // Finalize the assistant message.
                if let Some(msg_id) = assistant_message_id.as_ref() {
                    let parent_id = state
                        .last_user_message_id
                        .lock()
                        .await
                        .get(&*session_id)
                        .cloned()
                        .unwrap_or_default();
                    let now = now_ms();
                    let info = build_completed_assistant_message(
                        &session_id,
                        msg_id,
                        &parent_id,
                        now,
                        &directory,
                        &agent,
                        &provider_id,
                        &model_id,
                    );
                    state.emit_event(message_event("message.updated", &info));
                }

                let _ = set_session_status(&state, &session_id, "idle").await;

                // Reset for next turn (if the SSE stream stays open).
                assistant_message_id = None;
                part_counter = 0;
            }

            _ => {
                tracing::info!(
                    session_id = %session_id,
                    method = ?method,
                    "ACP SSE: unhandled event"
                );
            }
        }
    }
}

/// Translate an ACP `session/update` notification into OpenCode SSE events.
///
/// ACP `session/update` params use a discriminator field `sessionUpdate` to
/// indicate the kind of update.  The content structure depends on the kind:
///   - `agent_message_chunk` / `agent_thought_chunk`:  `{ content: ContentBlock }`
///   - `tool_call`:  ToolCall fields at top level (`toolCallId`, `title`, …)
///   - `tool_call_update`:  ToolCallUpdate fields at top level
async fn translate_session_update(
    state: &Arc<AdapterState>,
    session_id: &str,
    message_id: &str,
    part_counter: &mut u64,
    text_accum: &mut String,
    text_part_id: &mut Option<String>,
    directory: &str,
    agent: &str,
    provider_id: &str,
    model_id: &str,
    params: &Value,
) {
    // ACP session/update params: { sessionId, update: { sessionUpdate, content, ... } }
    let update = params.get("update").unwrap_or(params);
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");

    // Emit AND persist the assistant message info on the first content update.
    if *part_counter == 0
        && matches!(
            kind,
            "agent_message_chunk" | "agent_thought_chunk" | "tool_call"
        )
    {
        let parent_id = state
            .last_user_message_id
            .lock()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let now = now_ms();
        let info = build_assistant_message(
            session_id,
            message_id,
            &parent_id,
            now,
            directory,
            agent,
            provider_id,
            model_id,
        );
        state.emit_event(message_event("message.updated", &info));
        // Persist so the projection has the correct info (role, parentID, etc.)
        // for this assistant message when the session is replayed.
        let env = json!({
            "jsonrpc":"2.0",
            "method":"_sandboxagent/opencode/message",
            "params":{"message":{"info": info, "parts":[]}}
        });
        if let Err(err) = state.persist_event(session_id, "agent", &env).await {
            warn!(?err, "failed to persist assistant message info");
        }
    }

    match kind {
        // ── Text / thought chunk ───────────────────────────────────────
        "agent_message_chunk" | "agent_thought_chunk" => {
            // ContentChunk.content is a ContentBlock; for text it has { type: "text", text: "…" }
            let chunk = update
                .pointer("/content/text")
                .and_then(Value::as_str)
                .unwrap_or("");
            if chunk.is_empty() {
                return;
            }

            // Accumulate into a single part — reuse the same part ID so the
            // UI updates in-place instead of creating a new line per chunk.
            text_accum.push_str(chunk);
            let part_id = text_part_id.get_or_insert_with(|| {
                let id = format!("part_{message_id}_{part_counter}");
                *part_counter += 1;
                id
            });
            let part = json!({
                "id": *part_id,
                "sessionID": session_id,
                "messageID": message_id,
                "type": "text",
                "text": *text_accum,
            });
            state.emit_event(json!({
                "type":"message.part.updated",
                "properties":{
                    "sessionID": session_id,
                    "messageID": message_id,
                    "part": part,
                    "delta": chunk
                }
            }));
        }

        // ── Tool call initiation ───────────────────────────────────────
        "tool_call" => {
            // Finalize any accumulated text part before switching to tool.
            if let Some(tid) = text_part_id.take() {
                let part = json!({
                    "id": tid,
                    "sessionID": session_id,
                    "messageID": message_id,
                    "type": "text",
                    "text": *text_accum,
                });
                let env = json!({
                    "jsonrpc":"2.0",
                    "method":"_sandboxagent/opencode/message",
                    "params":{"message":{"info":{"id": message_id},"parts":[part]}}
                });
                if let Err(err) = state.persist_event(session_id, "agent", &env).await {
                    warn!(?err, "failed to persist ACP text part");
                }
                text_accum.clear();
            }
            let call_id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let tool_title = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let part_id = format!("part_{message_id}_{part_counter}");
            *part_counter += 1;
            let now = now_ms();
            let part = json!({
                "id": part_id,
                "sessionID": session_id,
                "messageID": message_id,
                "type": "tool",
                "callID": call_id,
                "tool": tool_title,
                "state": {
                    "status": "running",
                    "input": update.get("rawInput").cloned().unwrap_or(json!({})),
                    "title": tool_title,
                    "metadata": {},
                    "time": {"start": now}
                }
            });
            let env = json!({
                "jsonrpc":"2.0",
                "method":"_sandboxagent/opencode/message",
                "params":{"message":{"info":{"id": message_id},"parts":[part.clone()]}}
            });
            if let Err(err) = state.persist_event(session_id, "agent", &env).await {
                warn!(?err, "failed to persist ACP tool call event");
            }
            state.emit_event(json!({
                "type":"message.part.updated",
                "properties":{
                    "sessionID": session_id,
                    "messageID": message_id,
                    "part": part
                }
            }));
        }

        // ── Tool call status update ────────────────────────────────────
        "tool_call_update" => {
            let call_id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let status = update
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let output = update
                .get("content")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .filter_map(|c| c.get("text").and_then(Value::as_str))
                        .next()
                })
                .unwrap_or("");
            let now = now_ms();
            let part = json!({
                "id": format!("part_tc_{call_id}"),
                "sessionID": session_id,
                "messageID": message_id,
                "type": "tool",
                "callID": call_id,
                "state": {
                    "status": status,
                    "output": output,
                    "time": {"end": now}
                }
            });
            state.emit_event(json!({
                "type":"message.part.updated",
                "properties":{
                    "sessionID": session_id,
                    "messageID": message_id,
                    "part": part
                }
            }));
        }

        _ => {
            tracing::debug!(
                session_id = %session_id,
                kind = %kind,
                "translate_session_update: unhandled sessionUpdate kind"
            );
        }
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

async fn resolve_proxy_base_url(state: &Arc<AdapterState>, path: &str) -> Option<String> {
    if let Some(base_url) = state.config.native_proxy_base_url.as_ref() {
        return Some(base_url.clone());
    }

    let manager = state.config.native_proxy_manager.as_ref()?;
    match manager.ensure_server().await {
        Ok(base_url) => Some(base_url),
        Err(err) => {
            warn!(path, error = ?err, "failed to lazily start native OpenCode sidecar");
            None
        }
    }
}

async fn proxy_native_opencode(
    state: &Arc<AdapterState>,
    method: reqwest::Method,
    path: &str,
    headers: &HeaderMap,
    body: Option<Value>,
) -> Option<Response> {
    let base_url = resolve_proxy_base_url(state, path).await?;

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
            warn!(path, error = ?err, "failed proxy request to native OpenCode; falling back to adapter response");
            // Return None so the caller can use its own fallback response
            // instead of showing a BAD_GATEWAY error to the client.
            return None;
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
            warn!(path, error = ?err, "failed to read proxied response body");
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

async fn proxy_native_opencode_json(
    state: &Arc<AdapterState>,
    method: reqwest::Method,
    path: &str,
    headers: &HeaderMap,
    body: Option<Value>,
) -> Option<Result<(StatusCode, Value), Response>> {
    let base_url = resolve_proxy_base_url(state, path).await?;

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
            warn!(path, error = ?err, "failed proxy request to native OpenCode");
            return Some(Err((
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "data": {},
                    "errors": [{"message": format!("failed to proxy to native OpenCode: {err}")}],
                    "success": false,
                })),
            )
                .into_response()));
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
            warn!(path, error = ?err, "failed to read proxied response body");
            return Some(Err((
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "data": {},
                    "errors": [{"message": format!("failed to read proxied response: {err}")}],
                    "success": false,
                })),
            )
                .into_response()));
        }
    };

    if !status.is_success() {
        let mut proxied = Response::new(Body::from(body_bytes));
        *proxied.status_mut() = status;
        if let Some(content_type) = content_type {
            if let Ok(header_value) = HeaderValue::from_str(&content_type) {
                proxied
                    .headers_mut()
                    .insert(header::CONTENT_TYPE, header_value);
            }
        }
        return Some(Err(proxied));
    }

    if body_bytes.is_empty() {
        warn!(
            path,
            "native OpenCode prompt proxy returned an empty success body; falling back to local compat"
        );
        return None;
    }

    let payload = match serde_json::from_slice::<Value>(&body_bytes) {
        Ok(payload) => payload,
        Err(err) => {
            warn!(path, error = ?err, "failed to parse proxied JSON response");
            return Some(Err(
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "data": {},
                        "errors": [{"message": format!("failed to parse proxied response as JSON: {err}")}],
                        "success": false,
                    })),
                )
                    .into_response(),
            ));
        }
    };

    Some(Ok((status, payload)))
}

fn bool_ok(value: bool) -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!(value)))
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"errors":[{"message": message}]})),
    )
        .into_response()
}

fn not_found(message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"errors":[{"message": message}]})),
    )
        .into_response()
}

fn internal_error(message: String) -> Response {
    warn!(?message, "opencode adapter internal error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"errors":[{"message": message}]})),
    )
        .into_response()
}
