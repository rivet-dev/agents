use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use flate2::read::GzDecoder;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

const DEFAULT_ACP_REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const ADAPTERS_JSON: &str = include_str!("../../../../scripts/audit-acp-deps/adapters.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    Claude,
    Codex,
    Opencode,
    Amp,
    Pi,
    Cursor,
    Mock,
}

impl AgentId {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
            AgentId::Opencode => "opencode",
            AgentId::Amp => "amp",
            AgentId::Pi => "pi",
            AgentId::Cursor => "cursor",
            AgentId::Mock => "mock",
        }
    }

    pub fn binary_name(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
            AgentId::Opencode => "opencode",
            AgentId::Amp => "amp",
            AgentId::Pi => "pi",
            AgentId::Cursor => "cursor-agent",
            AgentId::Mock => "mock",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(AgentId::Claude),
            "codex" => Some(AgentId::Codex),
            "opencode" => Some(AgentId::Opencode),
            "amp" => Some(AgentId::Amp),
            "pi" => Some(AgentId::Pi),
            "cursor" => Some(AgentId::Cursor),
            "mock" => Some(AgentId::Mock),
            _ => None,
        }
    }

    pub fn all() -> &'static [AgentId] {
        &[
            AgentId::Claude,
            AgentId::Codex,
            AgentId::Opencode,
            AgentId::Amp,
            AgentId::Pi,
            AgentId::Cursor,
            AgentId::Mock,
        ]
    }

    fn agent_process_registry_id(self) -> Option<&'static str> {
        match self {
            AgentId::Claude => Some("claude-acp"),
            AgentId::Codex => Some("codex-acp"),
            AgentId::Opencode => Some("opencode"),
            AgentId::Amp => Some("amp-acp"),
            AgentId::Pi => Some("pi-acp"),
            AgentId::Cursor => Some("cursor-agent-acp"),
            AgentId::Mock => None,
        }
    }

    fn agent_process_binary_hint(self) -> Option<&'static str> {
        match self {
            AgentId::Claude => Some("claude-agent-acp"),
            AgentId::Codex => Some("codex-acp"),
            AgentId::Opencode => Some("opencode"),
            AgentId::Amp => Some("amp-acp"),
            AgentId::Pi => Some("pi-acp"),
            AgentId::Cursor => Some("cursor-agent-acp"),
            AgentId::Mock => None,
        }
    }

    fn native_required(self) -> bool {
        matches!(self, AgentId::Claude | AgentId::Codex | AgentId::Opencode)
    }

    fn unstable_enabled(self) -> bool {
        // v1 profile includes unstable methods; support still depends on agent process capability.
        !matches!(self, AgentId::Amp)
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    LinuxX64,
    LinuxX64Musl,
    LinuxArm64,
    MacosArm64,
    MacosX64,
    WindowsX64,
    WindowsArm64,
}

impl Platform {
    pub fn detect() -> Result<Self, AgentError> {
        let os = std::env::consts::OS;
        let arch = std::env::consts::ARCH;
        let is_musl = Self::detect_musl_runtime();

        match (os, arch, is_musl) {
            ("linux", "x86_64", true) => Ok(Self::LinuxX64Musl),
            ("linux", "x86_64", false) => Ok(Self::LinuxX64),
            ("linux", "aarch64", _) => Ok(Self::LinuxArm64),
            ("macos", "aarch64", _) => Ok(Self::MacosArm64),
            ("macos", "x86_64", _) => Ok(Self::MacosX64),
            ("windows", "x86_64", _) => Ok(Self::WindowsX64),
            ("windows", "aarch64", _) => Ok(Self::WindowsArm64),
            _ => Err(AgentError::UnsupportedPlatform {
                os: os.to_string(),
                arch: arch.to_string(),
            }),
        }
    }

    #[cfg(target_os = "linux")]
    fn detect_musl_runtime() -> bool {
        Path::new("/lib/ld-musl-x86_64.so.1").exists()
            || Path::new("/lib/ld-musl-aarch64.so.1").exists()
    }

    #[cfg(not(target_os = "linux"))]
    fn detect_musl_runtime() -> bool {
        false
    }

    fn registry_key(self) -> &'static str {
        match self {
            Platform::LinuxX64 | Platform::LinuxX64Musl => "linux-x86_64",
            Platform::LinuxArm64 => "linux-aarch64",
            Platform::MacosArm64 => "darwin-aarch64",
            Platform::MacosX64 => "darwin-x86_64",
            Platform::WindowsX64 => "windows-x86_64",
            Platform::WindowsArm64 => "windows-aarch64",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallSource {
    Registry,
    Fallback,
    LocalPath,
    Builtin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstalledArtifactKind {
    NativeAgent,
    AgentProcess,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledArtifact {
    pub kind: InstalledArtifactKind,
    pub path: PathBuf,
    pub version: Option<String>,
    pub source: InstallSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallResult {
    pub artifacts: Vec<InstalledArtifact>,
    pub already_installed: bool,
}

#[derive(Debug, Clone)]
pub struct InstallOptions {
    pub reinstall: bool,
    pub version: Option<String>,
    pub agent_process_version: Option<String>,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            reinstall: false,
            version: None,
            agent_process_version: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInstallStatus {
    pub agent: AgentId,
    pub native_required: bool,
    pub native_installed: bool,
    pub native_version: Option<String>,
    pub agent_process_installed: bool,
    pub agent_process_source: Option<InstallSource>,
    pub agent_process_version: Option<String>,
    pub unstable_enabled: bool,
}

#[derive(Debug, Clone)]
pub struct AgentProcessLaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub source: InstallSource,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentManager {
    install_dir: PathBuf,
    platform: Platform,
    registry_url: Url,
}

impl AgentManager {
    pub fn new(install_dir: impl Into<PathBuf>) -> Result<Self, AgentError> {
        Ok(Self {
            install_dir: install_dir.into(),
            platform: Platform::detect()?,
            registry_url: registry_url_from_env()?,
        })
    }

    pub fn with_platform(install_dir: impl Into<PathBuf>, platform: Platform) -> Self {
        let registry_url = registry_url_from_env().unwrap_or_else(|_| {
            Url::parse(DEFAULT_ACP_REGISTRY_URL).expect("hardcoded valid ACP registry URL")
        });
        Self {
            install_dir: install_dir.into(),
            platform,
            registry_url,
        }
    }

    pub fn install_dir(&self) -> &Path {
        &self.install_dir
    }

    pub fn binary_path(&self, agent: AgentId) -> PathBuf {
        self.install_dir.join(agent.binary_name())
    }

    pub fn agent_process_path(&self, agent: AgentId) -> PathBuf {
        let base = self.install_dir.join("agent_processes");
        if cfg!(windows) {
            base.join(format!("{}-acp.cmd", agent.as_str()))
        } else {
            base.join(format!("{}-acp", agent.as_str()))
        }
    }

    pub fn agent_process_storage_dir(&self, agent: AgentId) -> PathBuf {
        self.install_dir
            .join("agent_processes")
            .join(agent.as_str())
    }

    pub fn list_status(&self) -> Vec<AgentInstallStatus> {
        AgentId::all()
            .iter()
            .copied()
            .map(|agent| {
                let native_required = agent.native_required();
                let native_installed = !native_required || self.native_installed(agent);
                let native_version = if native_installed && native_required {
                    self.version(agent).ok().flatten()
                } else {
                    None
                };
                let agent_process = self.agent_process_status(agent);
                AgentInstallStatus {
                    agent,
                    native_required,
                    native_installed,
                    native_version,
                    agent_process_installed: agent_process.is_some(),
                    agent_process_source: agent_process.as_ref().map(|a| a.source),
                    agent_process_version: agent_process.and_then(|a| a.version),
                    unstable_enabled: agent.unstable_enabled(),
                }
            })
            .collect()
    }

    pub fn install(
        &self,
        agent: AgentId,
        options: InstallOptions,
    ) -> Result<InstallResult, AgentError> {
        let install_started = Instant::now();
        tracing::info!(
            agent = agent.as_str(),
            reinstall = options.reinstall,
            native_version = ?options.version,
            agent_process_version = ?options.agent_process_version,
            "agent_manager.install: starting"
        );
        fs::create_dir_all(&self.install_dir)?;
        fs::create_dir_all(self.install_dir.join("agent_processes"))?;

        let mut artifacts = Vec::new();
        let mut already_installed = true;

        if agent.native_required() {
            let native_artifact = self.install_native(agent, &options)?;
            if native_artifact.is_some() {
                already_installed = false;
            }
            if let Some(artifact) = native_artifact {
                artifacts.push(artifact);
            }
        }

        let agent_process_artifact = self.install_agent_process(agent, &options)?;
        if agent_process_artifact.is_some() {
            already_installed = false;
        }
        if let Some(artifact) = agent_process_artifact {
            artifacts.push(artifact);
        }

        let result = InstallResult {
            artifacts,
            already_installed,
        };

        tracing::info!(
            agent = agent.as_str(),
            already_installed = result.already_installed,
            artifact_count = result.artifacts.len(),
            total_ms = elapsed_ms(install_started),
            "agent_manager.install: completed"
        );

        Ok(result)
    }

    pub fn is_installed(&self, agent: AgentId) -> bool {
        let native_ok = !agent.native_required() || self.native_installed(agent);
        native_ok && self.agent_process_status(agent).is_some()
    }

    pub fn version(&self, agent: AgentId) -> Result<Option<String>, AgentError> {
        if agent == AgentId::Mock {
            return Ok(Some("builtin".to_string()));
        }
        let path = self.resolve_binary(agent)?;
        for args in [["--version"], ["version"], ["-V"]] {
            let output = Command::new(&path).args(args).output();
            if let Ok(output) = output {
                if output.status.success() {
                    if let Some(version) = parse_version_output(&output) {
                        return Ok(Some(version));
                    }
                }
            }
        }
        Ok(None)
    }

    pub fn resolve_binary(&self, agent: AgentId) -> Result<PathBuf, AgentError> {
        if agent == AgentId::Mock {
            return Ok(self.binary_path(agent));
        }
        let path = self.binary_path(agent);
        if path.exists() {
            return Ok(path);
        }
        if let Some(path) = find_in_path(agent.binary_name()) {
            return Ok(path);
        }
        Err(AgentError::BinaryNotFound { agent })
    }

    pub fn resolve_agent_process(
        &self,
        agent: AgentId,
    ) -> Result<AgentProcessLaunchSpec, AgentError> {
        let started = Instant::now();
        if agent == AgentId::Mock {
            let spec = AgentProcessLaunchSpec {
                program: self.agent_process_path(agent),
                args: Vec::new(),
                env: HashMap::new(),
                source: InstallSource::Builtin,
                version: Some("builtin".to_string()),
            };
            tracing::info!(
                agent = agent.as_str(),
                source = ?spec.source,
                total_ms = elapsed_ms(started),
                "agent_manager.resolve_agent_process: resolved builtin"
            );
            return Ok(spec);
        }

        let launcher = self.agent_process_path(agent);
        if launcher.exists() {
            let spec = AgentProcessLaunchSpec {
                program: launcher,
                args: Vec::new(),
                env: HashMap::new(),
                source: InstallSource::LocalPath,
                version: None,
            };
            tracing::info!(
                agent = agent.as_str(),
                source = ?spec.source,
                program = %spec.program.display(),
                total_ms = elapsed_ms(started),
                "agent_manager.resolve_agent_process: resolved local launcher"
            );
            return Ok(spec);
        }

        if let Some(bin) = agent.agent_process_binary_hint().and_then(find_in_path) {
            let args = if agent == AgentId::Opencode {
                vec!["acp".to_string()]
            } else {
                Vec::new()
            };
            let spec = AgentProcessLaunchSpec {
                program: bin,
                args,
                env: HashMap::new(),
                source: InstallSource::LocalPath,
                version: None,
            };
            tracing::info!(
                agent = agent.as_str(),
                source = ?spec.source,
                program = %spec.program.display(),
                args = ?spec.args,
                total_ms = elapsed_ms(started),
                "agent_manager.resolve_agent_process: resolved PATH binary hint"
            );
            return Ok(spec);
        }

        if agent == AgentId::Opencode {
            let native = self.resolve_binary(agent)?;
            let spec = AgentProcessLaunchSpec {
                program: native,
                args: vec!["acp".to_string()],
                env: HashMap::new(),
                source: InstallSource::LocalPath,
                version: None,
            };
            tracing::info!(
                agent = agent.as_str(),
                source = ?spec.source,
                program = %spec.program.display(),
                args = ?spec.args,
                total_ms = elapsed_ms(started),
                "agent_manager.resolve_agent_process: resolved opencode native"
            );
            return Ok(spec);
        }

        Err(AgentError::AgentProcessNotFound {
            agent,
            hint: Some(format!("run step 3: `sandbox-agent install-agent {agent}`")),
        })
    }

    fn native_installed(&self, agent: AgentId) -> bool {
        self.binary_path(agent).exists() || find_in_path(agent.binary_name()).is_some()
    }

    fn install_native(
        &self,
        agent: AgentId,
        options: &InstallOptions,
    ) -> Result<Option<InstalledArtifact>, AgentError> {
        let started = Instant::now();
        if !options.reinstall && self.native_installed(agent) {
            tracing::info!(
                agent = agent.as_str(),
                total_ms = elapsed_ms(started),
                "agent_manager.install_native: already installed"
            );
            return Ok(None);
        }

        let path = self.binary_path(agent);
        tracing::info!(
            agent = agent.as_str(),
            path = %path.display(),
            version_override = ?options.version,
            "agent_manager.install_native: installing"
        );
        match agent {
            AgentId::Claude => install_claude(&path, self.platform, options.version.as_deref())?,
            AgentId::Codex => install_codex(&path, self.platform, options.version.as_deref())?,
            AgentId::Opencode => {
                install_opencode(&path, self.platform, options.version.as_deref())?
            }
            AgentId::Amp => install_amp(&path, self.platform, options.version.as_deref())?,
            AgentId::Pi | AgentId::Cursor => {
                return Ok(None);
            }
            AgentId::Mock => {
                write_text_file(&path, "#!/usr/bin/env sh\nexit 0\n")?;
            }
        }

        let artifact = InstalledArtifact {
            kind: InstalledArtifactKind::NativeAgent,
            path,
            version: self.version(agent).ok().flatten(),
            source: InstallSource::Fallback,
        };

        tracing::info!(
            agent = agent.as_str(),
            source = ?artifact.source,
            version = ?artifact.version,
            total_ms = elapsed_ms(started),
            "agent_manager.install_native: completed"
        );

        Ok(Some(artifact))
    }

    fn install_agent_process(
        &self,
        agent: AgentId,
        options: &InstallOptions,
    ) -> Result<Option<InstalledArtifact>, AgentError> {
        let started = Instant::now();
        if !options.reinstall {
            if self.agent_process_status(agent).is_some() {
                tracing::info!(
                    agent = agent.as_str(),
                    total_ms = elapsed_ms(started),
                    "agent_manager.install_agent_process: already installed"
                );
                return Ok(None);
            }
        }

        if agent == AgentId::Mock {
            let path = self.agent_process_path(agent);
            write_mock_agent_process_launcher(&path)?;
            let artifact = InstalledArtifact {
                kind: InstalledArtifactKind::AgentProcess,
                path,
                version: Some("builtin".to_string()),
                source: InstallSource::Builtin,
            };
            tracing::info!(
                agent = agent.as_str(),
                source = ?artifact.source,
                total_ms = elapsed_ms(started),
                "agent_manager.install_agent_process: installed builtin launcher"
            );
            return Ok(Some(artifact));
        }

        if let Some(artifact) = self.install_agent_process_from_registry(agent, options)? {
            tracing::info!(
                agent = agent.as_str(),
                source = ?artifact.source,
                version = ?artifact.version,
                total_ms = elapsed_ms(started),
                "agent_manager.install_agent_process: installed from registry"
            );
            return Ok(Some(artifact));
        }

        let artifact = self.install_agent_process_fallback(agent, options)?;
        tracing::info!(
            agent = agent.as_str(),
            source = ?artifact.source,
            version = ?artifact.version,
            total_ms = elapsed_ms(started),
            "agent_manager.install_agent_process: installed from fallback"
        );
        Ok(Some(artifact))
    }

    fn install_npm_agent_process_package(
        &self,
        agent: AgentId,
        package: &str,
        args: &[String],
        env: &HashMap<String, String>,
        source: InstallSource,
        version: Option<String>,
    ) -> Result<InstalledArtifact, AgentError> {
        let started = Instant::now();
        let root = self.agent_process_storage_dir(agent);
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(&root)?;

        let npm_install_started = Instant::now();
        install_npm_package(&root, package, agent)?;
        let npm_install_ms = elapsed_ms(npm_install_started);

        let bin_name = agent.agent_process_binary_hint().ok_or_else(|| {
            AgentError::ExtractFailed(format!(
                "missing executable hint for agent process package: {agent}"
            ))
        })?;

        let cmd_path = npm_bin_path(&root, bin_name);
        if !cmd_path.exists() {
            return Err(AgentError::ExtractFailed(format!(
                "installed package missing executable: {}",
                cmd_path.display()
            )));
        }

        let launcher = self.agent_process_path(agent);
        let write_started = Instant::now();
        write_exec_agent_process_launcher(&launcher, &cmd_path, args, env)?;
        let write_ms = elapsed_ms(write_started);
        let verify_started = Instant::now();
        verify_command(&launcher, &[])?;
        let verify_ms = elapsed_ms(verify_started);

        tracing::info!(
            agent = agent.as_str(),
            package = %package,
            cmd = %cmd_path.display(),
            npm_install_ms = npm_install_ms,
            write_ms = write_ms,
            verify_ms = verify_ms,
            total_ms = elapsed_ms(started),
            "agent_manager.install_npm_agent_process_package: completed"
        );

        Ok(InstalledArtifact {
            kind: InstalledArtifactKind::AgentProcess,
            path: launcher,
            version,
            source,
        })
    }

    fn agent_process_status(&self, agent: AgentId) -> Option<AgentProcessStatus> {
        let launcher = self.agent_process_path(agent);

        if agent == AgentId::Mock {
            if launcher.exists() {
                return Some(AgentProcessStatus {
                    source: InstallSource::Builtin,
                    version: Some("builtin".to_string()),
                });
            }
            return None;
        }
        if launcher.exists() {
            return Some(AgentProcessStatus {
                source: InstallSource::LocalPath,
                version: None,
            });
        }

        agent.agent_process_binary_hint().and_then(find_in_path)?;
        Some(AgentProcessStatus {
            source: InstallSource::LocalPath,
            version: None,
        })
    }

    fn install_agent_process_from_registry(
        &self,
        agent: AgentId,
        options: &InstallOptions,
    ) -> Result<Option<InstalledArtifact>, AgentError> {
        let started = Instant::now();
        let Some(registry_id) = agent.agent_process_registry_id() else {
            return Ok(None);
        };

        tracing::info!(
            agent = agent.as_str(),
            registry_id = registry_id,
            url = %self.registry_url,
            "agent_manager.install_agent_process_from_registry: fetching registry"
        );
        let fetch_started = Instant::now();
        let registry = fetch_registry(&self.registry_url)?;
        tracing::info!(
            agent = agent.as_str(),
            registry_id = registry_id,
            fetch_ms = elapsed_ms(fetch_started),
            "agent_manager.install_agent_process_from_registry: registry fetched"
        );
        let Some(entry) = registry.agents.into_iter().find(|a| a.id == registry_id) else {
            tracing::info!(
                agent = agent.as_str(),
                registry_id = registry_id,
                total_ms = elapsed_ms(started),
                "agent_manager.install_agent_process_from_registry: missing entry"
            );
            return Ok(None);
        };

        if let Some(npx) = entry.distribution.npx {
            let package =
                apply_npx_version_override(&npx.package, options.agent_process_version.as_deref());
            let version = options
                .agent_process_version
                .clone()
                .or(entry.version)
                .or(extract_npx_version(&package));
            let artifact = self.install_npm_agent_process_package(
                agent,
                &package,
                &npx.args,
                &npx.env,
                InstallSource::Registry,
                version,
            )?;
            tracing::info!(
                agent = agent.as_str(),
                package = %package,
                total_ms = elapsed_ms(started),
                "agent_manager.install_agent_process_from_registry: npm package installed"
            );
            return Ok(Some(artifact));
        }

        if let Some(binary) = entry.distribution.binary {
            let key = self.platform.registry_key();
            if let Some(target) = binary.get(key) {
                let archive_url = Url::parse(&target.archive)?;
                let download_started = Instant::now();
                let payload = download_bytes(&archive_url)?;
                let download_ms = elapsed_ms(download_started);
                let root = self.agent_process_storage_dir(agent);
                if root.exists() {
                    fs::remove_dir_all(&root)?;
                }
                fs::create_dir_all(&root)?;
                let unpack_started = Instant::now();
                unpack_archive(&payload, &archive_url, &root)?;
                let unpack_ms = elapsed_ms(unpack_started);

                let cmd_path = resolve_extracted_command(&root, &target.cmd)?;
                let launcher = self.agent_process_path(agent);
                let write_started = Instant::now();
                write_exec_agent_process_launcher(&launcher, &cmd_path, &target.args, &target.env)?;
                let write_ms = elapsed_ms(write_started);
                let verify_started = Instant::now();
                verify_command(&launcher, &[])?;
                let verify_ms = elapsed_ms(verify_started);

                let artifact = InstalledArtifact {
                    kind: InstalledArtifactKind::AgentProcess,
                    path: launcher,
                    version: options.agent_process_version.clone().or(entry.version),
                    source: InstallSource::Registry,
                };
                tracing::info!(
                    agent = agent.as_str(),
                    archive_url = %archive_url,
                    download_ms = download_ms,
                    unpack_ms = unpack_ms,
                    write_ms = write_ms,
                    verify_ms = verify_ms,
                    total_ms = elapsed_ms(started),
                    "agent_manager.install_agent_process_from_registry: binary launcher installed"
                );
                return Ok(Some(artifact));
            }
        }

        tracing::info!(
            agent = agent.as_str(),
            registry_id = registry_id,
            total_ms = elapsed_ms(started),
            "agent_manager.install_agent_process_from_registry: no compatible distribution"
        );
        Ok(None)
    }

    fn install_agent_process_fallback(
        &self,
        agent: AgentId,
        options: &InstallOptions,
    ) -> Result<InstalledArtifact, AgentError> {
        let started = Instant::now();
        let artifact = match agent {
            AgentId::Opencode => {
                let launcher = self.agent_process_path(agent);
                let native = self.resolve_binary(agent)?;
                write_exec_agent_process_launcher(
                    &launcher,
                    &native,
                    &["acp".to_string()],
                    &HashMap::new(),
                )?;
                verify_command(&launcher, &[])?;
                InstalledArtifact {
                    kind: InstalledArtifactKind::AgentProcess,
                    path: launcher,
                    version: options.agent_process_version.clone(),
                    source: InstallSource::Fallback,
                }
            }
            AgentId::Mock => {
                let launcher = self.agent_process_path(agent);
                write_mock_agent_process_launcher(&launcher)?;
                InstalledArtifact {
                    kind: InstalledArtifactKind::AgentProcess,
                    path: launcher,
                    version: options.agent_process_version.clone(),
                    source: InstallSource::Fallback,
                }
            }
            _ => {
                let (npm_package, pinned_version) =
                    adapter_entry(agent.as_str()).ok_or_else(|| {
                        AgentError::ExtractFailed(format!(
                            "no adapter entry in adapters.json for agent: {agent}"
                        ))
                    })?;
                let version = options
                    .agent_process_version
                    .as_deref()
                    .or(Some(pinned_version));
                let package = fallback_npx_package(npm_package, version);
                self.install_npm_agent_process_package(
                    agent,
                    &package,
                    &[],
                    &HashMap::new(),
                    InstallSource::Fallback,
                    options
                        .agent_process_version
                        .clone()
                        .or(extract_npx_version(&package)),
                )?
            }
        };

        tracing::info!(
            agent = agent.as_str(),
            source = ?artifact.source,
            version = ?artifact.version,
            total_ms = elapsed_ms(started),
            "agent_manager.install_agent_process_fallback: launcher installed"
        );

        Ok(artifact)
    }
}

#[derive(Debug, Clone)]
struct AgentProcessStatus {
    source: InstallSource,
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RegistryDocument {
    agents: Vec<RegistryAgent>,
}

#[derive(Debug, Deserialize)]
struct RegistryAgent {
    id: String,
    version: Option<String>,
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
    archive: String,
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("unsupported platform {os}/{arch}")]
    UnsupportedPlatform { os: String, arch: String },
    #[error("unsupported agent {agent}")]
    UnsupportedAgent { agent: String },
    #[error("binary not found for {agent}")]
    BinaryNotFound { agent: AgentId },
    #[error("agent process not found for {agent}")]
    AgentProcessNotFound {
        agent: AgentId,
        hint: Option<String>,
    },
    #[error("download failed: {url}")]
    DownloadFailed { url: Url },
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("url parse error: {0}")]
    UrlParse(#[from] url::ParseError),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("extract failed: {0}")]
    ExtractFailed(String),
    #[error("registry parse failed: {0}")]
    RegistryParse(String),
    #[error("command verification failed: {0}")]
    VerifyFailed(String),
    #[error(
        "npm is required to install {agent}. install npm, then run step 3: `sandbox-agent install-agent {agent}`"
    )]
    MissingNpm { agent: AgentId },
}

/// Looks up the pinned adapter entry from `adapters.json` for the given agent ID.
/// Returns `(npm_package, pinned_version)`.
fn adapter_entry(agent_id: &str) -> Option<(&'static str, &'static str)> {
    use std::sync::OnceLock;

    #[derive(Deserialize)]
    struct AdaptersConfig {
        adapters: Vec<AdapterEntry>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AdapterEntry {
        agent_id: String,
        npm_package: String,
        pinned_version: String,
    }

    static PARSED: OnceLock<Vec<(String, String, String)>> = OnceLock::new();
    let entries = PARSED.get_or_init(|| {
        let config: AdaptersConfig =
            serde_json::from_str(ADAPTERS_JSON).expect("adapters.json is valid");
        config
            .adapters
            .into_iter()
            .map(|e| (e.agent_id, e.npm_package, e.pinned_version))
            .collect()
    });

    entries
        .iter()
        .find(|(id, _, _)| id == agent_id)
        .map(|(_, pkg, ver)| (pkg.as_str(), ver.as_str()))
}

fn fallback_npx_package(base: &str, version: Option<&str>) -> String {
    match version {
        Some(version) => format!("{base}@{version}"),
        None => base.to_string(),
    }
}

fn registry_url_from_env() -> Result<Url, AgentError> {
    match std::env::var("SANDBOX_AGENT_ACP_REGISTRY_URL") {
        Ok(url) => Ok(Url::parse(url.trim())?),
        Err(_) => {
            Ok(Url::parse(DEFAULT_ACP_REGISTRY_URL).expect("hardcoded valid ACP registry URL"))
        }
    }
}

fn apply_npx_version_override(package: &str, version: Option<&str>) -> String {
    let Some(version) = version else {
        return package.to_string();
    };

    if let Some((scope_and_name, _)) = split_package_version(package) {
        format!("{scope_and_name}@{version}")
    } else {
        format!("{package}@{version}")
    }
}

fn extract_npx_version(package: &str) -> Option<String> {
    split_package_version(package).map(|(_, version)| version.to_string())
}

fn split_package_version(package: &str) -> Option<(&str, &str)> {
    if let Some(stripped) = package.strip_prefix('@') {
        let idx = stripped.rfind('@')? + 1;
        let full_idx = idx + 1;
        let (name, version) = package.split_at(full_idx);
        Some((name.trim_end_matches('@'), version.trim_start_matches('@')))
    } else {
        let idx = package.rfind('@')?;
        let (name, version) = package.split_at(idx);
        Some((name, version.trim_start_matches('@')))
    }
}

fn install_npm_package(root: &Path, package: &str, agent: AgentId) -> Result<(), AgentError> {
    let mut command = Command::new("npm");
    command
        .arg("install")
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--prefix")
        .arg(root)
        .arg(package)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match command.status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(AgentError::VerifyFailed(format!(
            "npm install failed for {agent} with status {status}. run step 3: `sandbox-agent install-agent {agent}`"
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Err(AgentError::MissingNpm { agent }),
        Err(err) => Err(AgentError::VerifyFailed(format!(
            "failed to execute npm for {agent}: {err}"
        ))),
    }
}

fn npm_bin_path(root: &Path, bin_name: &str) -> PathBuf {
    let mut path = root.join("node_modules").join(".bin").join(bin_name);
    if cfg!(windows) {
        path.set_extension("cmd");
    }
    path
}

fn write_exec_agent_process_launcher(
    path: &Path,
    executable: &Path,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<(), AgentError> {
    let mut command = vec![executable.to_string_lossy().to_string()];
    command.extend(args.iter().cloned());
    write_launcher(path, &command, env)
}

fn write_mock_agent_process_launcher(path: &Path) -> Result<(), AgentError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let script = if cfg!(windows) {
        "@echo off\r\nif not \"%SANDBOX_AGENT_BIN%\"==\"\" (\r\n  \"%SANDBOX_AGENT_BIN%\" mock-agent-process %*\r\n  exit /b %errorlevel%\r\n)\r\nsandbox-agent mock-agent-process %*\r\n"
    } else {
        "#!/usr/bin/env sh\nif [ -n \"${SANDBOX_AGENT_BIN:-}\" ]; then\n  exec \"$SANDBOX_AGENT_BIN\" mock-agent-process \"$@\"\nfi\nexec sandbox-agent mock-agent-process \"$@\"\n"
    };
    write_text_file(path, script)
}

fn write_launcher(
    path: &Path,
    command: &[String],
    env: &HashMap<String, String>,
) -> Result<(), AgentError> {
    if command.is_empty() {
        return Err(AgentError::ExtractFailed(
            "launcher command cannot be empty".to_string(),
        ));
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    if cfg!(windows) {
        let mut script = String::from("@echo off\r\nsetlocal enabledelayedexpansion\r\n");
        for (key, value) in env {
            script.push_str(&format!("set {}={}\r\n", key, value));
        }
        script.push_str("\"");
        script.push_str(&command[0]);
        script.push_str("\"");
        for arg in &command[1..] {
            script.push(' ');
            script.push_str(arg);
        }
        script.push_str(" %*\r\n");
        write_text_file(path, &script)?;
    } else {
        let mut script = String::from("#!/usr/bin/env sh\nset -e\n");
        for (key, value) in env {
            script.push_str(&format!("export {}='{}'\n", key, shell_escape(value)));
        }
        script.push_str("exec ");
        for (idx, part) in command.iter().enumerate() {
            if idx > 0 {
                script.push(' ');
            }
            script.push('\'');
            script.push_str(&shell_escape(part));
            script.push('\'');
        }
        script.push_str(" \"$@\"\n");
        write_text_file(path, &script)?;
    }

    Ok(())
}

fn shell_escape(value: &str) -> String {
    value.replace('\'', "'\\''")
}

fn write_text_file(path: &Path, contents: &str) -> Result<(), AgentError> {
    fs::write(path, contents)?;
    set_executable(path)?;
    Ok(())
}

fn verify_command(path: &Path, args: &[&str]) -> Result<(), AgentError> {
    let mut command = Command::new(path);
    if args.is_empty() {
        command.arg("--help");
    } else {
        command.args(args);
    }
    command.stdout(Stdio::null()).stderr(Stdio::null());

    match command.status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(AgentError::VerifyFailed(format!(
            "{} exited with status {}",
            path.display(),
            status
        ))),
        Err(err) => Err(AgentError::VerifyFailed(format!(
            "{} failed to execute: {}",
            path.display(),
            err
        ))),
    }
}

fn fetch_registry(url: &Url) -> Result<RegistryDocument, AgentError> {
    let client = Client::builder().build()?;
    let response = client.get(url.clone()).send()?;
    if !response.status().is_success() {
        return Err(AgentError::DownloadFailed { url: url.clone() });
    }
    response
        .json::<RegistryDocument>()
        .map_err(|err| AgentError::RegistryParse(err.to_string()))
}

fn resolve_extracted_command(root: &Path, cmd: &str) -> Result<PathBuf, AgentError> {
    let normalized = cmd.trim_start_matches("./");
    let direct = root.join(normalized);
    if direct.exists() {
        return Ok(direct);
    }

    let filename = Path::new(normalized)
        .file_name()
        .and_then(|x| x.to_str())
        .ok_or_else(|| AgentError::ExtractFailed(format!("invalid command path: {cmd}")))?;

    find_file_recursive(root, filename)?
        .ok_or_else(|| AgentError::ExtractFailed(format!("missing extracted command: {cmd}")))
}

fn unpack_archive(bytes: &[u8], url: &Url, destination: &Path) -> Result<(), AgentError> {
    let path = url.path().to_ascii_lowercase();
    if path.ends_with(".zip") {
        let reader = io::Cursor::new(bytes.to_vec());
        let mut archive = zip::ZipArchive::new(reader)
            .map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
        for idx in 0..archive.len() {
            let mut file = archive
                .by_index(idx)
                .map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
            let Some(name) = file.enclosed_name().map(|p| p.to_path_buf()) else {
                continue;
            };
            let out_path = destination.join(name);
            if file.is_dir() {
                fs::create_dir_all(&out_path)?;
                continue;
            }
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = fs::File::create(&out_path)?;
            io::copy(&mut file, &mut out)?;
            let _ = set_executable(&out_path);
        }
        return Ok(());
    }

    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        let cursor = io::Cursor::new(bytes.to_vec());
        let mut archive = tar::Archive::new(GzDecoder::new(cursor));
        archive.unpack(destination)?;
        return Ok(());
    }

    Err(AgentError::ExtractFailed(format!(
        "unsupported archive format: {}",
        url
    )))
}

fn find_in_path(binary_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for path in std::env::split_paths(&path_var) {
        let candidate = path.join(binary_name);
        if candidate.exists() {
            return Some(candidate);
        }
        if cfg!(windows) {
            let candidate_exe = path.join(format!("{binary_name}.exe"));
            if candidate_exe.exists() {
                return Some(candidate_exe);
            }
        }
    }
    None
}

fn download_bytes(url: &Url) -> Result<Vec<u8>, AgentError> {
    let client = Client::builder().build()?;
    let mut response = client.get(url.clone()).send()?;
    if !response.status().is_success() {
        return Err(AgentError::DownloadFailed { url: url.clone() });
    }
    let mut bytes = Vec::new();
    response.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn install_claude(
    path: &Path,
    platform: Platform,
    version: Option<&str>,
) -> Result<(), AgentError> {
    let started = Instant::now();
    tracing::info!(
        path = %path.display(),
        platform = ?platform,
        version_override = ?version,
        "agent_manager.install_claude: starting"
    );

    let version_started = Instant::now();
    let version = match version {
        Some(version) => version.to_string(),
        None => {
            let url = Url::parse(
                "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest",
            )?;
            let text = String::from_utf8(download_bytes(&url)?)
                .map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
            text.trim().to_string()
        }
    };
    let version_ms = elapsed_ms(version_started);

    let platform_segment = match platform {
        Platform::LinuxX64 => "linux-x64",
        Platform::LinuxX64Musl => "linux-x64-musl",
        Platform::LinuxArm64 => "linux-arm64",
        Platform::MacosArm64 => "darwin-arm64",
        Platform::MacosX64 => "darwin-x64",
        Platform::WindowsX64 => "win32-x64",
        Platform::WindowsArm64 => "win32-arm64",
    };

    let url = Url::parse(&format!(
        "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/{version}/{platform_segment}/claude"
    ))?;
    let download_started = Instant::now();
    let bytes = download_bytes(&url)?;
    let download_ms = elapsed_ms(download_started);
    let write_started = Instant::now();
    write_executable(path, &bytes)?;
    tracing::info!(
        version = %version,
        url = %url,
        bytes = bytes.len(),
        version_ms = version_ms,
        download_ms = download_ms,
        write_ms = elapsed_ms(write_started),
        total_ms = elapsed_ms(started),
        "agent_manager.install_claude: completed"
    );
    Ok(())
}

fn install_amp(path: &Path, platform: Platform, version: Option<&str>) -> Result<(), AgentError> {
    let started = Instant::now();
    let version = match version {
        Some(version) => version.to_string(),
        None => {
            let url = Url::parse(
                "https://storage.googleapis.com/amp-public-assets-prod-0/cli/cli-version.txt",
            )?;
            let text = String::from_utf8(download_bytes(&url)?)
                .map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
            text.trim().to_string()
        }
    };

    let platform_segment = match platform {
        Platform::LinuxX64 | Platform::LinuxX64Musl => "linux-x64",
        Platform::LinuxArm64 => "linux-arm64",
        Platform::MacosArm64 => "darwin-arm64",
        Platform::MacosX64 => "darwin-x64",
        Platform::WindowsX64 => "win32-x64",
        Platform::WindowsArm64 => "win32-arm64",
    };

    let url = Url::parse(&format!(
        "https://storage.googleapis.com/amp-public-assets-prod-0/cli/{version}/amp-{platform_segment}"
    ))?;
    let download_started = Instant::now();
    let bytes = download_bytes(&url)?;
    let download_ms = elapsed_ms(download_started);
    let write_started = Instant::now();
    write_executable(path, &bytes)?;
    tracing::info!(
        version = %version,
        url = %url,
        bytes = bytes.len(),
        download_ms = download_ms,
        write_ms = elapsed_ms(write_started),
        total_ms = elapsed_ms(started),
        "agent_manager.install_amp: completed"
    );
    Ok(())
}

fn install_codex(path: &Path, platform: Platform, version: Option<&str>) -> Result<(), AgentError> {
    let started = Instant::now();
    let target = match platform {
        Platform::LinuxX64 | Platform::LinuxX64Musl => "x86_64-unknown-linux-musl",
        Platform::LinuxArm64 => "aarch64-unknown-linux-musl",
        Platform::MacosArm64 => "aarch64-apple-darwin",
        Platform::MacosX64 => "x86_64-apple-darwin",
        Platform::WindowsX64 => "x86_64-pc-windows-msvc",
        Platform::WindowsArm64 => "aarch64-pc-windows-msvc",
    };

    let url = match version {
        Some(version) => Url::parse(&format!(
            "https://github.com/openai/codex/releases/download/{version}/codex-{target}.tar.gz"
        ))?,
        None => Url::parse(&format!(
            "https://github.com/openai/codex/releases/latest/download/codex-{target}.tar.gz"
        ))?,
    };

    let download_started = Instant::now();
    let bytes = download_bytes(&url)?;
    let download_ms = elapsed_ms(download_started);
    let temp_dir = tempfile::tempdir()?;
    let unpack_started = Instant::now();
    let cursor = io::Cursor::new(bytes);
    let mut archive = tar::Archive::new(GzDecoder::new(cursor));
    archive.unpack(temp_dir.path())?;
    let unpack_ms = elapsed_ms(unpack_started);

    let expected = if cfg!(windows) {
        format!("codex-{target}.exe")
    } else {
        format!("codex-{target}")
    };

    let binary = find_file_recursive(temp_dir.path(), &expected)?
        .ok_or_else(|| AgentError::ExtractFailed(format!("missing {expected}")))?;
    let move_started = Instant::now();
    move_executable(&binary, path)?;
    tracing::info!(
        url = %url,
        target = target,
        download_ms = download_ms,
        unpack_ms = unpack_ms,
        move_ms = elapsed_ms(move_started),
        total_ms = elapsed_ms(started),
        "agent_manager.install_codex: completed"
    );
    Ok(())
}

fn install_opencode(
    path: &Path,
    platform: Platform,
    version: Option<&str>,
) -> Result<(), AgentError> {
    let started = Instant::now();
    tracing::info!(
        path = %path.display(),
        platform = ?platform,
        version_override = ?version,
        "agent_manager.install_opencode: starting"
    );

    let result = match platform {
        Platform::MacosArm64 => {
            let url = match version {
                Some(version) => Url::parse(&format!(
                    "https://github.com/anomalyco/opencode/releases/download/{version}/opencode-darwin-arm64.zip"
                ))?,
                None => Url::parse(
                    "https://github.com/anomalyco/opencode/releases/latest/download/opencode-darwin-arm64.zip",
                )?,
            };
            install_zip_binary(path, &url, "opencode")
        }
        Platform::MacosX64 => {
            let url = match version {
                Some(version) => Url::parse(&format!(
                    "https://github.com/anomalyco/opencode/releases/download/{version}/opencode-darwin-x64.zip"
                ))?,
                None => Url::parse(
                    "https://github.com/anomalyco/opencode/releases/latest/download/opencode-darwin-x64.zip",
                )?,
            };
            install_zip_binary(path, &url, "opencode")
        }
        _ => {
            let platform_segment = match platform {
                Platform::LinuxX64 => "linux-x64",
                Platform::LinuxX64Musl => "linux-x64-musl",
                Platform::LinuxArm64 => "linux-arm64",
                Platform::WindowsX64 => "win32-x64",
                Platform::WindowsArm64 => "win32-arm64",
                Platform::MacosArm64 | Platform::MacosX64 => unreachable!(),
            };
            let url = match version {
                Some(version) => Url::parse(&format!(
                    "https://github.com/anomalyco/opencode/releases/download/{version}/opencode-{platform_segment}.tar.gz"
                ))?,
                None => Url::parse(&format!(
                    "https://github.com/anomalyco/opencode/releases/latest/download/opencode-{platform_segment}.tar.gz"
                ))?,
            };

            let download_started = Instant::now();
            let bytes = download_bytes(&url)?;
            let download_ms = elapsed_ms(download_started);
            let temp_dir = tempfile::tempdir()?;
            let unpack_started = Instant::now();
            let cursor = io::Cursor::new(bytes);
            let mut archive = tar::Archive::new(GzDecoder::new(cursor));
            archive.unpack(temp_dir.path())?;
            let unpack_ms = elapsed_ms(unpack_started);
            let binary = find_file_recursive(temp_dir.path(), "opencode")
                .or_else(|_| find_file_recursive(temp_dir.path(), "opencode.exe"))?
                .ok_or_else(|| AgentError::ExtractFailed("missing opencode".to_string()))?;
            let move_started = Instant::now();
            move_executable(&binary, path)?;
            tracing::info!(
                url = %url,
                download_ms = download_ms,
                unpack_ms = unpack_ms,
                move_ms = elapsed_ms(move_started),
                "agent_manager.install_opencode: tarball extraction complete"
            );
            Ok(())
        }
    };

    if result.is_ok() {
        tracing::info!(
            total_ms = elapsed_ms(started),
            "agent_manager.install_opencode: completed"
        );
    }

    result
}

fn install_zip_binary(path: &Path, url: &Url, binary_name: &str) -> Result<(), AgentError> {
    let started = Instant::now();
    let download_started = Instant::now();
    let bytes = download_bytes(url)?;
    let download_ms = elapsed_ms(download_started);
    let reader = io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
    let temp_dir = tempfile::tempdir()?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
        if !file.name().ends_with(binary_name)
            && !file.name().ends_with(&format!("{binary_name}.exe"))
        {
            continue;
        }
        let out_path = temp_dir.path().join(binary_name);
        let mut out_file = fs::File::create(&out_path)?;
        io::copy(&mut file, &mut out_file)?;
        let move_started = Instant::now();
        move_executable(&out_path, path)?;
        tracing::info!(
            url = %url,
            binary_name = binary_name,
            download_ms = download_ms,
            move_ms = elapsed_ms(move_started),
            total_ms = elapsed_ms(started),
            "agent_manager.install_zip_binary: completed"
        );
        return Ok(());
    }
    Err(AgentError::ExtractFailed(format!("missing {binary_name}")))
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), AgentError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    set_executable(path)?;
    Ok(())
}

fn move_executable(source: &Path, dest: &Path) -> Result<(), AgentError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    if dest.exists() {
        fs::remove_file(dest)?;
    }
    fs::copy(source, dest)?;
    set_executable(dest)?;
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), AgentError> {
    Ok(())
}

fn find_file_recursive(dir: &Path, filename: &str) -> Result<Option<PathBuf>, AgentError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, filename)? {
                return Ok(Some(found));
            }
        } else if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name == filename {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

fn parse_version_output(output: &std::process::Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);
    combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| match line.find(" (") {
            Some(pos) => line[..pos].to_string(),
            None => line.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Mutex, OnceLock};
    use std::thread;

    use super::*;

    fn write_exec(path: &Path, script: &str) {
        fs::write(path, script).expect("write script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(path).expect("metadata").permissions();
            perms.set_mode(0o755);
            fs::set_permissions(path, perms).expect("set mode");
        }
    }

    fn write_fake_npm(path: &Path) {
        write_exec(
            path,
            r#"#!/usr/bin/env sh
set -e
prefix=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    install|--no-audit|--no-fund)
      shift
      ;;
    --prefix)
      prefix="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$prefix" ] || exit 1
mkdir -p "$prefix/node_modules/.bin"
for bin in claude-code-acp codex-acp amp-acp pi-acp cursor-agent-acp; do
  echo '#!/usr/bin/env sh' > "$prefix/node_modules/.bin/$bin"
  echo 'exit 0' >> "$prefix/node_modules/.bin/$bin"
  chmod +x "$prefix/node_modules/.bin/$bin"
done
exit 0
"#,
        );
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &std::ffi::OsStr) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn serve_registry_once(document: serde_json::Value) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind registry server");
        let addr = listener.local_addr().expect("local addr");
        let body = document.to_string();

        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                respond_json(&mut stream, &body);
            }
        });

        Url::parse(&format!("http://{addr}/registry.json")).expect("registry url")
    }

    fn respond_json(stream: &mut TcpStream, body: &str) {
        let mut buffer = [0_u8; 4096];
        let _ = stream.read(&mut buffer);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
        stream.flush().expect("flush response");
    }

    #[test]
    fn install_is_idempotent_when_native_and_agent_process_exists() {
        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        fs::create_dir_all(temp_dir.path().join("agent_processes"))
            .expect("create agent processes dir");
        fs::write(manager.binary_path(AgentId::Codex), b"stub").expect("write native binary");
        fs::write(manager.agent_process_path(AgentId::Codex), b"stub")
            .expect("write agent process launcher");

        let result = manager
            .install(AgentId::Codex, InstallOptions::default())
            .expect("install should succeed");

        assert!(result.already_installed);
        assert!(result.artifacts.is_empty());
    }

    #[test]
    fn split_package_version_handles_scoped_and_unscoped_packages() {
        let scoped = split_package_version("@scope/pkg@1.2.3").expect("scoped");
        assert_eq!(scoped.0, "@scope/pkg");
        assert_eq!(scoped.1, "1.2.3");

        let unscoped = split_package_version("pkg@2.0.0").expect("unscoped");
        assert_eq!(unscoped.0, "pkg");
        assert_eq!(unscoped.1, "2.0.0");

        assert!(split_package_version("pkg").is_none());
    }

    #[test]
    fn install_is_idempotent_for_all_supported_agents_when_artifacts_exist() {
        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        fs::create_dir_all(temp_dir.path().join("agent_processes"))
            .expect("create agent processes dir");

        for agent in [AgentId::Claude, AgentId::Codex, AgentId::Opencode] {
            fs::write(manager.binary_path(agent), b"stub").expect("write native binary");
            fs::write(manager.agent_process_path(agent), b"stub")
                .expect("write agent process launcher");
        }

        // Pi and Cursor only need agent process launchers (native_required = false).
        for agent in [AgentId::Pi, AgentId::Cursor] {
            fs::write(manager.agent_process_path(agent), b"stub")
                .expect("write agent process launcher");
        }

        for agent in [
            AgentId::Claude,
            AgentId::Codex,
            AgentId::Opencode,
            AgentId::Pi,
            AgentId::Cursor,
            AgentId::Mock,
        ] {
            let result = manager
                .install(agent, InstallOptions::default())
                .expect("install should succeed");
            assert!(
                result.already_installed,
                "expected idempotent install for {agent}"
            );
            assert!(result.artifacts.is_empty(), "no artifacts for {agent}");
        }
    }

    #[test]
    fn install_uses_registry_provenance_with_agent_process_version_override() {
        let _env_lock = env_lock().lock().expect("env lock");

        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let mut manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        // Keep native install path satisfied locally so install only provisions agent process.
        write_exec(
            &manager.binary_path(AgentId::Codex),
            "#!/usr/bin/env sh\nexit 0\n",
        );

        let bin_dir = temp_dir.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("create bin dir");
        write_fake_npm(&bin_dir.join("npm"));

        let original_path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![bin_dir.clone()];
        paths.extend(std::env::split_paths(&original_path));
        let combined_path = std::env::join_paths(paths).expect("join PATH");
        let _path_guard = EnvVarGuard::set("PATH", &combined_path);

        let registry_url = serve_registry_once(serde_json::json!({
            "agents": [
                {
                    "id": "codex-acp",
                    "version": "1.2.3",
                    "distribution": {
                        "npx": {
                            "package": "@example/codex-acp@1.2.3",
                            "args": [],
                            "env": {}
                        }
                    }
                }
            ]
        }));
        manager.registry_url = registry_url;

        let result = manager
            .install(
                AgentId::Codex,
                InstallOptions {
                    reinstall: false,
                    version: None,
                    agent_process_version: Some("9.9.9".to_string()),
                },
            )
            .expect("install succeeds");

        assert!(!result.already_installed);
        let agent_process_artifact = result
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == InstalledArtifactKind::AgentProcess)
            .expect("agent process artifact");
        assert_eq!(agent_process_artifact.source, InstallSource::Registry);
        assert_eq!(agent_process_artifact.version.as_deref(), Some("9.9.9"));

        let launcher =
            fs::read_to_string(manager.agent_process_path(AgentId::Codex)).expect("launcher");
        assert!(
            launcher.contains("node_modules/.bin/codex-acp"),
            "launcher should invoke installed codex executable"
        );
    }

    #[test]
    fn install_falls_back_when_registry_entry_missing() {
        let _env_lock = env_lock().lock().expect("env lock");

        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let mut manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        write_exec(
            &manager.binary_path(AgentId::Codex),
            "#!/usr/bin/env sh\nexit 0\n",
        );

        let bin_dir = temp_dir.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("create bin dir");
        write_fake_npm(&bin_dir.join("npm"));

        let original_path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![bin_dir.clone()];
        paths.extend(std::env::split_paths(&original_path));
        let combined_path = std::env::join_paths(paths).expect("join PATH");
        let _path_guard = EnvVarGuard::set("PATH", &combined_path);

        manager.registry_url = serve_registry_once(serde_json::json!({ "agents": [] }));

        let result = manager
            .install(AgentId::Codex, InstallOptions::default())
            .expect("install succeeds");
        assert!(!result.already_installed);
        let agent_process_artifact = result
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == InstalledArtifactKind::AgentProcess)
            .expect("agent process artifact");
        assert_eq!(agent_process_artifact.source, InstallSource::Fallback);
    }

    #[test]
    fn install_returns_missing_npm_error_for_npm_backed_agents() {
        let _env_lock = env_lock().lock().expect("env lock");

        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let mut manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        write_exec(
            &manager.binary_path(AgentId::Codex),
            "#!/usr/bin/env sh\nexit 0\n",
        );

        let bin_dir = temp_dir.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("create bin dir");

        let original_path = std::env::var_os("PATH").unwrap_or_default();
        let combined_path = std::env::join_paths([bin_dir]).expect("join PATH");
        let _path_guard = EnvVarGuard::set("PATH", &combined_path);

        manager.registry_url = serve_registry_once(serde_json::json!({ "agents": [] }));

        let error = manager
            .install(AgentId::Codex, InstallOptions::default())
            .expect_err("install should fail without npm");

        match error {
            AgentError::MissingNpm { agent } => assert_eq!(agent, AgentId::Codex),
            other => panic!("expected MissingNpm, got {other:?}"),
        }

        drop(original_path);
    }

    #[test]
    fn reinstall_mock_returns_agent_process_artifact() {
        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        let result = manager
            .install(
                AgentId::Mock,
                InstallOptions {
                    reinstall: true,
                    version: None,
                    agent_process_version: None,
                },
            )
            .expect("mock reinstall");

        assert!(!result.already_installed);
        assert_eq!(result.artifacts.len(), 1);
        assert_eq!(
            result.artifacts[0].kind,
            InstalledArtifactKind::AgentProcess
        );
        assert_eq!(result.artifacts[0].source, InstallSource::Builtin);
    }

    #[test]
    fn mock_launcher_prefers_sandbox_agent_bin() {
        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        manager
            .install(
                AgentId::Mock,
                InstallOptions {
                    reinstall: true,
                    version: None,
                    agent_process_version: None,
                },
            )
            .expect("mock install");

        let launcher = manager.agent_process_path(AgentId::Mock);
        let mut file = fs::File::open(&launcher).expect("open mock launcher");
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .expect("read mock launcher");

        assert!(
            contents.contains("SANDBOX_AGENT_BIN"),
            "mock launcher should reference SANDBOX_AGENT_BIN"
        );
    }

    #[test]
    fn install_pi_skips_native_and_installs_fallback_npm_launcher() {
        let _env_lock = env_lock().lock().expect("env lock");

        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let mut manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        let bin_dir = temp_dir.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("create bin dir");
        write_fake_npm(&bin_dir.join("npm"));

        let original_path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![bin_dir.clone()];
        paths.extend(std::env::split_paths(&original_path));
        let combined_path = std::env::join_paths(paths).expect("join PATH");
        let _path_guard = EnvVarGuard::set("PATH", &combined_path);

        // Empty registry so we hit the fallback path.
        manager.registry_url = serve_registry_once(serde_json::json!({ "agents": [] }));

        let result = manager
            .install(AgentId::Pi, InstallOptions::default())
            .expect("pi install succeeds");

        // No native artifact (native_required = false).
        assert!(
            !result
                .artifacts
                .iter()
                .any(|a| a.kind == InstalledArtifactKind::NativeAgent),
            "pi should not produce a native artifact"
        );

        let agent_process = result
            .artifacts
            .iter()
            .find(|a| a.kind == InstalledArtifactKind::AgentProcess)
            .expect("pi agent process artifact");
        assert_eq!(agent_process.source, InstallSource::Fallback);

        let launcher =
            fs::read_to_string(manager.agent_process_path(AgentId::Pi)).expect("read pi launcher");
        assert!(
            launcher.contains("node_modules/.bin/pi-acp"),
            "pi launcher should use installed pi executable"
        );

        // resolve_agent_process should now find it.
        let spec = manager
            .resolve_agent_process(AgentId::Pi)
            .expect("resolve pi agent process");
        assert_eq!(spec.source, InstallSource::LocalPath);

        // is_installed should return true.
        assert!(manager.is_installed(AgentId::Pi), "pi should be installed");

        // Second install should be idempotent.
        // Need a new registry server since the first one was consumed.
        manager.registry_url = serve_registry_once(serde_json::json!({ "agents": [] }));
        let result2 = manager
            .install(AgentId::Pi, InstallOptions::default())
            .expect("pi re-install succeeds");
        assert!(
            result2.already_installed,
            "pi re-install should be idempotent"
        );
    }

    #[test]
    fn install_cursor_skips_native_and_installs_fallback_npm_launcher() {
        let _env_lock = env_lock().lock().expect("env lock");

        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let mut manager = AgentManager::with_platform(temp_dir.path(), Platform::LinuxX64);

        let bin_dir = temp_dir.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("create bin dir");
        write_fake_npm(&bin_dir.join("npm"));

        let original_path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![bin_dir.clone()];
        paths.extend(std::env::split_paths(&original_path));
        let combined_path = std::env::join_paths(paths).expect("join PATH");
        let _path_guard = EnvVarGuard::set("PATH", &combined_path);

        manager.registry_url = serve_registry_once(serde_json::json!({ "agents": [] }));

        let result = manager
            .install(AgentId::Cursor, InstallOptions::default())
            .expect("cursor install succeeds");

        assert!(
            !result
                .artifacts
                .iter()
                .any(|a| a.kind == InstalledArtifactKind::NativeAgent),
            "cursor should not produce a native artifact"
        );

        let agent_process = result
            .artifacts
            .iter()
            .find(|a| a.kind == InstalledArtifactKind::AgentProcess)
            .expect("cursor agent process artifact");
        assert_eq!(agent_process.source, InstallSource::Fallback);

        let launcher = fs::read_to_string(manager.agent_process_path(AgentId::Cursor))
            .expect("read cursor launcher");
        assert!(
            launcher.contains("node_modules/.bin/cursor-agent-acp"),
            "cursor launcher should use installed cursor executable"
        );

        let spec = manager
            .resolve_agent_process(AgentId::Cursor)
            .expect("resolve cursor agent process");
        assert_eq!(spec.source, InstallSource::LocalPath);

        assert!(
            manager.is_installed(AgentId::Cursor),
            "cursor should be installed"
        );

        manager.registry_url = serve_registry_once(serde_json::json!({ "agents": [] }));
        let result2 = manager
            .install(AgentId::Cursor, InstallOptions::default())
            .expect("cursor re-install succeeds");
        assert!(
            result2.already_installed,
            "cursor re-install should be idempotent"
        );
    }
}
