use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorType {
    InvalidRequest,
    Conflict,
    UnsupportedAgent,
    AgentNotInstalled,
    InstallFailed,
    AgentProcessExited,
    TokenInvalid,
    PermissionDenied,
    NotAcceptable,
    UnsupportedMediaType,
    NotFound,
    SessionNotFound,
    SessionAlreadyExists,
    ModeNotSupported,
    StreamError,
    Timeout,
}

impl ErrorType {
    pub fn as_urn(&self) -> &'static str {
        match self {
            Self::InvalidRequest => "urn:sandbox-agent:error:invalid_request",
            Self::Conflict => "urn:sandbox-agent:error:conflict",
            Self::UnsupportedAgent => "urn:sandbox-agent:error:unsupported_agent",
            Self::AgentNotInstalled => "urn:sandbox-agent:error:agent_not_installed",
            Self::InstallFailed => "urn:sandbox-agent:error:install_failed",
            Self::AgentProcessExited => "urn:sandbox-agent:error:agent_process_exited",
            Self::TokenInvalid => "urn:sandbox-agent:error:token_invalid",
            Self::PermissionDenied => "urn:sandbox-agent:error:permission_denied",
            Self::NotAcceptable => "urn:sandbox-agent:error:not_acceptable",
            Self::UnsupportedMediaType => "urn:sandbox-agent:error:unsupported_media_type",
            Self::NotFound => "urn:sandbox-agent:error:not_found",
            Self::SessionNotFound => "urn:sandbox-agent:error:session_not_found",
            Self::SessionAlreadyExists => "urn:sandbox-agent:error:session_already_exists",
            Self::ModeNotSupported => "urn:sandbox-agent:error:mode_not_supported",
            Self::StreamError => "urn:sandbox-agent:error:stream_error",
            Self::Timeout => "urn:sandbox-agent:error:timeout",
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Self::InvalidRequest => "Invalid Request",
            Self::Conflict => "Conflict",
            Self::UnsupportedAgent => "Unsupported Agent",
            Self::AgentNotInstalled => "Agent Not Installed",
            Self::InstallFailed => "Install Failed",
            Self::AgentProcessExited => "Agent Process Exited",
            Self::TokenInvalid => "Token Invalid",
            Self::PermissionDenied => "Permission Denied",
            Self::NotAcceptable => "Not Acceptable",
            Self::UnsupportedMediaType => "Unsupported Media Type",
            Self::NotFound => "Not Found",
            Self::SessionNotFound => "Session Not Found",
            Self::SessionAlreadyExists => "Session Already Exists",
            Self::ModeNotSupported => "Mode Not Supported",
            Self::StreamError => "Stream Error",
            Self::Timeout => "Timeout",
        }
    }

    pub fn status_code(&self) -> u16 {
        match self {
            Self::InvalidRequest => 400,
            Self::Conflict => 409,
            Self::UnsupportedAgent => 400,
            Self::AgentNotInstalled => 404,
            Self::InstallFailed => 500,
            Self::AgentProcessExited => 500,
            Self::TokenInvalid => 401,
            Self::PermissionDenied => 403,
            Self::NotAcceptable => 406,
            Self::UnsupportedMediaType => 415,
            Self::NotFound => 404,
            Self::SessionNotFound => 404,
            Self::SessionAlreadyExists => 409,
            Self::ModeNotSupported => 400,
            Self::StreamError => 502,
            Self::Timeout => 504,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct ProblemDetails {
    #[serde(rename = "type")]
    pub type_: String,
    pub title: String,
    pub status: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extensions: Map<String, Value>,
}

impl ProblemDetails {
    pub fn new(error_type: ErrorType, detail: Option<String>) -> Self {
        Self {
            type_: error_type.as_urn().to_string(),
            title: error_type.title().to_string(),
            status: error_type.status_code(),
            detail,
            instance: None,
            extensions: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct AgentError {
    #[serde(rename = "type")]
    pub type_: ErrorType,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("invalid request: {message}")]
    InvalidRequest { message: String },
    #[error("conflict: {message}")]
    Conflict { message: String },
    #[error("unsupported agent: {agent}")]
    UnsupportedAgent { agent: String },
    #[error("agent not installed: {agent}")]
    AgentNotInstalled { agent: String },
    #[error("install failed: {agent}")]
    InstallFailed {
        agent: String,
        stderr: Option<String>,
    },
    #[error("agent process exited: {agent}")]
    AgentProcessExited {
        agent: String,
        exit_code: Option<i32>,
        stderr: Option<String>,
    },
    #[error("token invalid")]
    TokenInvalid { message: Option<String> },
    #[error("permission denied")]
    PermissionDenied { message: Option<String> },
    #[error("not acceptable: {message}")]
    NotAcceptable { message: String },
    #[error("unsupported media type: {message}")]
    UnsupportedMediaType { message: String },
    #[error("not found: {resource} {id}")]
    NotFound { resource: String, id: String },
    #[error("session not found: {session_id}")]
    SessionNotFound { session_id: String },
    #[error("session already exists: {session_id}")]
    SessionAlreadyExists { session_id: String },
    #[error("mode not supported: {agent} {mode}")]
    ModeNotSupported { agent: String, mode: String },
    #[error("stream error: {message}")]
    StreamError { message: String },
    #[error("timeout")]
    Timeout { message: Option<String> },
}

impl SandboxError {
    pub fn error_type(&self) -> ErrorType {
        match self {
            Self::InvalidRequest { .. } => ErrorType::InvalidRequest,
            Self::Conflict { .. } => ErrorType::Conflict,
            Self::UnsupportedAgent { .. } => ErrorType::UnsupportedAgent,
            Self::AgentNotInstalled { .. } => ErrorType::AgentNotInstalled,
            Self::InstallFailed { .. } => ErrorType::InstallFailed,
            Self::AgentProcessExited { .. } => ErrorType::AgentProcessExited,
            Self::TokenInvalid { .. } => ErrorType::TokenInvalid,
            Self::PermissionDenied { .. } => ErrorType::PermissionDenied,
            Self::NotAcceptable { .. } => ErrorType::NotAcceptable,
            Self::UnsupportedMediaType { .. } => ErrorType::UnsupportedMediaType,
            Self::NotFound { .. } => ErrorType::NotFound,
            Self::SessionNotFound { .. } => ErrorType::SessionNotFound,
            Self::SessionAlreadyExists { .. } => ErrorType::SessionAlreadyExists,
            Self::ModeNotSupported { .. } => ErrorType::ModeNotSupported,
            Self::StreamError { .. } => ErrorType::StreamError,
            Self::Timeout { .. } => ErrorType::Timeout,
        }
    }

    pub fn to_agent_error(&self) -> AgentError {
        let (agent, session_id, details) = match self {
            Self::InvalidRequest { .. } => (None, None, None),
            Self::Conflict { message } => {
                let mut map = Map::new();
                map.insert("message".to_string(), Value::String(message.clone()));
                (None, None, Some(Value::Object(map)))
            }
            Self::UnsupportedAgent { agent } => (Some(agent.clone()), None, None),
            Self::AgentNotInstalled { agent } => (Some(agent.clone()), None, None),
            Self::InstallFailed { agent, stderr } => {
                let mut map = Map::new();
                if let Some(stderr) = stderr {
                    map.insert("stderr".to_string(), Value::String(stderr.clone()));
                }
                (
                    Some(agent.clone()),
                    None,
                    if map.is_empty() {
                        None
                    } else {
                        Some(Value::Object(map))
                    },
                )
            }
            Self::AgentProcessExited {
                agent,
                exit_code,
                stderr,
            } => {
                let mut map = Map::new();
                if let Some(code) = exit_code {
                    map.insert(
                        "exitCode".to_string(),
                        Value::Number(serde_json::Number::from(*code as i64)),
                    );
                }
                if let Some(stderr) = stderr {
                    map.insert("stderr".to_string(), Value::String(stderr.clone()));
                }
                (
                    Some(agent.clone()),
                    None,
                    if map.is_empty() {
                        None
                    } else {
                        Some(Value::Object(map))
                    },
                )
            }
            Self::TokenInvalid { message } => {
                let details = message.as_ref().map(|msg| {
                    let mut map = Map::new();
                    map.insert("message".to_string(), Value::String(msg.clone()));
                    Value::Object(map)
                });
                (None, None, details)
            }
            Self::PermissionDenied { message } => {
                let details = message.as_ref().map(|msg| {
                    let mut map = Map::new();
                    map.insert("message".to_string(), Value::String(msg.clone()));
                    Value::Object(map)
                });
                (None, None, details)
            }
            Self::NotAcceptable { message } => {
                let mut map = Map::new();
                map.insert("message".to_string(), Value::String(message.clone()));
                (None, None, Some(Value::Object(map)))
            }
            Self::UnsupportedMediaType { message } => {
                let mut map = Map::new();
                map.insert("message".to_string(), Value::String(message.clone()));
                (None, None, Some(Value::Object(map)))
            }
            Self::NotFound { resource, id } => {
                let mut map = Map::new();
                map.insert("resource".to_string(), Value::String(resource.clone()));
                map.insert("id".to_string(), Value::String(id.clone()));
                (None, None, Some(Value::Object(map)))
            }
            Self::SessionNotFound { session_id } => (None, Some(session_id.clone()), None),
            Self::SessionAlreadyExists { session_id } => (None, Some(session_id.clone()), None),
            Self::ModeNotSupported { agent, mode } => {
                let mut map = Map::new();
                map.insert("mode".to_string(), Value::String(mode.clone()));
                (Some(agent.clone()), None, Some(Value::Object(map)))
            }
            Self::StreamError { message } => {
                let mut map = Map::new();
                map.insert("message".to_string(), Value::String(message.clone()));
                (None, None, Some(Value::Object(map)))
            }
            Self::Timeout { message } => {
                let details = message.as_ref().map(|msg| {
                    let mut map = Map::new();
                    map.insert("message".to_string(), Value::String(msg.clone()));
                    Value::Object(map)
                });
                (None, None, details)
            }
        };

        AgentError {
            type_: self.error_type(),
            message: self.to_string(),
            agent,
            session_id,
            details,
        }
    }

    pub fn to_problem_details(&self) -> ProblemDetails {
        let mut problem = ProblemDetails::new(self.error_type(), Some(self.to_string()));
        let agent_error = self.to_agent_error();

        let mut extensions = Map::new();
        if let Some(agent) = agent_error.agent {
            extensions.insert("agent".to_string(), Value::String(agent));
        }
        if let Some(session_id) = agent_error.session_id {
            extensions.insert("sessionId".to_string(), Value::String(session_id));
        }
        if let Some(details) = agent_error.details {
            extensions.insert("details".to_string(), details);
        }
        problem.extensions = extensions;
        problem
    }
}

impl From<SandboxError> for ProblemDetails {
    fn from(value: SandboxError) -> Self {
        value.to_problem_details()
    }
}

impl From<&SandboxError> for ProblemDetails {
    fn from(value: &SandboxError) -> Self {
        value.to_problem_details()
    }
}

impl From<SandboxError> for AgentError {
    fn from(value: SandboxError) -> Self {
        value.to_agent_error()
    }
}

impl From<&SandboxError> for AgentError {
    fn from(value: &SandboxError) -> Self {
        value.to_agent_error()
    }
}
