use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::{Args, Parser, Subcommand};

mod build_version {
    include!(concat!(env!("OUT_DIR"), "/version.rs"));
}

use crate::desktop_install::{install_desktop, DesktopInstallRequest, DesktopPackageManager};
use crate::router::{
    build_router_with_state, shutdown_servers, AppState, AuthConfig, BrandingMode,
};
use crate::server_logs::ServerLogs;
use crate::telemetry;
use crate::ui;
use reqwest::blocking::Client as HttpClient;
use reqwest::Method;
use sandbox_agent_agent_credentials::{
    extract_all_credentials, AuthType, CredentialExtractionOptions, ExtractedCredentials,
    ProviderCredentials,
};
use sandbox_agent_agent_management::agents::{AgentId, AgentManager, InstallOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const API_PREFIX: &str = "/v1";
const ACP_EXTENSION_AGENT_LIST_METHOD: &str = "_sandboxagent/agent/list";
const ACP_EXTENSION_AGENT_INSTALL_METHOD: &str = "_sandboxagent/agent/install";
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 2468;
const LOGS_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Parser, Debug)]
#[command(name = "sandbox-agent", bin_name = "sandbox-agent")]
#[command(about = "https://sandboxagent.dev", version = build_version::VERSION)]
#[command(arg_required_else_help = true)]
pub struct SandboxAgentCli {
    #[command(subcommand)]
    command: Command,

    #[arg(long, short = 't', global = true)]
    token: Option<String>,

    #[arg(long, short = 'n', global = true)]
    no_token: bool,
}

#[derive(Parser, Debug)]
#[command(name = "gigacode", bin_name = "gigacode")]
#[command(about = "https://sandboxagent.dev", version = build_version::VERSION)]
pub struct GigacodeCli {
    #[command(subcommand)]
    pub command: Option<Command>,

    #[arg(long, short = 't', global = true)]
    pub token: Option<String>,

    #[arg(long, short = 'n', global = true)]
    pub no_token: bool,

    #[arg(long, global = true)]
    pub yolo: bool,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run the sandbox agent HTTP server.
    Server(ServerArgs),
    /// Call the HTTP API without writing client code.
    Api(ApiArgs),
    /// Install first-party runtime dependencies.
    Install(InstallArgs),
    /// EXPERIMENTAL: OpenCode compatibility layer (disabled until ACP Phase 7).
    Opencode(OpencodeArgs),
    /// Manage the sandbox-agent background daemon.
    Daemon(DaemonArgs),
    /// Install or reinstall one agent, or `all` supported agents, without running the server.
    InstallAgent(InstallAgentArgs),
    /// Inspect locally discovered credentials.
    Credentials(CredentialsArgs),
    /// Internal: stdio JSON-RPC echo agent for the mock agent process.
    #[command(hide = true)]
    MockAgentProcess,
}

#[derive(Args, Debug)]
pub struct ServerArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,

    #[arg(long = "cors-allow-origin", short = 'O')]
    cors_allow_origin: Vec<String>,

    #[arg(long = "cors-allow-method", short = 'M')]
    cors_allow_method: Vec<String>,

    #[arg(long = "cors-allow-header", short = 'A')]
    cors_allow_header: Vec<String>,

    #[arg(long = "cors-allow-credentials", short = 'C')]
    cors_allow_credentials: bool,

    #[arg(long = "no-telemetry")]
    no_telemetry: bool,
}

#[derive(Args, Debug)]
pub struct ApiArgs {
    #[command(subcommand)]
    command: ApiCommand,
}

#[derive(Args, Debug)]
pub struct InstallArgs {
    #[command(subcommand)]
    command: InstallCommand,
}

#[derive(Args, Debug)]
pub struct OpencodeArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,

    #[arg(long)]
    session_title: Option<String>,

    #[arg(long)]
    pub yolo: bool,
}

impl Default for OpencodeArgs {
    fn default() -> Self {
        Self {
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
            session_title: None,
            yolo: false,
        }
    }
}

#[derive(Args, Debug)]
pub struct CredentialsArgs {
    #[command(subcommand)]
    command: CredentialsCommand,
}

#[derive(Args, Debug)]
pub struct DaemonArgs {
    #[command(subcommand)]
    command: DaemonCommand,
}

#[derive(Subcommand, Debug)]
pub enum InstallCommand {
    /// Install desktop runtime dependencies.
    Desktop(InstallDesktopArgs),
}

#[derive(Subcommand, Debug)]
pub enum DaemonCommand {
    /// Start the daemon in the background.
    Start(DaemonStartArgs),
    /// Stop a running daemon.
    Stop(DaemonStopArgs),
    /// Show daemon status.
    Status(DaemonStatusArgs),
}

#[derive(Args, Debug)]
pub struct DaemonStartArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,

    #[arg(long, default_value_t = false)]
    upgrade: bool,
}

#[derive(Args, Debug)]
pub struct DaemonStopArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,
}

#[derive(Args, Debug)]
pub struct DaemonStatusArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,
}

#[derive(Subcommand, Debug)]
pub enum ApiCommand {
    /// Manage available v1 agents and install status.
    Agents(AgentsArgs),
    /// Send and stream raw ACP JSON-RPC envelopes.
    Acp(AcpArgs),
}

#[derive(Subcommand, Debug)]
pub enum CredentialsCommand {
    /// Extract credentials using local discovery rules.
    Extract(CredentialsExtractArgs),
    /// Output credentials as environment variable assignments.
    #[command(name = "extract-env")]
    ExtractEnv(CredentialsExtractEnvArgs),
}

#[derive(Args, Debug)]
pub struct AgentsArgs {
    #[command(subcommand)]
    command: AgentsCommand,
}

#[derive(Subcommand, Debug)]
pub enum AgentsCommand {
    /// List all agents and install status.
    List(ClientArgs),
    /// Emit JSON report of model/mode/thought options for all agents.
    Report(ClientArgs),
    /// Install or reinstall an agent.
    Install(ApiInstallAgentArgs),
}

#[derive(Args, Debug)]
pub struct AcpArgs {
    #[command(subcommand)]
    command: AcpCommand,
}

#[derive(Subcommand, Debug)]
pub enum AcpCommand {
    /// Send one ACP JSON-RPC envelope to /v1/acp/{server_id}.
    Post(AcpPostArgs),
    /// Stream ACP JSON-RPC envelopes from /v1/acp/{server_id} SSE.
    Stream(AcpStreamArgs),
    /// Close an ACP server stream.
    Close(AcpCloseArgs),
}

#[derive(Args, Debug, Clone)]
pub struct ClientArgs {
    #[arg(long, short = 'e')]
    endpoint: Option<String>,
}

#[derive(Args, Debug)]
pub struct ApiInstallAgentArgs {
    agent: String,
    #[arg(long, short = 'r')]
    reinstall: bool,
    #[arg(long = "agent-version")]
    agent_version: Option<String>,
    #[arg(long = "agent-process-version")]
    agent_process_version: Option<String>,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct AcpPostArgs {
    #[arg(long = "server-id")]
    server_id: String,
    #[arg(long = "agent")]
    agent: Option<String>,
    #[arg(long)]
    json: Option<String>,
    #[arg(long = "json-file")]
    json_file: Option<PathBuf>,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct AcpStreamArgs {
    #[arg(long = "server-id")]
    server_id: String,
    #[arg(long = "last-event-id")]
    last_event_id: Option<u64>,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct AcpCloseArgs {
    #[arg(long = "server-id")]
    server_id: String,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct InstallAgentArgs {
    #[arg(required_unless_present = "all", conflicts_with = "all")]
    agent: Option<String>,
    #[arg(long, conflicts_with = "agent")]
    all: bool,
    #[arg(long, short = 'r')]
    reinstall: bool,
    #[arg(long = "agent-version")]
    agent_version: Option<String>,
    #[arg(long = "agent-process-version")]
    agent_process_version: Option<String>,
}

#[derive(Args, Debug)]
pub struct InstallDesktopArgs {
    #[arg(long, default_value_t = false)]
    yes: bool,
    #[arg(long, default_value_t = false)]
    print_only: bool,
    #[arg(long, value_enum)]
    package_manager: Option<DesktopPackageManager>,
    #[arg(long, default_value_t = false)]
    no_fonts: bool,
}

#[derive(Args, Debug)]
pub struct CredentialsExtractArgs {
    #[arg(long, short = 'a', value_enum)]
    agent: Option<CredentialAgent>,
    #[arg(long, short = 'p')]
    provider: Option<String>,
    #[arg(long, short = 'd')]
    home_dir: Option<PathBuf>,
    #[arg(long)]
    no_oauth: bool,
    #[arg(long, short = 'r')]
    reveal: bool,
}

#[derive(Args, Debug)]
pub struct CredentialsExtractEnvArgs {
    #[arg(long, short = 'e')]
    export: bool,
    #[arg(long, short = 'd')]
    home_dir: Option<PathBuf>,
    #[arg(long)]
    no_oauth: bool,
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error("missing --token or --no-token for server mode")]
    MissingToken,
    #[error("invalid cors origin: {0}")]
    InvalidCorsOrigin(String),
    #[error("invalid cors method: {0}")]
    InvalidCorsMethod(String),
    #[error("invalid cors header: {0}")]
    InvalidCorsHeader(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("server error: {0}")]
    Server(String),
    #[error("unexpected http status: {0}")]
    HttpStatus(reqwest::StatusCode),
}

pub struct CliConfig {
    pub token: Option<String>,
    pub no_token: bool,
    pub gigacode: bool,
}

pub fn run_sandbox_agent() -> Result<(), CliError> {
    let cli = SandboxAgentCli::parse();
    let SandboxAgentCli {
        command,
        token,
        no_token,
    } = cli;

    let config = CliConfig {
        token,
        no_token,
        gigacode: false,
    };

    if let Err(err) = init_logging(&command) {
        eprintln!("failed to init logging: {err}");
        return Err(err);
    }

    run_command(&command, &config)
}

pub fn init_logging(command: &Command) -> Result<(), CliError> {
    if matches!(command, Command::Server(_)) {
        maybe_redirect_server_logs();
    }

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_logfmt::builder()
                .layer()
                .with_writer(std::io::stderr),
        )
        .init();
    Ok(())
}

pub fn run_command(command: &Command, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        Command::Server(args) => run_server(cli, args),
        Command::Api(subcommand) => run_api(&subcommand.command, cli),
        Command::Install(subcommand) => run_install(&subcommand.command),
        Command::Opencode(args) => run_opencode(cli, args),
        Command::Daemon(subcommand) => run_daemon(&subcommand.command, cli),
        Command::InstallAgent(args) => install_agent_local(args),
        Command::Credentials(subcommand) => run_credentials(&subcommand.command),
        Command::MockAgentProcess => run_mock_agent_process(),
    }
}

fn run_install(command: &InstallCommand) -> Result<(), CliError> {
    match command {
        InstallCommand::Desktop(args) => install_desktop_local(args),
    }
}

fn run_server(cli: &CliConfig, server: &ServerArgs) -> Result<(), CliError> {
    let auth = if let Some(token) = cli.token.clone() {
        AuthConfig::with_token(token)
    } else {
        AuthConfig::disabled()
    };

    let branding = if cli.gigacode {
        BrandingMode::Gigacode
    } else {
        BrandingMode::SandboxAgent
    };

    let agent_manager = AgentManager::new(default_install_dir())
        .map_err(|err| CliError::Server(err.to_string()))?;
    let state = Arc::new(AppState::with_branding(auth, agent_manager, branding));
    let (mut router, state) = build_router_with_state(state);

    let cors = build_cors_layer(server)?;
    router = router.layer(cors);

    let addr = format!("{}:{}", server.host, server.port);
    let display_host = match server.host.as_str() {
        "0.0.0.0" | "::" => "localhost",
        other => other,
    };
    let inspector_url = format!("http://{}:{}/ui", display_host, server.port);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| CliError::Server(err.to_string()))?;

    let telemetry_enabled = telemetry::telemetry_enabled(server.no_telemetry);

    runtime.block_on(async move {
        if telemetry_enabled {
            telemetry::log_enabled_message();
            telemetry::spawn_telemetry_task();
        }

        let listener = tokio::net::TcpListener::bind(&addr).await?;
        tracing::info!(addr = %addr, "server listening");
        if ui::is_enabled() {
            tracing::info!(url = %inspector_url, "inspector ui available");
        }

        let shutdown_state = state.clone();
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = tokio::signal::ctrl_c().await;
                shutdown_servers(&shutdown_state).await;
            })
            .await
            .map_err(|err| CliError::Server(err.to_string()))
    })
}

fn run_api(command: &ApiCommand, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        ApiCommand::Agents(subcommand) => run_agents(&subcommand.command, cli),
        ApiCommand::Acp(subcommand) => run_acp(&subcommand.command, cli),
    }
}

fn install_desktop_local(args: &InstallDesktopArgs) -> Result<(), CliError> {
    install_desktop(DesktopInstallRequest {
        yes: args.yes,
        print_only: args.print_only,
        package_manager: args.package_manager,
        no_fonts: args.no_fonts,
    })
    .map(|_| ())
    .map_err(CliError::Server)
}

fn run_agents(command: &AgentsCommand, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        AgentsCommand::List(args) => {
            let ctx = ClientContext::new(cli, args)?;
            let result = call_acp_extension(&ctx, ACP_EXTENSION_AGENT_LIST_METHOD, json!({}))?;
            write_stdout_line(&serde_json::to_string_pretty(&result)?)
        }
        AgentsCommand::Report(args) => run_agents_report(args, cli),
        AgentsCommand::Install(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let mut params = serde_json::Map::new();
            params.insert("agent".to_string(), Value::String(args.agent.clone()));
            if args.reinstall {
                params.insert("reinstall".to_string(), Value::Bool(true));
            }
            if let Some(version) = args.agent_version.clone() {
                params.insert("agentVersion".to_string(), Value::String(version));
            }
            if let Some(version) = args.agent_process_version.clone() {
                params.insert("agentProcessVersion".to_string(), Value::String(version));
            }
            let result = call_acp_extension(
                &ctx,
                ACP_EXTENSION_AGENT_INSTALL_METHOD,
                Value::Object(params),
            )?;
            write_stdout_line(&serde_json::to_string_pretty(&result)?)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentListApiResponse {
    agents: Vec<AgentListApiAgent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentListApiAgent {
    id: String,
    installed: bool,
    #[serde(default)]
    config_error: Option<String>,
    #[serde(default)]
    config_options: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawConfigOption {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    current_value: Option<Value>,
    #[serde(default)]
    options: Vec<RawConfigOptionChoice>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawConfigOptionChoice {
    #[serde(default)]
    value: Value,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfigReport {
    generated_at_ms: u128,
    endpoint: String,
    agents: Vec<AgentConfigReportEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfigReportEntry {
    id: String,
    installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    config_error: Option<String>,
    models: AgentConfigCategoryReport,
    modes: AgentConfigCategoryReport,
    thought_levels: AgentConfigCategoryReport,
}

#[derive(Debug, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AgentConfigCategoryReport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current_value: Option<String>,
    values: Vec<AgentConfigValueReport>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AgentConfigValueReport {
    value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Clone, Copy)]
enum ConfigReportCategory {
    Model,
    Mode,
    ThoughtLevel,
}

#[derive(Default)]
struct CategoryAccumulator {
    current_value: Option<String>,
    values: BTreeMap<String, Option<String>>,
}

impl CategoryAccumulator {
    fn absorb(&mut self, option: &RawConfigOption) {
        if self.current_value.is_none() {
            self.current_value = config_value_to_string(option.current_value.as_ref());
        }

        for candidate in &option.options {
            let Some(value) = config_value_to_string(Some(&candidate.value)) else {
                continue;
            };
            let name = candidate
                .name
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let entry = self.values.entry(value).or_insert(None);
            if entry.is_none() && name.is_some() {
                *entry = name;
            }
        }
    }

    fn into_report(mut self) -> AgentConfigCategoryReport {
        if let Some(current) = self.current_value.clone() {
            self.values.entry(current).or_insert(None);
        }
        AgentConfigCategoryReport {
            current_value: self.current_value,
            values: self
                .values
                .into_iter()
                .map(|(value, name)| AgentConfigValueReport { value, name })
                .collect(),
        }
    }
}

fn run_agents_report(args: &ClientArgs, cli: &CliConfig) -> Result<(), CliError> {
    let ctx = ClientContext::new(cli, args)?;
    let response = ctx.get(&format!("{API_PREFIX}/agents?config=true"))?;
    let status = response.status();
    let text = response.text()?;

    if !status.is_success() {
        print_error_body(&text)?;
        return Err(CliError::HttpStatus(status));
    }

    let parsed: AgentListApiResponse = serde_json::from_str(&text)?;
    let report = build_agent_config_report(parsed, &ctx.endpoint);
    write_stdout_line(&serde_json::to_string_pretty(&report)?)
}

fn build_agent_config_report(input: AgentListApiResponse, endpoint: &str) -> AgentConfigReport {
    let generated_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    let agents = input
        .agents
        .into_iter()
        .map(|agent| {
            let mut model = CategoryAccumulator::default();
            let mut mode = CategoryAccumulator::default();
            let mut thought_level = CategoryAccumulator::default();

            for option_value in agent.config_options.unwrap_or_default() {
                let Ok(option) = serde_json::from_value::<RawConfigOption>(option_value) else {
                    continue;
                };
                let Some(category) = option
                    .category
                    .as_deref()
                    .or(option.id.as_deref())
                    .and_then(classify_report_category)
                else {
                    continue;
                };

                match category {
                    ConfigReportCategory::Model => model.absorb(&option),
                    ConfigReportCategory::Mode => mode.absorb(&option),
                    ConfigReportCategory::ThoughtLevel => thought_level.absorb(&option),
                }
            }

            AgentConfigReportEntry {
                id: agent.id,
                installed: agent.installed,
                config_error: agent.config_error,
                models: model.into_report(),
                modes: mode.into_report(),
                thought_levels: thought_level.into_report(),
            }
        })
        .collect();

    AgentConfigReport {
        generated_at_ms,
        endpoint: endpoint.to_string(),
        agents,
    }
}

fn classify_report_category(raw: &str) -> Option<ConfigReportCategory> {
    let normalized = raw
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");

    match normalized.as_str() {
        "model" | "model_id" => Some(ConfigReportCategory::Model),
        "mode" | "agent_mode" => Some(ConfigReportCategory::Mode),
        "thought" | "thoughtlevel" | "thought_level" | "thinking" | "thinking_level"
        | "reasoning" | "reasoning_effort" => Some(ConfigReportCategory::ThoughtLevel),
        _ => None,
    }
}

fn config_value_to_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }
}

fn call_acp_extension(ctx: &ClientContext, method: &str, params: Value) -> Result<Value, CliError> {
    let server_id = unique_cli_server_id("cli-ext");
    let initialize_path = build_acp_server_path(&server_id, Some("mock"))?;
    let request_path = build_acp_server_path(&server_id, None)?;

    let initialize = json!({
        "jsonrpc": "2.0",
        "id": "cli-init",
        "method": "initialize",
        "params": {
            "protocolVersion": "1.0",
            "clientCapabilities": {},
            "_meta": {
                "sandboxagent.dev": {
                    "agent": "mock"
                }
            }
        }
    });
    let initialize_response = ctx.post(&initialize_path, &initialize)?;
    let initialize_status = initialize_response.status();
    let initialize_text = initialize_response.text()?;
    if !initialize_status.is_success() {
        print_error_body(&initialize_text)?;
        return Err(CliError::HttpStatus(initialize_status));
    }

    let request = json!({
        "jsonrpc": "2.0",
        "id": "cli-ext",
        "method": method,
        "params": params,
    });
    let response = ctx.post(&request_path, &request);

    let _ = ctx.delete(&request_path);

    let response = response?;
    let status = response.status();
    let text = response.text()?;
    if !status.is_success() {
        print_error_body(&text)?;
        return Err(CliError::HttpStatus(status));
    }

    let parsed: Value = serde_json::from_str(&text)?;
    if parsed.get("error").is_some() {
        let pretty = serde_json::to_string_pretty(&parsed)?;
        write_stderr_line(&pretty)?;
        return Err(CliError::Server(format!(
            "ACP extension call failed: {method}"
        )));
    }

    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
}

fn run_acp(command: &AcpCommand, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        AcpCommand::Post(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let payload = load_json_payload(args.json.as_deref(), args.json_file.as_deref())?;
            let path = build_acp_server_path(&args.server_id, args.agent.as_deref())?;
            let response = ctx.post(&path, &payload)?;
            print_json_or_empty(response)
        }
        AcpCommand::Stream(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let path = build_acp_server_path(&args.server_id, None)?;
            let request = ctx
                .request(Method::GET, &path)
                .header("accept", "text/event-stream");

            let request = apply_last_event_id_header(request, args.last_event_id);

            let response = request.send()?;
            print_text_response(response)
        }
        AcpCommand::Close(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let path = build_acp_server_path(&args.server_id, None)?;
            let response = ctx.delete(&path)?;
            print_empty_response(response)
        }
    }
}

fn run_opencode(cli: &CliConfig, args: &OpencodeArgs) -> Result<(), CliError> {
    let token = cli.token.as_deref();
    crate::daemon::ensure_running(cli, &args.host, args.port, token)?;
    let base_url = format!("http://{}:{}", args.host, args.port);

    let attach_url = format!("{base_url}/opencode");
    let mut attach_command = if let Ok(bin) = std::env::var("GIGACODE_OPENCODE_BIN") {
        let mut cmd = ProcessCommand::new(bin);
        cmd.arg("attach").arg(&attach_url);
        cmd
    } else {
        let mut cmd = ProcessCommand::new("opencode");
        cmd.arg("attach").arg(&attach_url);
        cmd
    };

    let status = match attach_command.status() {
        Ok(status) => status,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let mut fallback = ProcessCommand::new("npx");
            fallback
                .arg("--yes")
                .arg("opencode-ai")
                .arg("attach")
                .arg(&attach_url);
            fallback.status().map_err(|fallback_err| {
                CliError::Server(format!(
                    "failed to launch opencode attach. Tried `opencode attach` and `npx --yes opencode-ai attach`. Last error: {fallback_err}"
                ))
            })?
        }
        Err(err) => {
            return Err(CliError::Server(format!(
                "failed to launch opencode attach: {err}"
            )));
        }
    };

    if !status.success() {
        return Err(CliError::Server(format!(
            "opencode attach exited with status {status}"
        )));
    }

    Ok(())
}

fn run_daemon(command: &DaemonCommand, cli: &CliConfig) -> Result<(), CliError> {
    let token = cli.token.as_deref();
    match command {
        DaemonCommand::Start(args) if args.upgrade => {
            crate::daemon::ensure_running(cli, &args.host, args.port, token)
        }
        DaemonCommand::Start(args) => crate::daemon::start(cli, &args.host, args.port, token),
        DaemonCommand::Stop(args) => crate::daemon::stop(&args.host, args.port),
        DaemonCommand::Status(args) => {
            let status = crate::daemon::status(&args.host, args.port, token)?;
            write_stderr_line(&status.to_string())?;
            Ok(())
        }
    }
}

fn run_credentials(command: &CredentialsCommand) -> Result<(), CliError> {
    match command {
        CredentialsCommand::Extract(args) => {
            let mut options = CredentialExtractionOptions::new();
            if let Some(home_dir) = args.home_dir.clone() {
                options.home_dir = Some(home_dir);
            }
            if args.no_oauth {
                options.include_oauth = false;
            }

            let credentials = extract_all_credentials(&options);
            if let Some(agent) = args.agent.clone() {
                let token = select_token_for_agent(&credentials, agent, args.provider.as_deref())?;
                write_stdout_line(&token)?;
                return Ok(());
            }
            if let Some(provider) = args.provider.as_deref() {
                let token = select_token_for_provider(&credentials, provider)?;
                write_stdout_line(&token)?;
                return Ok(());
            }

            let output = credentials_to_output(credentials, args.reveal);
            let pretty = serde_json::to_string_pretty(&output)?;
            write_stdout_line(&pretty)?;
            Ok(())
        }
        CredentialsCommand::ExtractEnv(args) => {
            let mut options = CredentialExtractionOptions::new();
            if let Some(home_dir) = args.home_dir.clone() {
                options.home_dir = Some(home_dir);
            }
            if args.no_oauth {
                options.include_oauth = false;
            }

            let credentials = extract_all_credentials(&options);
            let prefix = if args.export { "export " } else { "" };

            if let Some(cred) = &credentials.anthropic {
                write_stdout_line(&format!("{}ANTHROPIC_API_KEY={}", prefix, cred.api_key))?;
                write_stdout_line(&format!("{}CLAUDE_API_KEY={}", prefix, cred.api_key))?;
            }
            if let Some(cred) = &credentials.openai {
                write_stdout_line(&format!("{}OPENAI_API_KEY={}", prefix, cred.api_key))?;
                write_stdout_line(&format!("{}CODEX_API_KEY={}", prefix, cred.api_key))?;
            }
            for (provider, cred) in &credentials.other {
                let var_name = format!("{}_API_KEY", provider.to_uppercase().replace('-', "_"));
                write_stdout_line(&format!("{}{}={}", prefix, var_name, cred.api_key))?;
            }

            Ok(())
        }
    }
}

fn run_mock_agent_process() -> Result<(), CliError> {
    use std::io::BufRead;

    let stdin = std::io::stdin();
    let reader = stdin.lock();

    for line in reader.lines() {
        let line = line.map_err(|e| CliError::Server(format!("stdin read error: {}", e)))?;
        if line.trim().is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let err_notification = json!({
                    "jsonrpc": "2.0",
                    "method": "mock/parse_error",
                    "params": {
                        "error": e.to_string(),
                        "raw": line,
                    }
                });
                write_stdout_line(&serde_json::to_string(&err_notification)?)?;
                continue;
            }
        };

        // Echo notification for every message
        let echo = json!({
            "jsonrpc": "2.0",
            "method": "mock/echo",
            "params": { "message": msg }
        });
        write_stdout_line(&serde_json::to_string(&echo)?)?;

        let has_method = msg.get("method").and_then(|v| v.as_str()).is_some();
        let has_id = msg.get("id").is_some();

        if has_method && has_id {
            // Request -> respond with echo result
            let response = json!({
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": { "echoed": msg }
            });
            write_stdout_line(&serde_json::to_string(&response)?)?;
        } else if !has_method && has_id {
            // Client response
            let notification = json!({
                "jsonrpc": "2.0",
                "method": "mock/client_response",
                "params": {
                    "id": msg["id"],
                    "result": msg.get("result").unwrap_or(&Value::Null),
                    "error": msg.get("error").unwrap_or(&Value::Null),
                }
            });
            write_stdout_line(&serde_json::to_string(&notification)?)?;
        }
    }

    Ok(())
}

fn load_json_payload(
    json_inline: Option<&str>,
    json_file: Option<&std::path::Path>,
) -> Result<Value, CliError> {
    match (json_inline, json_file) {
        (Some(_), Some(_)) => Err(CliError::Server(
            "provide either --json or --json-file, not both".to_string(),
        )),
        (None, None) => Err(CliError::Server(
            "missing payload: provide --json or --json-file".to_string(),
        )),
        (Some(inline), None) => Ok(serde_json::from_str(inline)?),
        (None, Some(path)) => {
            let text = std::fs::read_to_string(path)?;
            Ok(serde_json::from_str(&text)?)
        }
    }
}

fn install_agent_local(args: &InstallAgentArgs) -> Result<(), CliError> {
    if args.all && (args.agent_version.is_some() || args.agent_process_version.is_some()) {
        return Err(CliError::Server(
            "--agent-version and --agent-process-version are only supported for single-agent installs"
                .to_string(),
        ));
    }

    let agents = resolve_install_agents(args)?;

    let manager = AgentManager::new(default_install_dir())
        .map_err(|err| CliError::Server(err.to_string()))?;

    if agents.len() == 1 {
        let result = manager
            .install(
                agents[0],
                InstallOptions {
                    reinstall: args.reinstall,
                    version: args.agent_version.clone(),
                    agent_process_version: args.agent_process_version.clone(),
                },
            )
            .map_err(|err| CliError::Server(err.to_string()))?;
        let output = install_result_json(result);
        return write_stdout_line(&serde_json::to_string_pretty(&output)?);
    }

    let mut results = Vec::with_capacity(agents.len());
    for agent_id in agents {
        let result = manager
            .install(
                agent_id,
                InstallOptions {
                    reinstall: args.reinstall,
                    version: None,
                    agent_process_version: None,
                },
            )
            .map_err(|err| CliError::Server(err.to_string()))?;
        results.push(json!({
            "agent": agent_id.as_str(),
            "result": install_result_json(result),
        }));
    }

    write_stdout_line(&serde_json::to_string_pretty(
        &json!({ "agents": results }),
    )?)
}

fn resolve_install_agents(args: &InstallAgentArgs) -> Result<Vec<AgentId>, CliError> {
    if args.all {
        return Ok(AgentId::all().to_vec());
    }

    let agent = args
        .agent
        .as_deref()
        .ok_or_else(|| CliError::Server("missing agent: provide <AGENT> or --all".to_string()))?;

    AgentId::parse(agent)
        .map(|agent_id| vec![agent_id])
        .ok_or_else(|| CliError::Server(format!("unsupported agent: {agent}")))
}

fn install_result_json(result: sandbox_agent_agent_management::agents::InstallResult) -> Value {
    json!({
        "alreadyInstalled": result.already_installed,
        "artifacts": result.artifacts.into_iter().map(|artifact| json!({
            "kind": format!("{:?}", artifact.kind),
            "path": artifact.path,
            "source": format!("{:?}", artifact.source),
            "version": artifact.version,
        })).collect::<Vec<_>>()
    })
}

#[derive(Serialize)]
struct CredentialsOutput {
    anthropic: Option<CredentialSummary>,
    openai: Option<CredentialSummary>,
    other: HashMap<String, CredentialSummary>,
}

#[derive(Serialize)]
struct CredentialSummary {
    provider: String,
    source: String,
    auth_type: String,
    api_key: String,
    redacted: bool,
}

#[derive(clap::ValueEnum, Clone, Debug)]
enum CredentialAgent {
    Claude,
    Codex,
    Opencode,
    Amp,
}

fn credentials_to_output(credentials: ExtractedCredentials, reveal: bool) -> CredentialsOutput {
    CredentialsOutput {
        anthropic: credentials
            .anthropic
            .map(|cred| summarize_credential(&cred, reveal)),
        openai: credentials
            .openai
            .map(|cred| summarize_credential(&cred, reveal)),
        other: credentials
            .other
            .into_iter()
            .map(|(key, cred)| (key, summarize_credential(&cred, reveal)))
            .collect(),
    }
}

fn summarize_credential(credential: &ProviderCredentials, reveal: bool) -> CredentialSummary {
    let api_key = if reveal {
        credential.api_key.clone()
    } else {
        redact_key(&credential.api_key)
    };
    CredentialSummary {
        provider: credential.provider.clone(),
        source: credential.source.clone(),
        auth_type: match credential.auth_type {
            AuthType::ApiKey => "api_key".to_string(),
            AuthType::Oauth => "oauth".to_string(),
        },
        api_key,
        redacted: !reveal,
    }
}

fn redact_key(key: &str) -> String {
    let trimmed = key.trim();
    let len = trimmed.len();
    if len <= 8 {
        return "****".to_string();
    }
    let prefix = &trimmed[..4];
    let suffix = &trimmed[len - 4..];
    format!("{prefix}...{suffix}")
}

fn select_token_for_agent(
    credentials: &ExtractedCredentials,
    agent: CredentialAgent,
    provider: Option<&str>,
) -> Result<String, CliError> {
    match agent {
        CredentialAgent::Claude | CredentialAgent::Amp => {
            if let Some(provider) = provider {
                if provider != "anthropic" {
                    return Err(CliError::Server(format!(
                        "agent {:?} only supports provider anthropic",
                        agent
                    )));
                }
            }
            select_token_for_provider(credentials, "anthropic")
        }
        CredentialAgent::Codex => {
            if let Some(provider) = provider {
                if provider != "openai" {
                    return Err(CliError::Server(format!(
                        "agent {:?} only supports provider openai",
                        agent
                    )));
                }
            }
            select_token_for_provider(credentials, "openai")
        }
        CredentialAgent::Opencode => {
            if let Some(provider) = provider {
                return select_token_for_provider(credentials, provider);
            }
            if let Some(openai) = credentials.openai.as_ref() {
                return Ok(openai.api_key.clone());
            }
            if let Some(anthropic) = credentials.anthropic.as_ref() {
                return Ok(anthropic.api_key.clone());
            }
            if credentials.other.len() == 1 {
                if let Some((_, cred)) = credentials.other.iter().next() {
                    return Ok(cred.api_key.clone());
                }
            }
            let available = available_providers(credentials);
            if available.is_empty() {
                Err(CliError::Server(
                    "no credentials found for opencode".to_string(),
                ))
            } else {
                Err(CliError::Server(format!(
                    "multiple providers available for opencode: {} (use --provider)",
                    available.join(", ")
                )))
            }
        }
    }
}

fn select_token_for_provider(
    credentials: &ExtractedCredentials,
    provider: &str,
) -> Result<String, CliError> {
    if let Some(cred) = provider_credential(credentials, provider) {
        Ok(cred.api_key.clone())
    } else {
        Err(CliError::Server(format!(
            "no credentials found for provider {provider}"
        )))
    }
}

fn provider_credential<'a>(
    credentials: &'a ExtractedCredentials,
    provider: &str,
) -> Option<&'a ProviderCredentials> {
    match provider {
        "openai" => credentials.openai.as_ref(),
        "anthropic" => credentials.anthropic.as_ref(),
        _ => credentials.other.get(provider),
    }
}

fn available_providers(credentials: &ExtractedCredentials) -> Vec<String> {
    let mut providers = Vec::new();
    if credentials.openai.is_some() {
        providers.push("openai".to_string());
    }
    if credentials.anthropic.is_some() {
        providers.push("anthropic".to_string());
    }
    for key in credentials.other.keys() {
        providers.push(key.clone());
    }
    providers.sort();
    providers.dedup();
    providers
}

fn default_install_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("bin"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("bin"))
}

fn apply_last_event_id_header(
    request: reqwest::blocking::RequestBuilder,
    last_event_id: Option<u64>,
) -> reqwest::blocking::RequestBuilder {
    match last_event_id {
        Some(last_event_id) => request.header("last-event-id", last_event_id.to_string()),
        None => request,
    }
}

fn unique_cli_server_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{prefix}-{}-{millis}", std::process::id())
}

fn build_acp_server_path(
    server_id: &str,
    bootstrap_agent: Option<&str>,
) -> Result<String, CliError> {
    let server_id = server_id.trim();
    if server_id.is_empty() {
        return Err(CliError::Server("server id must not be empty".to_string()));
    }
    if server_id.contains('/') {
        return Err(CliError::Server(
            "server id must not contain '/'".to_string(),
        ));
    }

    let mut path = format!("{API_PREFIX}/acp/{server_id}");
    if let Some(agent) = bootstrap_agent {
        let agent = agent.trim();
        if agent.is_empty() {
            return Err(CliError::Server(
                "agent must not be empty when provided".to_string(),
            ));
        }
        path.push_str("?agent=");
        path.push_str(agent);
    }

    Ok(path)
}

fn default_server_log_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SANDBOX_AGENT_LOG_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("logs"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("logs"))
}

fn maybe_redirect_server_logs() {
    if std::env::var("SANDBOX_AGENT_LOG_STDOUT").is_ok() {
        return;
    }

    let log_dir = default_server_log_dir();
    if let Err(err) = ServerLogs::new(log_dir, LOGS_RETENTION).start_sync() {
        eprintln!("failed to redirect logs: {err}");
    }
}

fn build_cors_layer(server: &ServerArgs) -> Result<CorsLayer, CliError> {
    let mut cors = CorsLayer::new();

    let mut origins = Vec::new();
    for origin in &server.cors_allow_origin {
        let value = origin
            .parse()
            .map_err(|_| CliError::InvalidCorsOrigin(origin.clone()))?;
        origins.push(value);
    }
    if origins.is_empty() {
        cors = cors.allow_origin(tower_http::cors::AllowOrigin::predicate(|_, _| false));
    } else {
        cors = cors.allow_origin(origins);
    }

    if server.cors_allow_method.is_empty() {
        cors = cors.allow_methods(Any);
    } else {
        let mut methods = Vec::new();
        for method in &server.cors_allow_method {
            let parsed = method
                .parse()
                .map_err(|_| CliError::InvalidCorsMethod(method.clone()))?;
            methods.push(parsed);
        }
        cors = cors.allow_methods(methods);
    }

    if server.cors_allow_header.is_empty() {
        cors = cors.allow_headers(Any);
    } else {
        let mut headers = Vec::new();
        for header in &server.cors_allow_header {
            let parsed = header
                .parse()
                .map_err(|_| CliError::InvalidCorsHeader(header.clone()))?;
            headers.push(parsed);
        }
        cors = cors.allow_headers(headers);
    }

    if server.cors_allow_credentials {
        cors = cors.allow_credentials(true);
    }

    Ok(cors)
}

struct ClientContext {
    endpoint: String,
    token: Option<String>,
    client: HttpClient,
}

impl ClientContext {
    fn new(cli: &CliConfig, args: &ClientArgs) -> Result<Self, CliError> {
        let endpoint = args
            .endpoint
            .clone()
            .unwrap_or_else(|| format!("http://{}:{}", DEFAULT_HOST, DEFAULT_PORT));
        let token = if cli.no_token {
            None
        } else {
            cli.token.clone()
        };
        let client = HttpClient::builder().build()?;
        Ok(Self {
            endpoint,
            token,
            client,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint.trim_end_matches('/'), path)
    }

    fn request(&self, method: Method, path: &str) -> reqwest::blocking::RequestBuilder {
        let url = self.url(path);
        let mut builder = self.client.request(method, url);
        if let Some(token) = &self.token {
            builder = builder.bearer_auth(token);
        }
        builder
    }

    fn get(&self, path: &str) -> Result<reqwest::blocking::Response, CliError> {
        Ok(self.request(Method::GET, path).send()?)
    }

    fn post<T: Serialize>(
        &self,
        path: &str,
        body: &T,
    ) -> Result<reqwest::blocking::Response, CliError> {
        Ok(self.request(Method::POST, path).json(body).send()?)
    }

    fn delete(&self, path: &str) -> Result<reqwest::blocking::Response, CliError> {
        Ok(self.request(Method::DELETE, path).send()?)
    }
}

fn print_json_response<T: serde::de::DeserializeOwned + Serialize>(
    response: reqwest::blocking::Response,
) -> Result<(), CliError> {
    let status = response.status();
    let text = response.text()?;

    if !status.is_success() {
        print_error_body(&text)?;
        return Err(CliError::HttpStatus(status));
    }

    let parsed: T = serde_json::from_str(&text)?;
    let pretty = serde_json::to_string_pretty(&parsed)?;
    write_stdout_line(&pretty)?;
    Ok(())
}

fn print_json_or_empty(response: reqwest::blocking::Response) -> Result<(), CliError> {
    let status = response.status();
    let text = response.text()?;

    if !status.is_success() {
        print_error_body(&text)?;
        return Err(CliError::HttpStatus(status));
    }

    if text.trim().is_empty() {
        return Ok(());
    }

    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        write_stdout_line(&serde_json::to_string_pretty(&value)?)
    } else {
        write_stdout_line(&text)
    }
}

fn print_text_response(response: reqwest::blocking::Response) -> Result<(), CliError> {
    let status = response.status();
    let text = response.text()?;

    if !status.is_success() {
        print_error_body(&text)?;
        return Err(CliError::HttpStatus(status));
    }

    write_stdout(&text)
}

fn print_empty_response(response: reqwest::blocking::Response) -> Result<(), CliError> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    let text = response.text()?;
    print_error_body(&text)?;
    Err(CliError::HttpStatus(status))
}

fn print_error_body(text: &str) -> Result<(), CliError> {
    if let Ok(json) = serde_json::from_str::<Value>(text) {
        let pretty = serde_json::to_string_pretty(&json)?;
        write_stderr_line(&pretty)
    } else {
        write_stderr_line(text)
    }
}

fn write_stdout(text: &str) -> Result<(), CliError> {
    let mut out = std::io::stdout();
    out.write_all(text.as_bytes())?;
    out.flush()?;
    Ok(())
}

fn write_stdout_line(text: &str) -> Result<(), CliError> {
    let mut out = std::io::stdout();
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

fn write_stderr_line(text: &str) -> Result<(), CliError> {
    let mut out = std::io::stderr();
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_install_agents_expands_all() {
        assert_eq!(
            resolve_install_agents(&InstallAgentArgs {
                agent: None,
                all: true,
                reinstall: false,
                agent_version: None,
                agent_process_version: None,
            })
            .unwrap(),
            AgentId::all().to_vec()
        );
    }

    #[test]
    fn resolve_install_agents_supports_single_agent() {
        assert_eq!(
            resolve_install_agents(&InstallAgentArgs {
                agent: Some("codex".to_string()),
                all: false,
                reinstall: false,
                agent_version: None,
                agent_process_version: None,
            })
            .unwrap(),
            vec![AgentId::Codex]
        );
    }

    #[test]
    fn resolve_install_agents_rejects_unknown_agent() {
        assert!(resolve_install_agents(&InstallAgentArgs {
            agent: Some("nope".to_string()),
            all: false,
            reinstall: false,
            agent_version: None,
            agent_process_version: None,
        })
        .is_err());
    }

    #[test]
    fn resolve_install_agents_rejects_positional_all() {
        assert!(resolve_install_agents(&InstallAgentArgs {
            agent: Some("all".to_string()),
            all: false,
            reinstall: false,
            agent_version: None,
            agent_process_version: None,
        })
        .is_err());
    }

    #[test]
    fn apply_last_event_id_header_sets_header_when_provided() {
        let client = HttpClient::builder().build().expect("build client");
        let request =
            apply_last_event_id_header(client.get("http://localhost/v1/acp/test"), Some(42))
                .build()
                .expect("build request");

        let header = request
            .headers()
            .get("last-event-id")
            .and_then(|value| value.to_str().ok());
        assert_eq!(header, Some("42"));
    }

    #[test]
    fn apply_last_event_id_header_omits_header_when_absent() {
        let client = HttpClient::builder().build().expect("build client");
        let request = apply_last_event_id_header(client.get("http://localhost/v1/acp/test"), None)
            .build()
            .expect("build request");
        assert!(request.headers().get("last-event-id").is_none());
    }

    #[test]
    fn classify_report_category_supports_common_aliases() {
        assert!(matches!(
            classify_report_category("model"),
            Some(ConfigReportCategory::Model)
        ));
        assert!(matches!(
            classify_report_category("mode"),
            Some(ConfigReportCategory::Mode)
        ));
        assert!(matches!(
            classify_report_category("thought_level"),
            Some(ConfigReportCategory::ThoughtLevel)
        ));
        assert!(matches!(
            classify_report_category("reasoning_effort"),
            Some(ConfigReportCategory::ThoughtLevel)
        ));
        assert!(classify_report_category("arbitrary").is_none());
    }

    #[test]
    fn build_agent_config_report_extracts_model_mode_and_thought() {
        let response = AgentListApiResponse {
            agents: vec![AgentListApiAgent {
                id: "codex".to_string(),
                installed: true,
                config_error: None,
                config_options: Some(vec![
                    json!({
                        "id": "model",
                        "category": "model",
                        "currentValue": "gpt-5",
                        "options": [
                            {"value": "gpt-5", "name": "GPT-5"},
                            {"value": "gpt-5-mini", "name": "GPT-5 mini"}
                        ]
                    }),
                    json!({
                        "id": "mode",
                        "category": "mode",
                        "currentValue": "default",
                        "options": [
                            {"value": "default", "name": "Default"},
                            {"value": "plan", "name": "Plan"}
                        ]
                    }),
                    json!({
                        "id": "thought",
                        "category": "thought_level",
                        "currentValue": "medium",
                        "options": [
                            {"value": "low", "name": "Low"},
                            {"value": "medium", "name": "Medium"},
                            {"value": "high", "name": "High"}
                        ]
                    }),
                ]),
            }],
        };

        let report = build_agent_config_report(response, "http://127.0.0.1:2468");
        let agent = report.agents.first().expect("agent report");

        assert_eq!(agent.id, "codex");
        assert_eq!(agent.models.current_value.as_deref(), Some("gpt-5"));
        assert_eq!(agent.modes.current_value.as_deref(), Some("default"));
        assert_eq!(
            agent.thought_levels.current_value.as_deref(),
            Some("medium")
        );

        let model_values: Vec<&str> = agent
            .models
            .values
            .iter()
            .map(|item| item.value.as_str())
            .collect();
        assert!(model_values.contains(&"gpt-5"));
        assert!(model_values.contains(&"gpt-5-mini"));

        let thought_values: Vec<&str> = agent
            .thought_levels
            .values
            .iter()
            .map(|item| item.value.as_str())
            .collect();
        assert!(thought_values.contains(&"low"));
        assert!(thought_values.contains(&"medium"));
        assert!(thought_values.contains(&"high"));
    }
}
