use sandbox_agent_error::ProblemDetails;
use serde_json::{json, Map, Value};

use crate::desktop_types::{DesktopErrorInfo, DesktopProcessInfo};

#[derive(Debug, Clone)]
pub struct DesktopProblem {
    status: u16,
    title: &'static str,
    code: &'static str,
    message: String,
    missing_dependencies: Vec<String>,
    install_command: Option<String>,
    processes: Vec<DesktopProcessInfo>,
}

impl DesktopProblem {
    pub fn unsupported_platform(message: impl Into<String>) -> Self {
        Self::new(
            501,
            "Desktop Unsupported",
            "desktop_unsupported_platform",
            message,
        )
    }

    pub fn dependencies_missing(
        missing_dependencies: Vec<String>,
        install_command: Option<String>,
        processes: Vec<DesktopProcessInfo>,
    ) -> Self {
        let mut message = if missing_dependencies.is_empty() {
            "Desktop dependencies are not installed".to_string()
        } else {
            format!(
                "Desktop dependencies are not installed: {}",
                missing_dependencies.join(", ")
            )
        };
        if let Some(command) = install_command.as_ref() {
            message.push_str(&format!(
                ". Run `{command}` to install them, or install the required tools manually."
            ));
        }
        Self::new(
            503,
            "Desktop Dependencies Missing",
            "desktop_dependencies_missing",
            message,
        )
        .with_missing_dependencies(missing_dependencies)
        .with_install_command(install_command)
        .with_processes(processes)
    }

    pub fn runtime_inactive(message: impl Into<String>) -> Self {
        Self::new(
            409,
            "Desktop Runtime Inactive",
            "desktop_runtime_inactive",
            message,
        )
    }

    pub fn runtime_starting(message: impl Into<String>) -> Self {
        Self::new(
            409,
            "Desktop Runtime Starting",
            "desktop_runtime_starting",
            message,
        )
    }

    pub fn runtime_failed(
        message: impl Into<String>,
        install_command: Option<String>,
        processes: Vec<DesktopProcessInfo>,
    ) -> Self {
        Self::new(
            503,
            "Desktop Runtime Failed",
            "desktop_runtime_failed",
            message,
        )
        .with_install_command(install_command)
        .with_processes(processes)
    }

    pub fn invalid_action(message: impl Into<String>) -> Self {
        Self::new(
            400,
            "Desktop Invalid Action",
            "desktop_invalid_action",
            message,
        )
    }

    pub fn screenshot_failed(
        message: impl Into<String>,
        processes: Vec<DesktopProcessInfo>,
    ) -> Self {
        Self::new(
            502,
            "Desktop Screenshot Failed",
            "desktop_screenshot_failed",
            message,
        )
        .with_processes(processes)
    }

    pub fn input_failed(message: impl Into<String>, processes: Vec<DesktopProcessInfo>) -> Self {
        Self::new(502, "Desktop Input Failed", "desktop_input_failed", message)
            .with_processes(processes)
    }

    pub fn window_not_found(message: impl Into<String>) -> Self {
        Self::new(404, "Window Not Found", "window_not_found", message)
    }

    pub fn no_focused_window() -> Self {
        Self::new(
            404,
            "No Focused Window",
            "no_focused_window",
            "No window currently has focus",
        )
    }

    pub fn stream_already_active(message: impl Into<String>) -> Self {
        Self::new(
            409,
            "Stream Already Active",
            "stream_already_active",
            message,
        )
    }

    pub fn stream_not_active(message: impl Into<String>) -> Self {
        Self::new(409, "Stream Not Active", "stream_not_active", message)
    }

    pub fn clipboard_failed(message: impl Into<String>) -> Self {
        Self::new(500, "Clipboard Failed", "clipboard_failed", message)
    }

    pub fn app_not_found(message: impl Into<String>) -> Self {
        Self::new(404, "App Not Found", "app_not_found", message)
    }

    pub fn to_problem_details(&self) -> ProblemDetails {
        let mut extensions = Map::new();
        extensions.insert("code".to_string(), Value::String(self.code.to_string()));
        if !self.missing_dependencies.is_empty() {
            extensions.insert(
                "missingDependencies".to_string(),
                Value::Array(
                    self.missing_dependencies
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
        if let Some(install_command) = self.install_command.as_ref() {
            extensions.insert(
                "installCommand".to_string(),
                Value::String(install_command.clone()),
            );
        }
        if !self.processes.is_empty() {
            extensions.insert("processes".to_string(), json!(self.processes));
        }

        ProblemDetails {
            type_: format!("urn:sandbox-agent:error:{}", self.code),
            title: self.title.to_string(),
            status: self.status,
            detail: Some(self.message.clone()),
            instance: None,
            extensions,
        }
    }

    pub fn to_error_info(&self) -> DesktopErrorInfo {
        DesktopErrorInfo {
            code: self.code.to_string(),
            message: self.message.clone(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    fn new(
        status: u16,
        title: &'static str,
        code: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            title,
            code,
            message: message.into(),
            missing_dependencies: Vec::new(),
            install_command: None,
            processes: Vec::new(),
        }
    }

    fn with_missing_dependencies(mut self, missing_dependencies: Vec<String>) -> Self {
        self.missing_dependencies = missing_dependencies;
        self
    }

    fn with_install_command(mut self, install_command: Option<String>) -> Self {
        self.install_command = install_command;
        self
    }

    fn with_processes(mut self, processes: Vec<DesktopProcessInfo>) -> Self {
        self.processes = processes;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependencies_missing_detail_includes_install_command() {
        let problem = DesktopProblem::dependencies_missing(
            vec!["Xvfb".to_string(), "openbox".to_string()],
            Some("sandbox-agent install desktop --yes".to_string()),
            Vec::new(),
        );
        let details = problem.to_problem_details();
        let detail = details.detail.expect("detail");
        assert!(detail.contains("Desktop dependencies are not installed: Xvfb, openbox"));
        assert!(detail.contains("sandbox-agent install desktop --yes"));
        assert_eq!(
            details.extensions.get("installCommand"),
            Some(&Value::String(
                "sandbox-agent install desktop --yes".to_string()
            ))
        );
    }
}
