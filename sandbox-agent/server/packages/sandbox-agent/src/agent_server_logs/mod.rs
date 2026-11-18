#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StderrOutput {
    pub head: Option<String>,
    pub tail: Option<String>,
    pub truncated: bool,
    pub total_lines: Option<usize>,
}

#[cfg(unix)]
pub use unix::AgentServerLogs;
#[cfg(windows)]
pub use windows::AgentServerLogs;
