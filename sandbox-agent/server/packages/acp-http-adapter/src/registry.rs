use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("invalid registry json: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("unable to resolve registry entry from blob")]
    UnsupportedBlob,
    #[error("registry blob has agents[] but no --registry-agent-id was provided")]
    MissingAgentId,
    #[error("agent '{0}' was not found in registry blob")]
    AgentNotFound(String),
    #[error("registry entry has no supported launch target")]
    MissingLaunchTarget,
    #[error("platform '{0}' is not present in distribution.binary")]
    UnsupportedPlatform(String),
}

impl LaunchSpec {
    pub fn from_registry_blob(blob: &str, agent_id: Option<&str>) -> Result<Self, RegistryError> {
        let value: Value = serde_json::from_str(blob)?;
        Self::from_registry_value(value, agent_id)
    }

    fn from_registry_value(value: Value, agent_id: Option<&str>) -> Result<Self, RegistryError> {
        if value.get("agents").is_some() {
            let doc: RegistryDocument = serde_json::from_value(value)?;
            let wanted = agent_id.ok_or(RegistryError::MissingAgentId)?;
            let agent = doc
                .agents
                .into_iter()
                .find(|a| a.id == wanted)
                .ok_or_else(|| RegistryError::AgentNotFound(wanted.to_string()))?;
            return Self::from_distribution(agent.distribution);
        }

        if value.get("distribution").is_some() {
            let entry: RegistryAgent = serde_json::from_value(value)?;
            return Self::from_distribution(entry.distribution);
        }

        if value.get("npx").is_some() || value.get("binary").is_some() {
            let distribution: RegistryDistribution = serde_json::from_value(value)?;
            return Self::from_distribution(distribution);
        }

        Err(RegistryError::UnsupportedBlob)
    }

    fn from_distribution(distribution: RegistryDistribution) -> Result<Self, RegistryError> {
        if let Some(npx) = distribution.npx {
            let mut args = vec!["-y".to_string(), npx.package];
            args.extend(npx.args);
            return Ok(Self {
                program: PathBuf::from("npx"),
                args,
                env: npx.env,
            });
        }

        if let Some(binary) = distribution.binary {
            let platform = platform_key().ok_or(RegistryError::UnsupportedPlatform(format!(
                "{}/{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )))?;
            let target = binary
                .get(platform)
                .ok_or_else(|| RegistryError::UnsupportedPlatform(platform.to_string()))?;
            return Ok(Self {
                program: PathBuf::from(&target.cmd),
                args: target.args.clone(),
                env: target.env.clone(),
            });
        }

        Err(RegistryError::MissingLaunchTarget)
    }
}

fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("linux", "aarch64") => Some("linux-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("windows", "aarch64") => Some("windows-aarch64"),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct RegistryDocument {
    agents: Vec<RegistryAgent>,
}

#[derive(Debug, Deserialize)]
struct RegistryAgent {
    #[allow(dead_code)]
    id: String,
    distribution: RegistryDistribution,
}

#[derive(Debug, Deserialize)]
struct RegistryDistribution {
    #[serde(default)]
    npx: Option<RegistryNpx>,
    #[serde(default)]
    binary: Option<HashMap<String, RegistryBinaryTarget>>,
}

#[derive(Debug, Deserialize)]
struct RegistryNpx {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct RegistryBinaryTarget {
    #[allow(dead_code)]
    archive: Option<String>,
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}
