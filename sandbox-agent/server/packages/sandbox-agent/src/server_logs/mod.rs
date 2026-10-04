#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::ServerLogs;
#[cfg(windows)]
pub use windows::ServerLogs;
