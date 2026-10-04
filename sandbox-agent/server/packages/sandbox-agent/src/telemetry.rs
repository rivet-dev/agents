use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::Serialize;
use time::OffsetDateTime;
use tokio::time::Instant;

static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(false);

const TELEMETRY_URL: &str = "https://tc.rivet.dev";
const TELEMETRY_ENV_DEBUG: &str = "SANDBOX_AGENT_TELEMETRY_DEBUG";
const TELEMETRY_ID_FILE: &str = "telemetry_id";
const TELEMETRY_LAST_SENT_FILE: &str = "telemetry_last_sent";
const TELEMETRY_TIMEOUT_MS: u64 = 2_000;
const TELEMETRY_INTERVAL_SECS: u64 = 300;
const TELEMETRY_MIN_GAP_SECS: i64 = 300;

#[derive(Debug, Serialize)]
struct TelemetryEvent<D: Serialize> {
    // p = project identifier
    p: String,
    // dt = unix timestamp (seconds)
    dt: i64,
    // et = entity type
    et: String,
    // eid = unique entity id
    eid: String,
    // ev = event name
    ev: String,
    // d = data payload
    d: D,
    // v = schema version
    v: u8,
}

#[derive(Debug, Serialize)]
struct BeaconData {
    version: String,
    os: OsInfo,
    provider: ProviderInfo,
}

#[derive(Debug, Serialize)]
struct OsInfo {
    name: String,
    arch: String,
    family: String,
}

#[derive(Debug, Serialize)]
struct ProviderInfo {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<HashMap<String, String>>,
}

pub fn telemetry_enabled(no_telemetry: bool) -> bool {
    let enabled = if no_telemetry {
        false
    } else if cfg!(debug_assertions) {
        env::var(TELEMETRY_ENV_DEBUG)
            .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE"))
            .unwrap_or(false)
    } else {
        true
    };
    TELEMETRY_ENABLED.store(enabled, Ordering::Relaxed);
    enabled
}

pub fn log_enabled_message() {
    tracing::info!("anonymous telemetry is enabled, disable with --no-telemetry");
}

pub fn spawn_telemetry_task() {
    tokio::spawn(async move {
        let client = match Client::builder()
            .timeout(Duration::from_millis(TELEMETRY_TIMEOUT_MS))
            .build()
        {
            Ok(client) => client,
            Err(err) => {
                tracing::debug!(error = %err, "failed to build telemetry client");
                return;
            }
        };

        attempt_send(&client).await;
        let start = Instant::now() + Duration::from_secs(TELEMETRY_INTERVAL_SECS);
        let mut interval =
            tokio::time::interval_at(start, Duration::from_secs(TELEMETRY_INTERVAL_SECS));
        loop {
            interval.tick().await;
            attempt_send(&client).await;
        }
    });
}

async fn attempt_send(client: &Client) {
    let dt = OffsetDateTime::now_utc().unix_timestamp();
    if !should_send(dt) {
        return;
    }

    let event = build_beacon_event(dt);
    if let Err(err) = client.post(TELEMETRY_URL).json(&event).send().await {
        tracing::debug!(error = %err, "telemetry request failed");
        return;
    }
    write_last_sent(dt);
}

fn build_beacon_event(dt: i64) -> TelemetryEvent<BeaconData> {
    new_event(
        dt,
        "sandbox",
        "entity_beacon",
        BeaconData {
            version: env!("CARGO_PKG_VERSION").to_string(),
            os: OsInfo {
                name: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                family: std::env::consts::FAMILY.to_string(),
            },
            provider: detect_provider(),
        },
    )
}

fn new_event<D: Serialize>(
    dt: i64,
    entity_type: &str,
    event_name: &str,
    data: D,
) -> TelemetryEvent<D> {
    let eid = load_or_create_id();
    TelemetryEvent {
        p: "sandbox-agent".to_string(),
        dt,
        et: entity_type.to_string(),
        eid,
        ev: event_name.to_string(),
        d: data,
        v: 1,
    }
}

fn load_or_create_id() -> String {
    let path = telemetry_id_path();
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let id = generate_id();
    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            tracing::debug!(error = %err, "failed to create telemetry directory");
            return id;
        }
    }

    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        let _ = file.write_all(id.as_bytes());
    }
    id
}

fn telemetry_id_path() -> PathBuf {
    telemetry_dir().join(TELEMETRY_ID_FILE)
}

fn telemetry_last_sent_path() -> PathBuf {
    telemetry_dir().join(TELEMETRY_LAST_SENT_FILE)
}

fn telemetry_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent"))
        .unwrap_or_else(|| PathBuf::from(".sandbox-agent"))
}

fn should_send(now: i64) -> bool {
    if let Some(last) = read_last_sent() {
        if now >= last && now - last < TELEMETRY_MIN_GAP_SECS {
            return false;
        }
    }
    true
}

fn read_last_sent() -> Option<i64> {
    let path = telemetry_last_sent_path();
    fs::read_to_string(&path)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
}

fn write_last_sent(timestamp: i64) {
    let path = telemetry_last_sent_path();
    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            tracing::debug!(error = %err, "failed to create telemetry directory");
            return;
        }
    }
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        let _ = file.write_all(timestamp.to_string().as_bytes());
    }
}

fn generate_id() -> String {
    let mut bytes = [0u8; 16];
    if read_random_bytes(&mut bytes) {
        return hex_encode(&bytes);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id() as u128;
    let mixed = now ^ (pid << 64);
    bytes = mixed.to_le_bytes();
    hex_encode(&bytes)
}

fn read_random_bytes(buf: &mut [u8]) -> bool {
    let path = Path::new("/dev/urandom");
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    file.read_exact(buf).is_ok()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn detect_provider() -> ProviderInfo {
    if env::var("E2B_SANDBOX").as_deref() == Ok("true") {
        let metadata = metadata_or_none([
            ("sandboxId", env::var("E2B_SANDBOX_ID").ok()),
            ("teamId", env::var("E2B_TEAM_ID").ok()),
            ("templateId", env::var("E2B_TEMPLATE_ID").ok()),
        ]);
        return ProviderInfo {
            name: "e2b".to_string(),
            method: Some("env".to_string()),
            metadata,
        };
    }

    if env::var("VERCEL").as_deref() == Ok("1") {
        let runtime = if env::var("VERCEL_SANDBOX").is_ok() {
            "sandbox"
        } else if env::var("LAMBDA_TASK_ROOT").is_ok() {
            "serverless"
        } else {
            "static"
        };
        let metadata = metadata_or_none([
            ("env", env::var("VERCEL_ENV").ok()),
            ("region", env::var("VERCEL_REGION").ok()),
            ("runtime", Some(runtime.to_string())),
        ]);
        return ProviderInfo {
            name: "vercel".to_string(),
            method: Some("env".to_string()),
            metadata,
        };
    }

    if env::var("MODAL_IS_REMOTE").as_deref() == Ok("1") || env::var("MODAL_CLOUD_PROVIDER").is_ok()
    {
        let metadata = metadata_or_none([
            ("cloudProvider", env::var("MODAL_CLOUD_PROVIDER").ok()),
            ("region", env::var("MODAL_REGION").ok()),
        ]);
        return ProviderInfo {
            name: "modal".to_string(),
            method: Some("env".to_string()),
            metadata,
        };
    }

    if env::var("FLY_APP_NAME").is_ok() || env::var("FLY_MACHINE_ID").is_ok() {
        let metadata = metadata_or_none([
            ("appName", env::var("FLY_APP_NAME").ok()),
            ("region", env::var("FLY_REGION").ok()),
        ]);
        return ProviderInfo {
            name: "fly.io".to_string(),
            method: Some("env".to_string()),
            metadata,
        };
    }

    if env::var("REPL_ID").is_ok() || env::var("REPL_SLUG").is_ok() {
        let metadata = metadata_or_none([
            ("replId", env::var("REPL_ID").ok()),
            ("owner", env::var("REPL_OWNER").ok()),
        ]);
        return ProviderInfo {
            name: "replit".to_string(),
            method: Some("env".to_string()),
            metadata,
        };
    }

    if env::var("CODESANDBOX_HOST").is_ok() || env::var("CSB_BASE_PREVIEW_HOST").is_ok() {
        return ProviderInfo {
            name: "codesandbox".to_string(),
            method: Some("env".to_string()),
            metadata: None,
        };
    }

    if env::var("CODESPACES").as_deref() == Ok("true") {
        let metadata = metadata_or_none([("name", env::var("CODESPACE_NAME").ok())]);
        return ProviderInfo {
            name: "github-codespaces".to_string(),
            method: Some("env".to_string()),
            metadata,
        };
    }

    if env::var("RAILWAY_ENVIRONMENT").is_ok() {
        let metadata = metadata_or_none([("environment", env::var("RAILWAY_ENVIRONMENT").ok())]);
        return ProviderInfo {
            name: "railway".to_string(),
            method: Some("env".to_string()),
            metadata,
        };
    }

    if env::var("RENDER").as_deref() == Ok("true") {
        let metadata = metadata_or_none([("serviceId", env::var("RENDER_SERVICE_ID").ok())]);
        return ProviderInfo {
            name: "render".to_string(),
            method: Some("env".to_string()),
            metadata,
        };
    }

    if detect_daytona() {
        return ProviderInfo {
            name: "daytona".to_string(),
            method: Some("filesystem".to_string()),
            metadata: None,
        };
    }

    if detect_docker() {
        return ProviderInfo {
            name: "docker".to_string(),
            method: Some("filesystem".to_string()),
            metadata: None,
        };
    }

    ProviderInfo {
        name: "unknown".to_string(),
        method: None,
        metadata: None,
    }
}

fn detect_daytona() -> bool {
    let mut signals = 0;
    let username = env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_default();
    if username == "daytona" {
        signals += 1;
    }
    if Path::new("/home/daytona").exists() {
        signals += 1;
    }
    if let Some(home) = dirs::home_dir() {
        if home.join(".daytona").exists() {
            signals += 1;
        }
    }
    signals >= 2
}

fn detect_docker() -> bool {
    if Path::new("/.dockerenv").exists() {
        return true;
    }
    if Path::new("/run/.containerenv").exists() {
        return true;
    }
    if let Ok(cgroup) = fs::read_to_string("/proc/1/cgroup") {
        let lower = cgroup.to_lowercase();
        if lower.contains("docker") || lower.contains("containerd") {
            return true;
        }
    }
    false
}

fn filter_metadata(
    pairs: impl IntoIterator<Item = (&'static str, Option<String>)>,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (key, value) in pairs {
        if let Some(value) = value {
            if !value.is_empty() {
                map.insert(key.to_string(), value);
            }
        }
    }
    map
}

fn metadata_or_none(
    pairs: impl IntoIterator<Item = (&'static str, Option<String>)>,
) -> Option<HashMap<String, String>> {
    let map = filter_metadata(pairs);
    if map.is_empty() {
        None
    } else {
        Some(map)
    }
}

#[derive(Debug, Serialize)]
struct SessionCreatedData {
    version: String,
    agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
}

pub struct SessionConfig {
    pub agent: String,
    pub agent_mode: Option<String>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub variant: Option<String>,
}

pub fn log_session_created(config: SessionConfig) {
    if !TELEMETRY_ENABLED.load(Ordering::Relaxed) {
        return;
    }

    let event = new_event(
        OffsetDateTime::now_utc().unix_timestamp(),
        "session",
        "session_created",
        SessionCreatedData {
            version: env!("CARGO_PKG_VERSION").to_string(),
            agent: config.agent,
            agent_mode: config.agent_mode,
            permission_mode: config.permission_mode,
            model: config.model,
            variant: config.variant,
        },
    );

    spawn_send(event);
}

fn spawn_send<D: Serialize + Send + 'static>(event: TelemetryEvent<D>) {
    tokio::spawn(async move {
        let client = match Client::builder()
            .timeout(Duration::from_millis(TELEMETRY_TIMEOUT_MS))
            .build()
        {
            Ok(client) => client,
            Err(err) => {
                tracing::debug!(error = %err, "failed to build telemetry client");
                return;
            }
        };

        if let Err(err) = client.post(TELEMETRY_URL).json(&event).send().await {
            tracing::debug!(error = %err, "telemetry send failed");
        }
    });
}
