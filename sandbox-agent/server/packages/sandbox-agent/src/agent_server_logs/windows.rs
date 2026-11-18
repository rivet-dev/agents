use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use sandbox_agent_error::SandboxError;
use time::{Duration, OffsetDateTime};

use super::StderrOutput;

const LOG_RETENTION_DAYS: i64 = 7;

pub struct AgentServerLogs {
    base_dir: PathBuf,
    agent: String,
}

impl AgentServerLogs {
    pub fn new(base_dir: PathBuf, agent: impl Into<String>) -> Self {
        Self {
            base_dir,
            agent: agent.into(),
        }
    }

    pub fn open(&self) -> Result<std::process::Stdio, SandboxError> {
        let log_dir = self.base_dir.join(&self.agent);
        std::fs::create_dir_all(&log_dir).map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;

        let now = OffsetDateTime::now_utc();
        let file_name = format!(
            "{}-{:04}-{:02}-{:02}.log",
            self.agent,
            now.year(),
            now.month() as u8,
            now.day()
        );
        let path = log_dir.join(file_name);
        self.prune_logs(&log_dir, now)?;

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;

        eprintln!("{} server logs: {}", self.agent, path.display());
        Ok(file.into())
    }

    fn prune_logs(&self, log_dir: &Path, now: OffsetDateTime) -> Result<(), SandboxError> {
        let retention = Duration::days(LOG_RETENTION_DAYS);
        let cutoff = now - retention;
        let entries = std::fs::read_dir(log_dir).map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let modified = match metadata.modified() {
                Ok(modified) => modified,
                Err(_) => continue,
            };
            let modified = OffsetDateTime::from(modified);
            if modified < cutoff {
                let _ = std::fs::remove_file(entry.path());
            }
        }

        Ok(())
    }

    /// Read stderr output from the agent's log file.
    /// Windows stub - returns None as stderr capture is not implemented.
    pub fn read_stderr(&self) -> Option<StderrOutput> {
        None
    }
}
