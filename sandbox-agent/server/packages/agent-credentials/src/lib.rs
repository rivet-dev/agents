use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCredentials {
    pub api_key: String,
    pub source: String,
    pub auth_type: AuthType,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    ApiKey,
    Oauth,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractedCredentials {
    pub anthropic: Option<ProviderCredentials>,
    pub openai: Option<ProviderCredentials>,
    pub other: HashMap<String, ProviderCredentials>,
}

#[derive(Debug, Clone, Default)]
pub struct CredentialExtractionOptions {
    pub home_dir: Option<PathBuf>,
    pub include_oauth: bool,
}

impl CredentialExtractionOptions {
    pub fn new() -> Self {
        Self {
            home_dir: None,
            include_oauth: true,
        }
    }
}

pub fn extract_claude_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;

    let config_paths = [
        home_dir.join(".claude.json.api"),
        home_dir.join(".claude.json"),
        home_dir.join(".claude.json.nathan"),
    ];

    let key_paths = [
        vec!["primaryApiKey"],
        vec!["apiKey"],
        vec!["anthropicApiKey"],
        vec!["customApiKey"],
    ];

    for path in config_paths {
        let Some(data) = read_json_file(&path) else {
            continue;
        };
        for key_path in &key_paths {
            if let Some(key) = read_string_field(&data, key_path) {
                if key.starts_with("sk-ant-") {
                    return Some(ProviderCredentials {
                        api_key: key,
                        source: "claude-code".to_string(),
                        auth_type: AuthType::ApiKey,
                        provider: "anthropic".to_string(),
                    });
                }
            }
        }
    }

    if include_oauth {
        let oauth_paths = [
            home_dir.join(".claude").join(".credentials.json"),
            home_dir.join(".claude-oauth-credentials.json"),
        ];
        for path in oauth_paths {
            let data = match read_json_file(&path) {
                Some(value) => value,
                None => continue,
            };
            let access = read_string_field(&data, &["claudeAiOauth", "accessToken"]);
            if let Some(token) = access {
                if let Some(expires_at) = read_string_field(&data, &["claudeAiOauth", "expiresAt"])
                {
                    if is_expired_rfc3339(&expires_at) {
                        continue;
                    }
                }
                return Some(ProviderCredentials {
                    api_key: token,
                    source: "claude-code".to_string(),
                    auth_type: AuthType::Oauth,
                    provider: "anthropic".to_string(),
                });
            }
        }
    }

    None
}

pub fn extract_codex_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;
    let path = home_dir.join(".codex").join("auth.json");
    let data = read_json_file(&path)?;

    if let Some(key) = data.get("OPENAI_API_KEY").and_then(Value::as_str) {
        if !key.is_empty() {
            return Some(ProviderCredentials {
                api_key: key.to_string(),
                source: "codex".to_string(),
                auth_type: AuthType::ApiKey,
                provider: "openai".to_string(),
            });
        }
    }

    if include_oauth {
        if let Some(token) = read_string_field(&data, &["tokens", "access_token"]) {
            return Some(ProviderCredentials {
                api_key: token,
                source: "codex".to_string(),
                auth_type: AuthType::Oauth,
                provider: "openai".to_string(),
            });
        }
    }

    None
}

pub fn extract_opencode_credentials(options: &CredentialExtractionOptions) -> ExtractedCredentials {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;
    let path = home_dir
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json");

    let mut result = ExtractedCredentials::default();
    let data = match read_json_file(&path) {
        Some(value) => value,
        None => return result,
    };

    let obj = match data.as_object() {
        Some(obj) => obj,
        None => return result,
    };

    for (provider_name, value) in obj {
        let config = match value.as_object() {
            Some(config) => config,
            None => continue,
        };

        let auth_type = config.get("type").and_then(Value::as_str).unwrap_or("");

        let credentials = if auth_type == "api" {
            config
                .get("key")
                .and_then(Value::as_str)
                .map(|key| ProviderCredentials {
                    api_key: key.to_string(),
                    source: "opencode".to_string(),
                    auth_type: AuthType::ApiKey,
                    provider: provider_name.to_string(),
                })
        } else if auth_type == "oauth" && include_oauth {
            let expires = config.get("expires").and_then(Value::as_i64);
            if let Some(expires) = expires {
                if expires < current_epoch_millis() {
                    None
                } else {
                    config
                        .get("access")
                        .and_then(Value::as_str)
                        .map(|token| ProviderCredentials {
                            api_key: token.to_string(),
                            source: "opencode".to_string(),
                            auth_type: AuthType::Oauth,
                            provider: provider_name.to_string(),
                        })
                }
            } else {
                config
                    .get("access")
                    .and_then(Value::as_str)
                    .map(|token| ProviderCredentials {
                        api_key: token.to_string(),
                        source: "opencode".to_string(),
                        auth_type: AuthType::Oauth,
                        provider: provider_name.to_string(),
                    })
            }
        } else {
            None
        };

        if let Some(credentials) = credentials {
            if provider_name == "anthropic" {
                result.anthropic = Some(credentials.clone());
            } else if provider_name == "openai" {
                result.openai = Some(credentials.clone());
            } else {
                result
                    .other
                    .insert(provider_name.to_string(), credentials.clone());
            }
        }
    }

    result
}

pub fn extract_amp_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let path = home_dir.join(".amp").join("config.json");
    let data = read_json_file(&path)?;

    let key_paths: Vec<Vec<&str>> = vec![
        vec!["anthropicApiKey"],
        vec!["anthropic_api_key"],
        vec!["apiKey"],
        vec!["api_key"],
        vec!["accessToken"],
        vec!["access_token"],
        vec!["token"],
        vec!["auth", "anthropicApiKey"],
        vec!["auth", "apiKey"],
        vec!["auth", "token"],
        vec!["anthropic", "apiKey"],
        vec!["anthropic", "token"],
    ];

    for key_path in key_paths {
        if let Some(key) = read_string_field(&data, &key_path) {
            if !key.is_empty() {
                return Some(ProviderCredentials {
                    api_key: key,
                    source: "amp".to_string(),
                    auth_type: AuthType::ApiKey,
                    provider: "anthropic".to_string(),
                });
            }
        }
    }

    None
}

pub fn extract_all_credentials(options: &CredentialExtractionOptions) -> ExtractedCredentials {
    let mut result = ExtractedCredentials::default();

    if let Ok(value) = std::env::var("ANTHROPIC_API_KEY") {
        result.anthropic = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "anthropic".to_string(),
        });
    } else if let Ok(value) = std::env::var("CLAUDE_API_KEY") {
        result.anthropic = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "anthropic".to_string(),
        });
    } else if options.include_oauth {
        if let Ok(value) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
            result.anthropic = Some(ProviderCredentials {
                api_key: value,
                source: "environment".to_string(),
                auth_type: AuthType::Oauth,
                provider: "anthropic".to_string(),
            });
        } else if let Ok(value) = std::env::var("ANTHROPIC_AUTH_TOKEN") {
            result.anthropic = Some(ProviderCredentials {
                api_key: value,
                source: "environment".to_string(),
                auth_type: AuthType::Oauth,
                provider: "anthropic".to_string(),
            });
        }
    }

    if let Ok(value) = std::env::var("OPENAI_API_KEY") {
        result.openai = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "openai".to_string(),
        });
    } else if let Ok(value) = std::env::var("CODEX_API_KEY") {
        result.openai = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "openai".to_string(),
        });
    }

    if result.anthropic.is_none() {
        result.anthropic = extract_amp_credentials(options);
    }

    if result.anthropic.is_none() {
        result.anthropic = extract_claude_credentials(options);
    }

    if result.openai.is_none() {
        result.openai = extract_codex_credentials(options);
    }

    let opencode_credentials = extract_opencode_credentials(options);
    if result.anthropic.is_none() {
        result.anthropic = opencode_credentials.anthropic.clone();
    }
    if result.openai.is_none() {
        result.openai = opencode_credentials.openai.clone();
    }

    for (key, value) in opencode_credentials.other {
        result.other.entry(key).or_insert(value);
    }

    result
}

pub fn get_anthropic_api_key(options: &CredentialExtractionOptions) -> Option<String> {
    extract_all_credentials(options)
        .anthropic
        .map(|cred| cred.api_key)
}

pub fn get_openai_api_key(options: &CredentialExtractionOptions) -> Option<String> {
    extract_all_credentials(options)
        .openai
        .map(|cred| cred.api_key)
}

pub fn set_credentials_as_env_vars(credentials: &ExtractedCredentials) {
    if let Some(cred) = &credentials.anthropic {
        std::env::set_var("ANTHROPIC_API_KEY", &cred.api_key);
    }
    if let Some(cred) = &credentials.openai {
        std::env::set_var("OPENAI_API_KEY", &cred.api_key);
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn read_string_field(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|s| s.to_string())
}

fn default_home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn current_epoch_millis() -> i64 {
    let now = OffsetDateTime::now_utc();
    (now.unix_timestamp() * 1000) + (now.millisecond() as i64)
}

fn is_expired_rfc3339(value: &str) -> bool {
    match OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339) {
        Ok(expiry) => expiry < OffsetDateTime::now_utc(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const ANTHROPIC_ENV_KEYS: [&str; 5] = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_API_KEY",
    ];

    fn with_env(mutations: &[(&str, Option<&str>)], test_fn: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");

        let mut snapshot: HashMap<String, Option<String>> = HashMap::new();
        for key in ANTHROPIC_ENV_KEYS {
            snapshot.insert(key.to_string(), std::env::var(key).ok());
        }

        for (key, value) in mutations {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }

        test_fn();

        for (key, value) in snapshot {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    fn empty_home_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("sandbox-agent-agent-credentials-test-{nanos}"));
        fs::create_dir_all(&path).expect("failed to create temp home dir");
        path
    }

    #[test]
    fn extract_all_credentials_reads_claude_code_oauth_env() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", None),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: true,
                };
                let creds = extract_all_credentials(&options);
                let anthropic = creds
                    .anthropic
                    .expect("expected anthropic credentials from oauth env");

                assert_eq!(anthropic.api_key, "oauth-token-123");
                assert_eq!(anthropic.source, "environment");
                assert_eq!(anthropic.auth_type, AuthType::Oauth);
                assert_eq!(anthropic.provider, "anthropic");
            },
        );
    }

    #[test]
    fn extract_all_credentials_ignores_oauth_env_when_disabled() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", None),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: false,
                };
                let creds = extract_all_credentials(&options);
                assert!(
                    creds.anthropic.is_none(),
                    "oauth env should be ignored when include_oauth is false"
                );
            },
        );
    }

    #[test]
    fn extract_all_credentials_prefers_api_key_over_oauth_env() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", Some("sk-ant-priority")),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", Some("oauth-token-456")),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: true,
                };
                let creds = extract_all_credentials(&options);
                let anthropic = creds
                    .anthropic
                    .expect("expected anthropic credentials from api key env");

                assert_eq!(anthropic.api_key, "sk-ant-priority");
                assert_eq!(anthropic.auth_type, AuthType::ApiKey);
            },
        );
    }
}
