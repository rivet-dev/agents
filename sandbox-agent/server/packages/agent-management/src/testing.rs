use std::env;
use std::path::PathBuf;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::StatusCode;
use thiserror::Error;

use crate::agents::AgentId;
use crate::credentials::{
    extract_all_credentials, AuthType, CredentialExtractionOptions, ExtractedCredentials,
    ProviderCredentials,
};

#[derive(Debug, Clone)]
pub struct TestAgentConfig {
    pub agent: AgentId,
    pub credentials: ExtractedCredentials,
}

#[derive(Debug, Error)]
pub enum TestAgentConfigError {
    #[error("no test agents detected (install agents or set SANDBOX_TEST_AGENTS)")]
    NoAgentsConfigured,
    #[error("unknown agent name: {0}")]
    UnknownAgent(String),
    #[error("missing credentials for {agent}: {missing}")]
    MissingCredentials { agent: AgentId, missing: String },
    #[error("invalid credentials for {provider} (status {status})")]
    InvalidCredentials { provider: String, status: u16 },
    #[error("credential health check failed for {provider}: {message}")]
    HealthCheckFailed { provider: String, message: String },
}

const AGENTS_ENV: &str = "SANDBOX_TEST_AGENTS";
const ANTHROPIC_ENV: &str = "SANDBOX_TEST_ANTHROPIC_API_KEY";
const OPENAI_ENV: &str = "SANDBOX_TEST_OPENAI_API_KEY";
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Default)]
struct HealthCheckCache {
    anthropic_ok: bool,
    openai_ok: bool,
}

pub fn test_agents_from_env() -> Result<Vec<TestAgentConfig>, TestAgentConfigError> {
    let raw_agents = env::var(AGENTS_ENV).unwrap_or_default();
    let mut agents = if raw_agents.trim().is_empty() {
        detect_system_agents()
    } else {
        let mut agents = Vec::new();
        for entry in raw_agents.split(',') {
            let trimmed = entry.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed == "all" {
                agents.extend([
                    AgentId::Claude,
                    AgentId::Codex,
                    AgentId::Opencode,
                    AgentId::Amp,
                    AgentId::Pi,
                    AgentId::Cursor,
                ]);
                continue;
            }
            let agent = AgentId::parse(trimmed)
                .ok_or_else(|| TestAgentConfigError::UnknownAgent(trimmed.to_string()))?;
            agents.push(agent);
        }
        agents
    };

    agents.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    agents.dedup();

    if agents.is_empty() {
        return Err(TestAgentConfigError::NoAgentsConfigured);
    }

    let extracted = extract_all_credentials(&CredentialExtractionOptions::new());
    let anthropic_cred = read_env_key(ANTHROPIC_ENV)
        .map(|key| ProviderCredentials {
            api_key: key,
            source: "sandbox-test-env".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "anthropic".to_string(),
        })
        .or_else(|| extracted.anthropic.clone());
    let openai_cred = read_env_key(OPENAI_ENV)
        .map(|key| ProviderCredentials {
            api_key: key,
            source: "sandbox-test-env".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "openai".to_string(),
        })
        .or_else(|| extracted.openai.clone());
    let mut health_cache = HealthCheckCache::default();

    let mut configs = Vec::new();
    for agent in agents {
        let credentials = match agent {
            AgentId::Claude | AgentId::Amp => {
                let anthropic_cred = anthropic_cred.clone().ok_or_else(|| {
                    TestAgentConfigError::MissingCredentials {
                        agent,
                        missing: ANTHROPIC_ENV.to_string(),
                    }
                })?;
                ensure_anthropic_ok(&mut health_cache, &anthropic_cred)?;
                credentials_with(Some(anthropic_cred), None)
            }
            AgentId::Codex => {
                let openai_cred = openai_cred.clone().ok_or_else(|| {
                    TestAgentConfigError::MissingCredentials {
                        agent,
                        missing: OPENAI_ENV.to_string(),
                    }
                })?;
                ensure_openai_ok(&mut health_cache, &openai_cred)?;
                credentials_with(None, Some(openai_cred))
            }
            AgentId::Opencode => {
                if anthropic_cred.is_none() && openai_cred.is_none() {
                    return Err(TestAgentConfigError::MissingCredentials {
                        agent,
                        missing: format!("{ANTHROPIC_ENV} or {OPENAI_ENV}"),
                    });
                }
                if let Some(cred) = anthropic_cred.as_ref() {
                    ensure_anthropic_ok(&mut health_cache, cred)?;
                }
                if let Some(cred) = openai_cred.as_ref() {
                    ensure_openai_ok(&mut health_cache, cred)?;
                }
                credentials_with(anthropic_cred.clone(), openai_cred.clone())
            }
            AgentId::Pi | AgentId::Cursor => credentials_with(None, None),
            AgentId::Mock => credentials_with(None, None),
        };
        configs.push(TestAgentConfig { agent, credentials });
    }

    Ok(configs)
}

fn ensure_anthropic_ok(
    cache: &mut HealthCheckCache,
    credentials: &ProviderCredentials,
) -> Result<(), TestAgentConfigError> {
    if cache.anthropic_ok {
        return Ok(());
    }
    health_check_anthropic(credentials)?;
    cache.anthropic_ok = true;
    Ok(())
}

fn ensure_openai_ok(
    cache: &mut HealthCheckCache,
    credentials: &ProviderCredentials,
) -> Result<(), TestAgentConfigError> {
    if cache.openai_ok {
        return Ok(());
    }
    health_check_openai(credentials)?;
    cache.openai_ok = true;
    Ok(())
}

fn health_check_anthropic(credentials: &ProviderCredentials) -> Result<(), TestAgentConfigError> {
    let credentials = credentials.clone();
    run_blocking_check("anthropic", move || {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|err| TestAgentConfigError::HealthCheckFailed {
                provider: "anthropic".to_string(),
                message: err.to_string(),
            })?;
        let mut headers = HeaderMap::new();
        match credentials.auth_type {
            AuthType::ApiKey => {
                headers.insert(
                    "x-api-key",
                    HeaderValue::from_str(&credentials.api_key).map_err(|_| {
                        TestAgentConfigError::HealthCheckFailed {
                            provider: "anthropic".to_string(),
                            message: "invalid anthropic api key header value".to_string(),
                        }
                    })?,
                );
            }
            AuthType::Oauth => {
                let value = format!("Bearer {}", credentials.api_key);
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&value).map_err(|_| {
                        TestAgentConfigError::HealthCheckFailed {
                            provider: "anthropic".to_string(),
                            message: "invalid anthropic oauth header value".to_string(),
                        }
                    })?,
                );
            }
        }
        headers.insert(
            "anthropic-version",
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let response = client
            .get(ANTHROPIC_MODELS_URL)
            .headers(headers)
            .send()
            .map_err(|err| TestAgentConfigError::HealthCheckFailed {
                provider: "anthropic".to_string(),
                message: err.to_string(),
            })?;
        handle_health_response("anthropic", response)
    })
}

fn health_check_openai(credentials: &ProviderCredentials) -> Result<(), TestAgentConfigError> {
    let credentials = credentials.clone();
    run_blocking_check("openai", move || {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|err| TestAgentConfigError::HealthCheckFailed {
                provider: "openai".to_string(),
                message: err.to_string(),
            })?;
        let response = client
            .get(OPENAI_MODELS_URL)
            .bearer_auth(&credentials.api_key)
            .send()
            .map_err(|err| TestAgentConfigError::HealthCheckFailed {
                provider: "openai".to_string(),
                message: err.to_string(),
            })?;
        handle_health_response("openai", response)
    })
}

fn handle_health_response(
    provider: &str,
    response: reqwest::blocking::Response,
) -> Result<(), TestAgentConfigError> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    // 401 always means invalid credentials
    if status == StatusCode::UNAUTHORIZED {
        return Err(TestAgentConfigError::InvalidCredentials {
            provider: provider.to_string(),
            status: status.as_u16(),
        });
    }
    // 403 could mean invalid credentials OR valid OAuth token with missing scopes
    // Check the response body to distinguish
    if status == StatusCode::FORBIDDEN {
        let body = response.text().unwrap_or_default();
        // OAuth tokens may lack scopes for /v1/models but still be valid
        // "Missing scopes" means the token authenticated successfully
        if body.contains("Missing scopes") || body.contains("insufficient permissions") {
            return Ok(());
        }
        return Err(TestAgentConfigError::InvalidCredentials {
            provider: provider.to_string(),
            status: status.as_u16(),
        });
    }
    let body = response.text().unwrap_or_default();
    let mut summary = body.trim().to_string();
    if summary.len() > 200 {
        summary.truncate(200);
    }
    Err(TestAgentConfigError::HealthCheckFailed {
        provider: provider.to_string(),
        message: format!("status {}: {}", status.as_u16(), summary),
    })
}

fn run_blocking_check<F>(provider: &str, check: F) -> Result<(), TestAgentConfigError>
where
    F: FnOnce() -> Result<(), TestAgentConfigError> + Send + 'static,
{
    std::thread::spawn(check).join().unwrap_or_else(|_| {
        Err(TestAgentConfigError::HealthCheckFailed {
            provider: provider.to_string(),
            message: "health check panicked".to_string(),
        })
    })
}

fn detect_system_agents() -> Vec<AgentId> {
    let candidates = [
        AgentId::Claude,
        AgentId::Codex,
        AgentId::Opencode,
        AgentId::Amp,
        AgentId::Pi,
        AgentId::Cursor,
    ];
    let install_dir = default_install_dir();
    candidates
        .into_iter()
        .filter(|agent| {
            let binary = agent.binary_name();
            find_in_path(binary) || install_dir.join(binary).exists()
        })
        .collect()
}

fn default_install_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("bin"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("bin"))
}

fn find_in_path(binary_name: &str) -> bool {
    let path_var = match env::var_os("PATH") {
        Some(path) => path,
        None => return false,
    };
    for path in env::split_paths(&path_var) {
        let candidate = path.join(binary_name);
        if candidate.exists() {
            return true;
        }
    }
    false
}

fn read_env_key(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn credentials_with(
    anthropic_cred: Option<ProviderCredentials>,
    openai_cred: Option<ProviderCredentials>,
) -> ExtractedCredentials {
    let mut credentials = ExtractedCredentials::default();
    credentials.anthropic = anthropic_cred;
    credentials.openai = openai_cred;
    credentials
}
