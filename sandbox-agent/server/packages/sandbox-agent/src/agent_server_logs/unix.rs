use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use sandbox_agent_error::SandboxError;
use time::{Duration, OffsetDateTime};

use super::StderrOutput;

const LOG_RETENTION_DAYS: i64 = 7;
const LOG_HEAD_LINES: usize = 20;
const LOG_TAIL_LINES: usize = 50;
const LOG_MAX_LINE_LENGTH: usize = 500;

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

    /// Read stderr from the current log file for error diagnostics.
    /// Returns structured output with head/tail if truncated.
    pub fn read_stderr(&self) -> Option<StderrOutput> {
        let log_dir = self.base_dir.join(&self.agent);
        let now = OffsetDateTime::now_utc();
        let file_name = format!(
            "{}-{:04}-{:02}-{:02}.log",
            self.agent,
            now.year(),
            now.month() as u8,
            now.day()
        );
        let path = log_dir.join(file_name);

        let file = File::open(&path).ok()?;
        let metadata = file.metadata().ok()?;
        let file_size = metadata.len();

        if file_size == 0 {
            return None;
        }

        let reader = BufReader::new(file);
        let mut all_lines: Vec<String> = Vec::new();

        for line_result in reader.lines() {
            let line: String = match line_result {
                Ok(l) => l,
                Err(_) => break,
            };
            let truncated_line = if line.len() > LOG_MAX_LINE_LENGTH {
                format!("{}...", &line[..LOG_MAX_LINE_LENGTH])
            } else {
                line
            };
            all_lines.push(truncated_line);
        }

        let line_count = all_lines.len();
        if line_count == 0 {
            return None;
        }

        let max_untruncated = LOG_HEAD_LINES + LOG_TAIL_LINES;

        if line_count <= max_untruncated {
            // Small file - return all content in head
            Some(StderrOutput {
                head: Some(all_lines.join("\n")),
                tail: None,
                truncated: false,
                total_lines: Some(line_count),
            })
        } else {
            // Large file - return head and tail separately
            let head = all_lines[..LOG_HEAD_LINES].join("\n");
            let tail = all_lines[line_count - LOG_TAIL_LINES..].join("\n");
            Some(StderrOutput {
                head: Some(head),
                tail: Some(tail),
                truncated: true,
                total_lines: Some(line_count),
            })
        }
    }
}
