use std::collections::BTreeMap;

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServerStatus {
    Running,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusInfo {
    pub status: ServerStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub plan_mode: bool,
    pub permissions: bool,
    pub questions: bool,
    pub tool_calls: bool,
    pub tool_results: bool,
    pub text_messages: bool,
    pub images: bool,
    pub file_attachments: bool,
    pub session_lifecycle: bool,
    pub error_events: bool,
    pub reasoning: bool,
    pub status: bool,
    pub command_execution: bool,
    pub file_changes: bool,
    pub mcp_tools: bool,
    pub streaming_deltas: bool,
    pub item_started: bool,
    pub shared_process: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub installed: bool,
    pub credentials_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub capabilities: AgentCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_status: Option<ServerStatusInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentListResponse {
    pub agents: Vec<AgentInfo>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentsQuery {
    #[serde(default)]
    pub config: Option<bool>,
    #[serde(default)]
    pub no_cache: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallRequest {
    pub reinstall: Option<bool>,
    pub agent_version: Option<String>,
    pub agent_process_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct AgentInstallArtifact {
    pub kind: String,
    pub path: String,
    pub source: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct AgentInstallResponse {
    pub already_installed: bool,
    pub artifacts: Vec<AgentInstallArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsPathQuery {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsEntriesQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsDeleteQuery {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsUploadBatchQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryType {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub entry_type: FsEntryType,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub path: String,
    pub entry_type: FsEntryType,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteResponse {
    pub path: String,
    pub bytes_written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMoveRequest {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMoveResponse {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsActionResponse {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsUploadBatchResponse {
    pub paths: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpPostQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpServerInfo {
    pub server_id: String,
    pub agent: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpServerListResponse {
    pub servers: Vec<AcpServerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigQuery {
    pub directory: String,
    #[serde(rename = "mcpName", alias = "mcp_name")]
    pub mcp_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsConfigQuery {
    pub directory: String,
    #[serde(rename = "skillName", alias = "skill_name")]
    pub skill_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsConfig {
    pub sources: Vec<SkillSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    #[serde(rename = "type")]
    pub source_type: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(untagged)]
pub enum McpCommand {
    Command(String),
    CommandWithArgs(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum McpRemoteTransport {
    Http,
    Sse,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(untagged)]
pub enum McpOAuthConfigOrDisabled {
    Config(McpOAuthConfig),
    Disabled(bool),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum McpServerConfig {
    #[serde(rename = "local", alias = "stdio")]
    Local {
        command: McpCommand,
        #[serde(default)]
        args: Vec<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            alias = "environment"
        )]
        env: Option<BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "timeoutMs",
            alias = "timeout"
        )]
        #[schema(rename = "timeoutMs")]
        timeout_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    #[serde(rename = "remote", alias = "http")]
    Remote {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<BTreeMap<String, String>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "bearerTokenEnvVar",
            alias = "bearerTokenEnvVar",
            alias = "bearer_token_env_var"
        )]
        #[schema(rename = "bearerTokenEnvVar")]
        bearer_token_env_var: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "envHeaders",
            alias = "envHttpHeaders",
            alias = "env_http_headers"
        )]
        #[schema(rename = "envHeaders")]
        env_headers: Option<BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        oauth: Option<McpOAuthConfigOrDisabled>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "timeoutMs",
            alias = "timeout"
        )]
        #[schema(rename = "timeoutMs")]
        timeout_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transport: Option<McpRemoteTransport>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct AcpEnvelope {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessConfig {
    pub max_concurrent_processes: usize,
    pub default_run_timeout_ms: u64,
    pub max_run_timeout_ms: u64,
    pub max_output_bytes: usize,
    pub max_log_bytes_per_process: usize,
    pub max_input_bytes_per_request: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCreateRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub tty: bool,
    #[serde(default)]
    pub interactive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRunRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRunResponse {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessState {
    Running,
    Exited,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessOwner {
    User,
    Desktop,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub tty: bool,
    pub interactive: bool,
    pub owner: ProcessOwner,
    pub status: ProcessState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exited_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessListResponse {
    pub processes: Vec<ProcessInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct ProcessListQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<ProcessOwner>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessLogsStream {
    Stdout,
    Stderr,
    Combined,
    Pty,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<ProcessLogsStream>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogEntry {
    pub sequence: u64,
    pub stream: ProcessLogsStream,
    pub timestamp_ms: i64,
    pub data: String,
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogsResponse {
    pub process_id: String,
    pub stream: ProcessLogsStream,
    pub entries: Vec<ProcessLogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInputRequest {
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInputResponse {
    pub bytes_written: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSignalQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTerminalResizeRequest {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTerminalResizeResponse {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessWsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
}
