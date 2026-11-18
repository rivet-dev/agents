use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use sandbox_agent_error::SandboxError;

use crate::desktop_errors::DesktopProblem;
use crate::desktop_install::desktop_platform_support_message;
use crate::desktop_recording::{DesktopRecordingContext, DesktopRecordingManager};
use crate::desktop_streaming::DesktopStreamingManager;
use crate::desktop_types::{
    DesktopActionResponse, DesktopDisplayInfoResponse, DesktopErrorInfo, DesktopKeyModifiers,
    DesktopKeyboardDownRequest, DesktopKeyboardPressRequest, DesktopKeyboardTypeRequest,
    DesktopKeyboardUpRequest, DesktopMouseButton, DesktopMouseClickRequest,
    DesktopMouseDownRequest, DesktopMouseDragRequest, DesktopMouseMoveRequest,
    DesktopMousePositionResponse, DesktopMouseScrollRequest, DesktopMouseUpRequest,
    DesktopProcessInfo, DesktopRecordingInfo, DesktopRecordingListResponse,
    DesktopRecordingStartRequest, DesktopRegionScreenshotQuery, DesktopResolution,
    DesktopScreenshotFormat, DesktopScreenshotQuery, DesktopStartRequest, DesktopState,
    DesktopStatusResponse, DesktopStreamStatusResponse, DesktopWindowInfo,
    DesktopWindowListResponse,
};
use crate::process_runtime::{
    ProcessOwner, ProcessRuntime, ProcessStartSpec, ProcessStatus, RestartPolicy,
};

const DEFAULT_WIDTH: u32 = 1440;
const DEFAULT_HEIGHT: u32 = 900;
const DEFAULT_DPI: u32 = 96;
const DEFAULT_DISPLAY_NUM: i32 = 99;
const MAX_DISPLAY_PROBE: i32 = 10;
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const INPUT_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const JPEG_SIGNATURE: &[u8] = b"\xff\xd8\xff";
const WEBP_RIFF_SIGNATURE: &[u8] = b"RIFF";
const WEBP_WEBP_SIGNATURE: &[u8] = b"WEBP";

#[derive(Debug, Clone)]
pub struct DesktopRuntime {
    config: DesktopRuntimeConfig,
    process_runtime: Arc<ProcessRuntime>,
    recording_manager: DesktopRecordingManager,
    streaming_manager: DesktopStreamingManager,
    inner: Arc<Mutex<DesktopRuntimeStateData>>,
}

#[derive(Debug, Clone)]
pub struct DesktopRuntimeConfig {
    state_dir: PathBuf,
    display_num: i32,
    assume_linux_for_tests: bool,
}

#[derive(Debug)]
struct DesktopRuntimeStateData {
    state: DesktopState,
    display_num: i32,
    display: Option<String>,
    resolution: Option<DesktopResolution>,
    started_at: Option<String>,
    last_error: Option<DesktopErrorInfo>,
    missing_dependencies: Vec<String>,
    install_command: Option<String>,
    runtime_log_path: PathBuf,
    environment: HashMap<String, String>,
    xvfb: Option<ManagedDesktopProcess>,
    openbox: Option<ManagedDesktopProcess>,
    dbus_pid: Option<u32>,
    streaming_config: Option<crate::desktop_streaming::StreamingConfig>,
    recording_fps: Option<u32>,
}

#[derive(Debug)]
struct ManagedDesktopProcess {
    name: &'static str,
    process_id: String,
    pid: Option<u32>,
    running: bool,
}

#[derive(Debug, Clone)]
struct DesktopReadyContext {
    display: String,
    environment: HashMap<String, String>,
    resolution: DesktopResolution,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesktopScreenshotData {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct DesktopScreenshotOptions {
    format: DesktopScreenshotFormat,
    quality: u8,
    scale: f32,
}

impl Default for DesktopScreenshotOptions {
    fn default() -> Self {
        Self {
            format: DesktopScreenshotFormat::Png,
            quality: 85,
            scale: 1.0,
        }
    }
}

impl DesktopScreenshotOptions {
    fn content_type(self) -> &'static str {
        match self.format {
            DesktopScreenshotFormat::Png => "image/png",
            DesktopScreenshotFormat::Jpeg => "image/jpeg",
            DesktopScreenshotFormat::Webp => "image/webp",
        }
    }

    fn output_arg(self) -> &'static str {
        match self.format {
            DesktopScreenshotFormat::Png => "png:-",
            DesktopScreenshotFormat::Jpeg => "jpeg:-",
            DesktopScreenshotFormat::Webp => "webp:-",
        }
    }

    fn needs_convert(self) -> bool {
        self.format != DesktopScreenshotFormat::Png || (self.scale - 1.0).abs() > f32::EPSILON
    }
}

impl Default for DesktopRuntimeConfig {
    fn default() -> Self {
        Self {
            state_dir: default_state_dir(),
            display_num: DEFAULT_DISPLAY_NUM,
            assume_linux_for_tests: false,
        }
    }
}

impl DesktopRuntime {
    pub fn new(process_runtime: Arc<ProcessRuntime>) -> Self {
        Self::with_config(process_runtime, DesktopRuntimeConfig::default())
    }

    pub fn with_config(process_runtime: Arc<ProcessRuntime>, config: DesktopRuntimeConfig) -> Self {
        let runtime_log_path = config.state_dir.join("desktop-runtime.log");
        let recording_manager =
            DesktopRecordingManager::new(process_runtime.clone(), config.state_dir.clone());
        Self {
            streaming_manager: DesktopStreamingManager::new(process_runtime.clone()),
            process_runtime,
            recording_manager,
            inner: Arc::new(Mutex::new(DesktopRuntimeStateData {
                state: DesktopState::Inactive,
                display_num: config.display_num,
                display: None,
                resolution: None,
                started_at: None,
                last_error: None,
                missing_dependencies: Vec::new(),
                install_command: None,
                runtime_log_path,
                environment: HashMap::new(),
                xvfb: None,
                openbox: None,
                dbus_pid: None,
                streaming_config: None,
                recording_fps: None,
            })),
            config,
        }
    }

    pub async fn status(&self) -> DesktopStatusResponse {
        let mut state = self.inner.lock().await;
        self.refresh_status_locked(&mut state).await;
        let mut response = self.snapshot_locked(&state);
        drop(state);
        self.append_neko_process(&mut response).await;

        // Include the current window list when the desktop is active so callers
        // get windows for free when polling status (avoids a separate request).
        if response.state == DesktopState::Active {
            if let Ok(window_list) = self.list_windows().await {
                response.windows = window_list.windows;
            }
        }

        response
    }

    pub async fn start(
        &self,
        request: DesktopStartRequest,
    ) -> Result<DesktopStatusResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;

        if !self.platform_supported() {
            let problem = DesktopProblem::unsupported_platform(desktop_platform_support_message());
            self.record_problem_locked(&mut state, &problem);
            state.state = DesktopState::Failed;
            return Err(problem);
        }

        if matches!(state.state, DesktopState::Starting | DesktopState::Stopping) {
            return Err(DesktopProblem::runtime_starting(
                "Desktop runtime is busy transitioning state",
            ));
        }

        self.refresh_status_locked(&mut state).await;
        if state.state == DesktopState::Active {
            let mut response = self.snapshot_locked(&state);
            drop(state);
            self.append_neko_process(&mut response).await;
            return Ok(response);
        }

        if !state.missing_dependencies.is_empty() {
            return Err(DesktopProblem::dependencies_missing(
                state.missing_dependencies.clone(),
                state.install_command.clone(),
                self.processes_locked(&state),
            ));
        }

        self.ensure_state_dir_locked(&state).map_err(|err| {
            DesktopProblem::runtime_failed(err, None, self.processes_locked(&state))
        })?;
        self.write_runtime_log_locked(&state, "starting desktop runtime");

        let width = request.width.unwrap_or(DEFAULT_WIDTH);
        let height = request.height.unwrap_or(DEFAULT_HEIGHT);
        let dpi = request.dpi.unwrap_or(DEFAULT_DPI);
        validate_start_request(width, height, dpi)?;

        // Override display_num if provided in request
        let display_num =
            self.choose_display_num_from(request.display_num.unwrap_or(self.config.display_num))?;
        let display = format!(":{display_num}");
        let resolution = DesktopResolution {
            width,
            height,
            dpi: Some(dpi),
        };
        let environment = self.base_environment(&display)?;

        // Store streaming and recording config for later use
        state.streaming_config = if request.stream_video_codec.is_some()
            || request.stream_audio_codec.is_some()
            || request.stream_frame_rate.is_some()
            || request.webrtc_port_range.is_some()
        {
            Some(crate::desktop_streaming::StreamingConfig {
                video_codec: request
                    .stream_video_codec
                    .unwrap_or_else(|| "vp8".to_string()),
                audio_codec: request
                    .stream_audio_codec
                    .unwrap_or_else(|| "opus".to_string()),
                frame_rate: request.stream_frame_rate.unwrap_or(30).clamp(1, 60),
                webrtc_port_range: request
                    .webrtc_port_range
                    .unwrap_or_else(|| "59050-59070".to_string()),
            })
        } else {
            None
        };
        state.recording_fps = request.recording_fps.map(|fps| fps.clamp(1, 60));

        state.state = DesktopState::Starting;
        state.display_num = display_num;
        state.display = Some(display.clone());
        state.resolution = Some(resolution.clone());
        state.started_at = None;
        state.last_error = None;
        state.environment = environment;
        state.install_command = None;

        if let Err(problem) = self.start_dbus_locked(&mut state).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }
        if let Err(problem) = self.start_xvfb_locked(&mut state, &resolution).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }
        if let Err(problem) = self.wait_for_socket(display_num).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }
        if let Err(problem) = self.start_openbox_locked(&mut state).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }

        let ready = DesktopReadyContext {
            display,
            environment: state.environment.clone(),
            resolution,
        };

        let display_info = match self.query_display_info_locked(&state, &ready).await {
            Ok(display_info) => display_info,
            Err(problem) => return Err(self.fail_start_locked(&mut state, problem).await),
        };
        state.resolution = Some(display_info.resolution.clone());

        let screenshot_options = DesktopScreenshotOptions::default();
        if let Err(problem) = self
            .capture_screenshot_locked(&state, None, &screenshot_options)
            .await
        {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }

        state.state = DesktopState::Active;
        state.started_at = Some(chrono::Utc::now().to_rfc3339());
        state.last_error = None;
        self.write_runtime_log_locked(
            &state,
            &format!(
                "desktop runtime active on {} ({}x{}, dpi {})",
                display_info.display,
                display_info.resolution.width,
                display_info.resolution.height,
                display_info.resolution.dpi.unwrap_or(DEFAULT_DPI)
            ),
        );

        let mut response = self.snapshot_locked(&state);
        drop(state);
        self.append_neko_process(&mut response).await;
        Ok(response)
    }

    pub async fn stop(&self) -> Result<DesktopStatusResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        if matches!(state.state, DesktopState::Starting | DesktopState::Stopping) {
            return Err(DesktopProblem::runtime_starting(
                "Desktop runtime is busy transitioning state",
            ));
        }

        state.state = DesktopState::Stopping;
        self.write_runtime_log_locked(&state, "stopping desktop runtime");
        let _ = self.recording_manager.stop().await;
        let _ = self.streaming_manager.stop().await;

        self.stop_openbox_locked(&mut state).await;
        self.stop_xvfb_locked(&mut state).await;
        self.stop_dbus_locked(&mut state);

        state.state = DesktopState::Inactive;
        state.display = None;
        state.resolution = None;
        state.started_at = None;
        state.last_error = None;
        state.missing_dependencies = self.detect_missing_dependencies();
        state.install_command = self.install_command_for(&state.missing_dependencies);
        state.environment.clear();
        state.streaming_config = None;
        state.recording_fps = None;

        let mut response = self.snapshot_locked(&state);
        drop(state);
        self.append_neko_process(&mut response).await;
        Ok(response)
    }

    pub async fn shutdown(&self) {
        let _ = self.stop().await;
    }

    pub async fn screenshot(
        &self,
        query: DesktopScreenshotQuery,
    ) -> Result<DesktopScreenshotData, DesktopProblem> {
        let options = screenshot_options(query.format, query.quality, query.scale)?;
        let show_cursor = query.show_cursor.unwrap_or(false);
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let mut bytes = self
            .capture_screenshot_locked(&state, Some(&ready), &options)
            .await?;
        if show_cursor {
            bytes = self
                .composite_cursor(&state, &ready, bytes, &options)
                .await?;
        }
        Ok(DesktopScreenshotData {
            bytes,
            content_type: options.content_type(),
        })
    }

    pub async fn screenshot_region(
        &self,
        query: DesktopRegionScreenshotQuery,
    ) -> Result<DesktopScreenshotData, DesktopProblem> {
        validate_region(&query)?;
        let options = screenshot_options(query.format, query.quality, query.scale)?;
        let show_cursor = query.show_cursor.unwrap_or(false);
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let crop = format!("{}x{}+{}+{}", query.width, query.height, query.x, query.y);
        let mut bytes = self
            .capture_screenshot_with_crop_locked(&state, &ready, &crop, &options)
            .await?;
        if show_cursor {
            bytes = self
                .composite_cursor_region(
                    &state,
                    &ready,
                    bytes,
                    &options,
                    query.x,
                    query.y,
                    query.width,
                    query.height,
                )
                .await?;
        }
        Ok(DesktopScreenshotData {
            bytes,
            content_type: options.content_type(),
        })
    }

    pub async fn mouse_position(&self) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn move_mouse(
        &self,
        request: DesktopMouseMoveRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        validate_coordinates(request.x, request.y)?;
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = vec![
            "mousemove".to_string(),
            request.x.to_string(),
            request.y.to_string(),
        ];
        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn click_mouse(
        &self,
        request: DesktopMouseClickRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        validate_coordinates(request.x, request.y)?;
        let click_count = request.click_count.unwrap_or(1);
        if click_count == 0 {
            return Err(DesktopProblem::invalid_action(
                "clickCount must be greater than 0",
            ));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let button = mouse_button_code(request.button.unwrap_or(DesktopMouseButton::Left));
        let mut args = vec![
            "mousemove".to_string(),
            request.x.to_string(),
            request.y.to_string(),
            "click".to_string(),
        ];
        if click_count > 1 {
            args.push("--repeat".to_string());
            args.push(click_count.to_string());
        }
        args.push(button.to_string());
        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn mouse_down(
        &self,
        request: DesktopMouseDownRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        let coordinates = validate_optional_coordinates(request.x, request.y)?;
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let button = mouse_button_code(request.button.unwrap_or(DesktopMouseButton::Left));
        let args = mouse_button_transition_args("mousedown", coordinates, button);
        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn mouse_up(
        &self,
        request: DesktopMouseUpRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        let coordinates = validate_optional_coordinates(request.x, request.y)?;
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let button = mouse_button_code(request.button.unwrap_or(DesktopMouseButton::Left));
        let args = mouse_button_transition_args("mouseup", coordinates, button);
        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn drag_mouse(
        &self,
        request: DesktopMouseDragRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        validate_coordinates(request.start_x, request.start_y)?;
        validate_coordinates(request.end_x, request.end_y)?;

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let button = mouse_button_code(request.button.unwrap_or(DesktopMouseButton::Left));
        let args = vec![
            "mousemove".to_string(),
            request.start_x.to_string(),
            request.start_y.to_string(),
            "mousedown".to_string(),
            button.to_string(),
            "mousemove".to_string(),
            request.end_x.to_string(),
            request.end_y.to_string(),
            "mouseup".to_string(),
            button.to_string(),
        ];
        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn scroll_mouse(
        &self,
        request: DesktopMouseScrollRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        validate_coordinates(request.x, request.y)?;
        let delta_x = request.delta_x.unwrap_or(0);
        let delta_y = request.delta_y.unwrap_or(0);
        if delta_x == 0 && delta_y == 0 {
            return Err(DesktopProblem::invalid_action(
                "deltaX or deltaY must be non-zero",
            ));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let mut args = vec![
            "mousemove".to_string(),
            request.x.to_string(),
            request.y.to_string(),
        ];

        append_scroll_clicks(&mut args, delta_y, 5, 4);
        append_scroll_clicks(&mut args, delta_x, 7, 6);

        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn type_text(
        &self,
        request: DesktopKeyboardTypeRequest,
    ) -> Result<DesktopActionResponse, DesktopProblem> {
        if request.text.is_empty() {
            return Err(DesktopProblem::invalid_action("text must not be empty"));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = type_text_args(request.text, request.delay_ms.unwrap_or(10));
        self.run_input_command_locked(&state, &ready, args).await?;
        Ok(DesktopActionResponse { ok: true })
    }

    pub async fn press_key(
        &self,
        request: DesktopKeyboardPressRequest,
    ) -> Result<DesktopActionResponse, DesktopProblem> {
        if request.key.trim().is_empty() {
            return Err(DesktopProblem::invalid_action("key must not be empty"));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = press_key_args(request.key, request.modifiers);
        self.run_input_command_locked(&state, &ready, args).await?;
        Ok(DesktopActionResponse { ok: true })
    }

    pub async fn key_down(
        &self,
        request: DesktopKeyboardDownRequest,
    ) -> Result<DesktopActionResponse, DesktopProblem> {
        if request.key.trim().is_empty() {
            return Err(DesktopProblem::invalid_action("key must not be empty"));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = key_transition_args("keydown", request.key);
        self.run_input_command_locked(&state, &ready, args).await?;
        Ok(DesktopActionResponse { ok: true })
    }

    pub async fn key_up(
        &self,
        request: DesktopKeyboardUpRequest,
    ) -> Result<DesktopActionResponse, DesktopProblem> {
        if request.key.trim().is_empty() {
            return Err(DesktopProblem::invalid_action("key must not be empty"));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = key_transition_args("keyup", request.key);
        self.run_input_command_locked(&state, &ready, args).await?;
        Ok(DesktopActionResponse { ok: true })
    }

    pub async fn display_info(&self) -> Result<DesktopDisplayInfoResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        self.query_display_info_locked(&state, &ready).await
    }

    pub async fn list_windows(&self) -> Result<DesktopWindowListResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let active_window_id = self.active_window_id_locked(&state, &ready).await?;
        let window_ids = self.window_ids_locked(&state, &ready).await?;
        let mut windows = Vec::with_capacity(window_ids.len());
        for window_id in window_ids {
            let title = self.window_title_locked(&state, &ready, &window_id).await?;
            let (x, y, width, height) = self
                .window_geometry_locked(&state, &ready, &window_id)
                .await?;
            let is_active = active_window_id
                .as_deref()
                .map(|active| active == window_id)
                .unwrap_or(false);

            // Filter out noise: window-manager chrome, toolkit internals, and
            // invisible helper windows. Always keep the active window so the
            // caller can track focus even when the WM itself is focused.
            if !is_active {
                let trimmed = title.trim();
                if trimmed.is_empty() || trimmed == "Openbox" || (width < 120 && height < 80) {
                    continue;
                }
            }

            windows.push(DesktopWindowInfo {
                id: window_id.clone(),
                title,
                x,
                y,
                width,
                height,
                is_active,
            });
        }
        Ok(DesktopWindowListResponse { windows })
    }

    pub async fn start_recording(
        &self,
        request: DesktopRecordingStartRequest,
    ) -> Result<DesktopRecordingInfo, SandboxError> {
        let context = self.recording_context().await?;
        self.recording_manager.start(context, request).await
    }

    pub async fn stop_recording(&self) -> Result<DesktopRecordingInfo, SandboxError> {
        self.recording_manager.stop().await
    }

    pub async fn list_recordings(&self) -> Result<DesktopRecordingListResponse, SandboxError> {
        self.recording_manager.list().await
    }

    pub async fn get_recording(&self, id: &str) -> Result<DesktopRecordingInfo, SandboxError> {
        self.recording_manager.get(id).await
    }

    pub async fn recording_download_path(&self, id: &str) -> Result<PathBuf, SandboxError> {
        self.recording_manager.download_path(id).await
    }

    pub async fn delete_recording(&self, id: &str) -> Result<(), SandboxError> {
        self.recording_manager.delete(id).await
    }

    pub async fn start_streaming(&self) -> Result<DesktopStreamStatusResponse, SandboxError> {
        let state = self.inner.lock().await;
        let display = state
            .display
            .as_deref()
            .ok_or_else(|| SandboxError::Conflict {
                message: "desktop runtime is not active".to_string(),
            })?;
        let resolution = state
            .resolution
            .clone()
            .ok_or_else(|| SandboxError::Conflict {
                message: "desktop runtime is not active".to_string(),
            })?;
        let environment = state.environment.clone();
        let display = display.to_string();
        let streaming_config = state.streaming_config.clone();
        drop(state);
        self.streaming_manager
            .start(&display, resolution, &environment, streaming_config, None)
            .await
    }

    pub async fn stop_streaming(&self) -> DesktopStreamStatusResponse {
        self.streaming_manager.stop().await
    }

    pub async fn ensure_streaming_active(&self) -> Result<(), SandboxError> {
        self.streaming_manager.ensure_active().await
    }

    pub fn streaming_manager(&self) -> &DesktopStreamingManager {
        &self.streaming_manager
    }

    async fn recording_context(&self) -> Result<DesktopRecordingContext, SandboxError> {
        let mut state = self.inner.lock().await;
        let ready = self
            .ensure_ready_locked(&mut state)
            .await
            .map_err(desktop_problem_to_sandbox_error)?;
        Ok(DesktopRecordingContext {
            display: ready.display,
            environment: ready.environment,
            resolution: ready.resolution,
        })
    }

    async fn ensure_ready_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
    ) -> Result<DesktopReadyContext, DesktopProblem> {
        self.refresh_status_locked(state).await;
        match state.state {
            DesktopState::Active => {
                let display = state.display.clone().ok_or_else(|| {
                    DesktopProblem::runtime_failed(
                        "Desktop runtime has no active display",
                        state.install_command.clone(),
                        self.processes_locked(state),
                    )
                })?;
                let resolution = state.resolution.clone().ok_or_else(|| {
                    DesktopProblem::runtime_failed(
                        "Desktop runtime has no active resolution",
                        state.install_command.clone(),
                        self.processes_locked(state),
                    )
                })?;
                Ok(DesktopReadyContext {
                    display,
                    environment: state.environment.clone(),
                    resolution,
                })
            }
            DesktopState::InstallRequired => Err(DesktopProblem::dependencies_missing(
                state.missing_dependencies.clone(),
                state.install_command.clone(),
                self.processes_locked(state),
            )),
            DesktopState::Inactive => Err(DesktopProblem::runtime_inactive(
                "Desktop runtime has not been started",
            )),
            DesktopState::Starting | DesktopState::Stopping => Err(
                DesktopProblem::runtime_starting("Desktop runtime is still transitioning"),
            ),
            DesktopState::Failed => Err(DesktopProblem::runtime_failed(
                state
                    .last_error
                    .as_ref()
                    .map(|error| error.message.clone())
                    .unwrap_or_else(|| "Desktop runtime is unhealthy".to_string()),
                state.install_command.clone(),
                self.processes_locked(state),
            )),
        }
    }

    async fn refresh_status_locked(&self, state: &mut DesktopRuntimeStateData) {
        let missing_dependencies = if self.platform_supported() {
            self.detect_missing_dependencies()
        } else {
            Vec::new()
        };
        state.missing_dependencies = missing_dependencies.clone();
        state.install_command = self.install_command_for(&missing_dependencies);

        if !self.platform_supported() {
            state.state = DesktopState::Failed;
            state.last_error = Some(
                DesktopProblem::unsupported_platform(desktop_platform_support_message())
                    .to_error_info(),
            );
            return;
        }

        if !missing_dependencies.is_empty() {
            state.state = DesktopState::InstallRequired;
            state.last_error = Some(
                DesktopProblem::dependencies_missing(
                    missing_dependencies,
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
                .to_error_info(),
            );
            return;
        }

        if matches!(
            state.state,
            DesktopState::Inactive | DesktopState::Starting | DesktopState::Stopping
        ) {
            if state.state == DesktopState::Inactive {
                state.last_error = None;
            }
            return;
        }

        if state.state == DesktopState::Failed
            && state.display.is_none()
            && state.xvfb.is_none()
            && state.openbox.is_none()
            && state.dbus_pid.is_none()
        {
            return;
        }

        let Some(display) = state.display.clone() else {
            state.state = DesktopState::Failed;
            state.last_error = Some(
                DesktopProblem::runtime_failed(
                    "Desktop runtime has no display",
                    None,
                    self.processes_locked(state),
                )
                .to_error_info(),
            );
            return;
        };

        if let Err(problem) = self.ensure_process_running_locked(state, "Xvfb").await {
            self.record_problem_locked(state, &problem);
            state.state = DesktopState::Failed;
            return;
        }
        if let Err(problem) = self.ensure_process_running_locked(state, "openbox").await {
            self.record_problem_locked(state, &problem);
            state.state = DesktopState::Failed;
            return;
        }

        if !socket_path(state.display_num).exists() {
            let problem = DesktopProblem::runtime_failed(
                format!("X socket for display {display} is missing"),
                state.install_command.clone(),
                self.processes_locked(state),
            );
            self.record_problem_locked(state, &problem);
            state.state = DesktopState::Failed;
            return;
        }

        let ready = DesktopReadyContext {
            display,
            environment: state.environment.clone(),
            resolution: state.resolution.clone().unwrap_or(DesktopResolution {
                width: DEFAULT_WIDTH,
                height: DEFAULT_HEIGHT,
                dpi: Some(DEFAULT_DPI),
            }),
        };

        match self.query_display_info_locked(state, &ready).await {
            Ok(display_info) => {
                state.resolution = Some(display_info.resolution);
            }
            Err(problem) => {
                self.record_problem_locked(state, &problem);
                state.state = DesktopState::Failed;
                return;
            }
        }

        let screenshot_options = DesktopScreenshotOptions::default();
        if let Err(problem) = self
            .capture_screenshot_locked(state, Some(&ready), &screenshot_options)
            .await
        {
            self.record_problem_locked(state, &problem);
            state.state = DesktopState::Failed;
            return;
        }

        state.state = DesktopState::Active;
        state.last_error = None;
    }

    async fn ensure_process_running_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
        name: &str,
    ) -> Result<(), DesktopProblem> {
        let process_id = match name {
            "Xvfb" => state
                .xvfb
                .as_ref()
                .map(|process| process.process_id.clone()),
            "openbox" => state
                .openbox
                .as_ref()
                .map(|process| process.process_id.clone()),
            _ => None,
        };

        let Some(process_id) = process_id else {
            return Err(DesktopProblem::runtime_failed(
                format!("{name} is not running"),
                state.install_command.clone(),
                self.processes_locked(state),
            ));
        };

        let snapshot = self
            .process_runtime
            .snapshot(&process_id)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to inspect {name}: {err}"),
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
            })?;

        if let Some(process) = match name {
            "Xvfb" => state.xvfb.as_mut(),
            "openbox" => state.openbox.as_mut(),
            _ => None,
        } {
            process.pid = snapshot.pid;
            process.running = snapshot.status == ProcessStatus::Running;
        }

        if snapshot.status == ProcessStatus::Running {
            return Ok(());
        }

        self.write_runtime_log_locked(state, &format!("{name} exited; attempting restart"));
        match name {
            "Xvfb" => {
                let resolution = state.resolution.clone().ok_or_else(|| {
                    DesktopProblem::runtime_failed(
                        "desktop resolution missing during Xvfb restart",
                        state.install_command.clone(),
                        self.processes_locked(state),
                    )
                })?;
                state.xvfb = None;
                self.start_xvfb_locked(state, &resolution).await?;
            }
            "openbox" => {
                state.openbox = None;
                self.start_openbox_locked(state).await?;
            }
            _ => {}
        }

        let restarted_snapshot = self
            .process_runtime
            .snapshot(match name {
                "Xvfb" => state
                    .xvfb
                    .as_ref()
                    .map(|process| process.process_id.as_str())
                    .unwrap_or_default(),
                "openbox" => state
                    .openbox
                    .as_ref()
                    .map(|process| process.process_id.as_str())
                    .unwrap_or_default(),
                _ => "",
            })
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to inspect restarted {name}: {err}"),
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
            })?;
        if restarted_snapshot.status == ProcessStatus::Running {
            Ok(())
        } else {
            Err(DesktopProblem::runtime_failed(
                format!("{name} exited with status {:?}", snapshot.exit_code),
                state.install_command.clone(),
                self.processes_locked(state),
            ))
        }
    }

    async fn start_dbus_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
    ) -> Result<(), DesktopProblem> {
        if find_binary("dbus-launch").is_none() {
            self.write_runtime_log_locked(
                state,
                "dbus-launch not found; continuing without D-Bus session",
            );
            return Ok(());
        }

        let output = run_command_output("dbus-launch", &[], &state.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to launch dbus-launch: {err}"),
                    None,
                    self.processes_locked(state),
                )
            })?;

        if !output.status.success() {
            self.write_runtime_log_locked(
                state,
                &format!(
                    "dbus-launch failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            );
            return Ok(());
        }

        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some((key, value)) = line.split_once('=') {
                let cleaned = value.trim().trim_end_matches(';').to_string();
                if key == "DBUS_SESSION_BUS_ADDRESS" {
                    state.environment.insert(key.to_string(), cleaned);
                } else if key == "DBUS_SESSION_BUS_PID" {
                    state.dbus_pid = cleaned.parse::<u32>().ok();
                }
            }
        }

        Ok(())
    }

    async fn start_xvfb_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
        resolution: &DesktopResolution,
    ) -> Result<(), DesktopProblem> {
        let Some(display) = state.display.clone() else {
            return Err(DesktopProblem::runtime_failed(
                "Desktop display was not configured before starting Xvfb",
                None,
                self.processes_locked(state),
            ));
        };
        let args = vec![
            display,
            "-screen".to_string(),
            "0".to_string(),
            format!("{}x{}x24", resolution.width, resolution.height),
            "-dpi".to_string(),
            resolution.dpi.unwrap_or(DEFAULT_DPI).to_string(),
            "-nolisten".to_string(),
            "tcp".to_string(),
        ];
        let snapshot = self
            .process_runtime
            .start_process(ProcessStartSpec {
                command: "Xvfb".to_string(),
                args,
                cwd: None,
                env: state.environment.clone(),
                tty: false,
                interactive: false,
                owner: ProcessOwner::Desktop,
                restart_policy: Some(RestartPolicy::Always),
            })
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to start Xvfb: {err}"),
                    None,
                    self.processes_locked(state),
                )
            })?;
        state.xvfb = Some(ManagedDesktopProcess {
            name: "Xvfb",
            process_id: snapshot.id,
            pid: snapshot.pid,
            running: snapshot.status == ProcessStatus::Running,
        });
        Ok(())
    }

    async fn start_openbox_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
    ) -> Result<(), DesktopProblem> {
        let snapshot = self
            .process_runtime
            .start_process(ProcessStartSpec {
                command: "openbox".to_string(),
                args: Vec::new(),
                cwd: None,
                env: state.environment.clone(),
                tty: false,
                interactive: false,
                owner: ProcessOwner::Desktop,
                restart_policy: Some(RestartPolicy::Always),
            })
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to start openbox: {err}"),
                    None,
                    self.processes_locked(state),
                )
            })?;
        state.openbox = Some(ManagedDesktopProcess {
            name: "openbox",
            process_id: snapshot.id,
            pid: snapshot.pid,
            running: snapshot.status == ProcessStatus::Running,
        });
        Ok(())
    }

    async fn stop_xvfb_locked(&self, state: &mut DesktopRuntimeStateData) {
        if let Some(process) = state.xvfb.take() {
            self.write_runtime_log_locked(state, "stopping Xvfb");
            let _ = self
                .process_runtime
                .stop_process(&process.process_id, Some(2_000))
                .await;
            if self
                .process_runtime
                .snapshot(&process.process_id)
                .await
                .ok()
                .is_some_and(|snapshot| snapshot.status == ProcessStatus::Running)
            {
                let _ = self
                    .process_runtime
                    .kill_process(&process.process_id, Some(1_000))
                    .await;
            }
        }
    }

    async fn stop_openbox_locked(&self, state: &mut DesktopRuntimeStateData) {
        if let Some(process) = state.openbox.take() {
            self.write_runtime_log_locked(state, "stopping openbox");
            let _ = self
                .process_runtime
                .stop_process(&process.process_id, Some(2_000))
                .await;
            if self
                .process_runtime
                .snapshot(&process.process_id)
                .await
                .ok()
                .is_some_and(|snapshot| snapshot.status == ProcessStatus::Running)
            {
                let _ = self
                    .process_runtime
                    .kill_process(&process.process_id, Some(1_000))
                    .await;
            }
        }
    }

    fn stop_dbus_locked(&self, state: &mut DesktopRuntimeStateData) {
        if let Some(pid) = state.dbus_pid.take() {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }

    async fn fail_start_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
        problem: DesktopProblem,
    ) -> DesktopProblem {
        self.record_problem_locked(state, &problem);
        self.write_runtime_log_locked(state, "desktop runtime startup failed; cleaning up");
        self.stop_openbox_locked(state).await;
        self.stop_xvfb_locked(state).await;
        self.stop_dbus_locked(state);
        state.state = DesktopState::Failed;
        state.display = None;
        state.resolution = None;
        state.started_at = None;
        state.environment.clear();
        problem
    }

    async fn capture_screenshot_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: Option<&DesktopReadyContext>,
        options: &DesktopScreenshotOptions,
    ) -> Result<Vec<u8>, DesktopProblem> {
        match ready {
            Some(ready) => {
                self.capture_screenshot_with_crop_locked(state, ready, "", options)
                    .await
            }
            None => {
                let ready = DesktopReadyContext {
                    display: state
                        .display
                        .clone()
                        .unwrap_or_else(|| format!(":{}", state.display_num)),
                    environment: state.environment.clone(),
                    resolution: state.resolution.clone().unwrap_or(DesktopResolution {
                        width: DEFAULT_WIDTH,
                        height: DEFAULT_HEIGHT,
                        dpi: Some(DEFAULT_DPI),
                    }),
                };
                self.capture_screenshot_with_crop_locked(state, &ready, "", options)
                    .await
            }
        }
    }

    async fn capture_screenshot_with_crop_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        crop: &str,
        options: &DesktopScreenshotOptions,
    ) -> Result<Vec<u8>, DesktopProblem> {
        let mut args = vec!["-window".to_string(), "root".to_string()];
        if !crop.is_empty() {
            args.push("-crop".to_string());
            args.push(crop.to_string());
        }
        args.push("png:-".to_string());

        let output = run_command_output("import", &args, &ready.environment, SCREENSHOT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::screenshot_failed(
                    format!("failed to capture desktop screenshot: {err}"),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::screenshot_failed(
                format!(
                    "desktop screenshot command failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                self.processes_locked(state),
            ));
        }
        let bytes = maybe_convert_screenshot(output.stdout, options, &ready.environment)
            .await
            .map_err(|message| {
                DesktopProblem::screenshot_failed(message, self.processes_locked(state))
            })?;
        validate_image_bytes(&bytes, options.format).map_err(|message| {
            DesktopProblem::screenshot_failed(message, self.processes_locked(state))
        })?;
        Ok(bytes)
    }

    async fn active_window_id_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
    ) -> Result<Option<String>, DesktopProblem> {
        let args = vec!["getactivewindow".to_string()];
        let output = run_command_output("xdotool", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to query active window: {err}"),
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            if output.status.code() == Some(1) && output.stdout.is_empty() {
                return Ok(None);
            }
            return Err(DesktopProblem::runtime_failed(
                format!(
                    "active window query failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                state.install_command.clone(),
                self.processes_locked(state),
            ));
        }
        let window_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if window_id.is_empty() {
            Ok(None)
        } else {
            Ok(Some(window_id))
        }
    }

    async fn window_ids_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
    ) -> Result<Vec<String>, DesktopProblem> {
        let args = vec![
            "search".to_string(),
            "--onlyvisible".to_string(),
            "--name".to_string(),
            "".to_string(),
        ];
        let output = run_command_output("xdotool", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to list desktop windows: {err}"),
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            if output.status.code() == Some(1) && output.stdout.is_empty() {
                return Ok(Vec::new());
            }
            return Err(DesktopProblem::runtime_failed(
                format!(
                    "desktop window listing failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                state.install_command.clone(),
                self.processes_locked(state),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToString::to_string)
            .collect())
    }

    async fn window_title_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        window_id: &str,
    ) -> Result<String, DesktopProblem> {
        let args = vec!["getwindowname".to_string(), window_id.to_string()];
        let output = run_command_output("xdotool", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to query window title: {err}"),
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::runtime_failed(
                format!(
                    "window title query failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                state.install_command.clone(),
                self.processes_locked(state),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    }

    async fn window_geometry_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        window_id: &str,
    ) -> Result<(i32, i32, u32, u32), DesktopProblem> {
        let args = vec!["getwindowgeometry".to_string(), window_id.to_string()];
        let output = run_command_output("xdotool", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to query window geometry: {err}"),
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::runtime_failed(
                format!(
                    "window geometry query failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                state.install_command.clone(),
                self.processes_locked(state),
            ));
        }
        parse_window_geometry(&output.stdout).map_err(|message| {
            DesktopProblem::runtime_failed(
                message,
                state.install_command.clone(),
                self.processes_locked(state),
            )
        })
    }

    async fn mouse_position_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        let args = vec!["getmouselocation".to_string(), "--shell".to_string()];
        let output = run_command_output("xdotool", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::input_failed(
                    format!("failed to query mouse position: {err}"),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::input_failed(
                format!(
                    "mouse position command failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                self.processes_locked(state),
            ));
        }
        parse_mouse_position(&output.stdout)
            .map_err(|message| DesktopProblem::input_failed(message, self.processes_locked(state)))
    }

    async fn run_input_command_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        args: Vec<String>,
    ) -> Result<(), DesktopProblem> {
        let output = run_command_output("xdotool", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::input_failed(
                    format!("failed to execute desktop input command: {err}"),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::input_failed(
                format!(
                    "desktop input command failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                self.processes_locked(state),
            ));
        }
        Ok(())
    }

    async fn query_display_info_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
    ) -> Result<DesktopDisplayInfoResponse, DesktopProblem> {
        let args = vec!["--current".to_string()];
        let output = run_command_output("xrandr", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to query display info: {err}"),
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::runtime_failed(
                format!(
                    "display query failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                state.install_command.clone(),
                self.processes_locked(state),
            ));
        }
        let resolution = parse_xrandr_resolution(&output.stdout).map_err(|message| {
            DesktopProblem::runtime_failed(
                message,
                state.install_command.clone(),
                self.processes_locked(state),
            )
        })?;
        Ok(DesktopDisplayInfoResponse {
            display: ready.display.clone(),
            resolution: DesktopResolution {
                dpi: ready.resolution.dpi,
                ..resolution
            },
        })
    }

    fn detect_missing_dependencies(&self) -> Vec<String> {
        let mut missing = Vec::new();
        for (name, binary) in [
            ("Xvfb", "Xvfb"),
            ("openbox", "openbox"),
            ("xdotool", "xdotool"),
            ("import", "import"),
            ("xrandr", "xrandr"),
        ] {
            if find_binary(binary).is_none() {
                missing.push(name.to_string());
            }
        }
        missing
    }

    fn install_command_for(&self, missing_dependencies: &[String]) -> Option<String> {
        if !self.platform_supported() || missing_dependencies.is_empty() {
            None
        } else {
            Some("sandbox-agent install desktop --yes".to_string())
        }
    }

    fn platform_supported(&self) -> bool {
        cfg!(target_os = "linux") || self.config.assume_linux_for_tests
    }

    fn choose_display_num(&self) -> Result<i32, DesktopProblem> {
        self.choose_display_num_from(self.config.display_num)
    }

    fn choose_display_num_from(&self, start: i32) -> Result<i32, DesktopProblem> {
        if start <= 0 {
            return Err(DesktopProblem::invalid_action("displayNum must be > 0"));
        }
        for offset in 0..MAX_DISPLAY_PROBE {
            let candidate = start + offset;
            if !socket_path(candidate).exists() {
                return Ok(candidate);
            }
        }
        Err(DesktopProblem::runtime_failed(
            format!("unable to find an available X display starting at :{start}"),
            None,
            Vec::new(),
        ))
    }

    fn base_environment(&self, display: &str) -> Result<HashMap<String, String>, DesktopProblem> {
        let mut environment = HashMap::new();
        environment.insert("DISPLAY".to_string(), display.to_string());
        environment.insert(
            "HOME".to_string(),
            self.config
                .state_dir
                .join("home")
                .to_string_lossy()
                .to_string(),
        );
        environment.insert(
            "USER".to_string(),
            std::env::var("USER").unwrap_or_else(|_| "sandbox-agent".to_string()),
        );
        environment.insert(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_default(),
        );
        fs::create_dir_all(self.config.state_dir.join("home")).map_err(|err| {
            DesktopProblem::runtime_failed(
                format!("failed to create desktop home: {err}"),
                None,
                Vec::new(),
            )
        })?;
        Ok(environment)
    }

    async fn wait_for_socket(&self, display_num: i32) -> Result<(), DesktopProblem> {
        let socket = socket_path(display_num);
        let parent = socket
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("/tmp/.X11-unix"));
        let _ = fs::create_dir_all(parent);

        let start = tokio::time::Instant::now();
        while start.elapsed() < STARTUP_TIMEOUT {
            if socket.exists() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        Err(DesktopProblem::runtime_failed(
            format!("timed out waiting for X socket {}", socket.display()),
            None,
            Vec::new(),
        ))
    }

    fn snapshot_locked(&self, state: &DesktopRuntimeStateData) -> DesktopStatusResponse {
        DesktopStatusResponse {
            state: state.state,
            display: state.display.clone(),
            resolution: state.resolution.clone(),
            started_at: state.started_at.clone(),
            last_error: state.last_error.clone(),
            missing_dependencies: state.missing_dependencies.clone(),
            install_command: state.install_command.clone(),
            processes: self.processes_locked(state),
            runtime_log_path: Some(state.runtime_log_path.to_string_lossy().to_string()),
            windows: Vec::new(),
        }
    }

    fn processes_locked(&self, state: &DesktopRuntimeStateData) -> Vec<DesktopProcessInfo> {
        let mut processes = Vec::new();
        if let Some(process) = state.xvfb.as_ref() {
            processes.push(DesktopProcessInfo {
                name: process.name.to_string(),
                pid: process.pid,
                running: process.running,
                log_path: None,
            });
        }
        if let Some(process) = state.openbox.as_ref() {
            processes.push(DesktopProcessInfo {
                name: process.name.to_string(),
                pid: process.pid,
                running: process.running,
                log_path: None,
            });
        }
        if let Some(pid) = state.dbus_pid {
            processes.push(DesktopProcessInfo {
                name: "dbus".to_string(),
                pid: Some(pid),
                running: process_exists(pid),
                log_path: None,
            });
        }
        processes
    }

    /// Append neko streaming process info to the response, if a neko process
    /// has been started by the streaming manager.
    async fn append_neko_process(&self, response: &mut DesktopStatusResponse) {
        if let Some(neko_info) = self.streaming_manager.process_info().await {
            response.processes.push(neko_info);
        }
    }

    fn record_problem_locked(&self, state: &mut DesktopRuntimeStateData, problem: &DesktopProblem) {
        state.last_error = Some(problem.to_error_info());
        self.write_runtime_log_locked(
            state,
            &format!("{}: {}", problem.code(), problem.to_error_info().message),
        );
    }

    fn ensure_state_dir_locked(&self, state: &DesktopRuntimeStateData) -> Result<(), String> {
        fs::create_dir_all(&self.config.state_dir).map_err(|err| {
            format!(
                "failed to create desktop state dir {}: {err}",
                self.config.state_dir.display()
            )
        })?;
        if let Some(parent) = state.runtime_log_path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create runtime log dir {}: {err}",
                    parent.display()
                )
            })?;
        }
        Ok(())
    }

    fn write_runtime_log_locked(&self, state: &DesktopRuntimeStateData, message: &str) {
        if let Some(parent) = state.runtime_log_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let line = format!("{} {}\n", chrono::Utc::now().to_rfc3339(), message);
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&state.runtime_log_path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
    }

    pub async fn get_clipboard(
        &self,
        selection: Option<String>,
    ) -> Result<crate::desktop_types::DesktopClipboardResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let sel = selection.unwrap_or_else(|| "clipboard".to_string());
        let args = vec!["-selection".to_string(), sel.clone(), "-o".to_string()];
        let output = run_command_output("xclip", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::clipboard_failed(format!("failed to read clipboard: {err}"))
            })?;
        if !output.status.success() {
            // Empty clipboard is not an error
            return Ok(crate::desktop_types::DesktopClipboardResponse {
                text: String::new(),
                selection: sel,
            });
        }
        Ok(crate::desktop_types::DesktopClipboardResponse {
            text: String::from_utf8_lossy(&output.stdout).to_string(),
            selection: sel,
        })
    }

    pub async fn set_clipboard(
        &self,
        request: crate::desktop_types::DesktopClipboardWriteRequest,
    ) -> Result<DesktopActionResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let sel = request.selection.unwrap_or_else(|| "clipboard".to_string());
        let selections: Vec<String> = if sel == "both" {
            vec!["clipboard".to_string(), "primary".to_string()]
        } else {
            vec![sel]
        };
        for selection in &selections {
            let args = vec![
                "-selection".to_string(),
                selection.clone(),
                "-i".to_string(),
            ];
            let output = run_command_output_with_stdin(
                "xclip",
                &args,
                &ready.environment,
                INPUT_TIMEOUT,
                request.text.as_bytes().to_vec(),
            )
            .await
            .map_err(|err| {
                DesktopProblem::clipboard_failed(format!("failed to write clipboard: {err}"))
            })?;
            if !output.status.success() {
                return Err(DesktopProblem::clipboard_failed(format!(
                    "clipboard write failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
        }
        Ok(DesktopActionResponse { ok: true })
    }

    pub async fn focused_window(&self) -> Result<DesktopWindowInfo, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let window_id = self
            .active_window_id_locked(&state, &ready)
            .await?
            .ok_or_else(DesktopProblem::no_focused_window)?;
        let title = self.window_title_locked(&state, &ready, &window_id).await?;
        let (x, y, width, height) = self
            .window_geometry_locked(&state, &ready, &window_id)
            .await?;
        Ok(DesktopWindowInfo {
            id: window_id,
            title,
            x,
            y,
            width,
            height,
            is_active: true,
        })
    }

    pub async fn focus_window(&self, window_id: &str) -> Result<DesktopWindowInfo, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = vec![
            "windowactivate".to_string(),
            "--sync".to_string(),
            window_id.to_string(),
            "windowfocus".to_string(),
            "--sync".to_string(),
            window_id.to_string(),
        ];
        self.run_input_command_locked(&state, &ready, args)
            .await
            .map_err(|_| {
                DesktopProblem::window_not_found(format!("Window {window_id} not found"))
            })?;
        self.window_info_locked(&state, &ready, window_id).await
    }

    pub async fn move_window(
        &self,
        window_id: &str,
        request: crate::desktop_types::DesktopWindowMoveRequest,
    ) -> Result<DesktopWindowInfo, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = vec![
            "windowmove".to_string(),
            window_id.to_string(),
            request.x.to_string(),
            request.y.to_string(),
        ];
        self.run_input_command_locked(&state, &ready, args)
            .await
            .map_err(|_| {
                DesktopProblem::window_not_found(format!("Window {window_id} not found"))
            })?;
        self.window_info_locked(&state, &ready, window_id).await
    }

    pub async fn resize_window(
        &self,
        window_id: &str,
        request: crate::desktop_types::DesktopWindowResizeRequest,
    ) -> Result<DesktopWindowInfo, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = vec![
            "windowsize".to_string(),
            window_id.to_string(),
            request.width.to_string(),
            request.height.to_string(),
        ];
        self.run_input_command_locked(&state, &ready, args)
            .await
            .map_err(|_| {
                DesktopProblem::window_not_found(format!("Window {window_id} not found"))
            })?;
        self.window_info_locked(&state, &ready, window_id).await
    }

    async fn window_info_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        window_id: &str,
    ) -> Result<DesktopWindowInfo, DesktopProblem> {
        let active_id = self.active_window_id_locked(state, ready).await?;
        let title = self.window_title_locked(state, ready, window_id).await?;
        let (x, y, width, height) = self.window_geometry_locked(state, ready, window_id).await?;
        Ok(DesktopWindowInfo {
            id: window_id.to_string(),
            title,
            x,
            y,
            width,
            height,
            is_active: active_id
                .as_deref()
                .map(|a| a == window_id)
                .unwrap_or(false),
        })
    }

    pub async fn launch_app(
        &self,
        request: crate::desktop_types::DesktopLaunchRequest,
    ) -> Result<crate::desktop_types::DesktopLaunchResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;

        // Verify the app exists
        if find_binary(&request.app).is_none() {
            // Also try which via the desktop environment
            let check = run_command_output(
                "which",
                &[request.app.clone()],
                &ready.environment,
                INPUT_TIMEOUT,
            )
            .await;
            if check.is_err() || !check.as_ref().unwrap().status.success() {
                return Err(DesktopProblem::app_not_found(format!(
                    "Application '{}' not found in PATH",
                    request.app
                )));
            }
        }

        let args = request.args.unwrap_or_default();
        let snapshot = self
            .process_runtime
            .start_process(ProcessStartSpec {
                command: request.app.clone(),
                args,
                cwd: None,
                env: ready.environment.clone(),
                tty: false,
                interactive: false,
                owner: ProcessOwner::Desktop,
                restart_policy: None,
            })
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to launch {}: {err}", request.app),
                    None,
                    self.processes_locked(&state),
                )
            })?;

        let mut window_id = None;
        if request.wait.unwrap_or(false) {
            if let Some(pid) = snapshot.pid {
                // Poll for window to appear
                let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                let search_args = vec!["search".to_string(), "--pid".to_string(), pid.to_string()];
                loop {
                    let output = run_command_output(
                        "xdotool",
                        &search_args,
                        &ready.environment,
                        INPUT_TIMEOUT,
                    )
                    .await;
                    if let Ok(ref out) = output {
                        if out.status.success() {
                            let id = String::from_utf8_lossy(&out.stdout)
                                .lines()
                                .next()
                                .map(|s| s.trim().to_string());
                            if id.as_ref().is_some_and(|s| !s.is_empty()) {
                                window_id = id;
                                break;
                            }
                        }
                    }
                    if tokio::time::Instant::now() >= deadline {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }

        Ok(crate::desktop_types::DesktopLaunchResponse {
            process_id: snapshot.id,
            pid: snapshot.pid,
            window_id,
        })
    }

    pub async fn open_target(
        &self,
        request: crate::desktop_types::DesktopOpenRequest,
    ) -> Result<crate::desktop_types::DesktopOpenResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;

        let snapshot = self
            .process_runtime
            .start_process(ProcessStartSpec {
                command: "xdg-open".to_string(),
                args: vec![request.target],
                cwd: None,
                env: ready.environment.clone(),
                tty: false,
                interactive: false,
                owner: ProcessOwner::Desktop,
                restart_policy: None,
            })
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to open target: {err}"),
                    None,
                    self.processes_locked(&state),
                )
            })?;

        Ok(crate::desktop_types::DesktopOpenResponse {
            process_id: snapshot.id,
            pid: snapshot.pid,
        })
    }

    async fn composite_cursor(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        screenshot_bytes: Vec<u8>,
        options: &DesktopScreenshotOptions,
    ) -> Result<Vec<u8>, DesktopProblem> {
        let pos = self.mouse_position_locked(state, ready).await?;
        self.draw_cursor_on_image(screenshot_bytes, pos.x, pos.y, options, &ready.environment)
            .await
    }

    async fn composite_cursor_region(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        screenshot_bytes: Vec<u8>,
        options: &DesktopScreenshotOptions,
        region_x: i32,
        region_y: i32,
        _region_width: u32,
        _region_height: u32,
    ) -> Result<Vec<u8>, DesktopProblem> {
        let pos = self.mouse_position_locked(state, ready).await?;
        // Adjust cursor position relative to the region
        let cursor_x = pos.x - region_x;
        let cursor_y = pos.y - region_y;
        if cursor_x < 0 || cursor_y < 0 {
            // Cursor is outside the region, return screenshot as-is
            return Ok(screenshot_bytes);
        }
        self.draw_cursor_on_image(
            screenshot_bytes,
            cursor_x,
            cursor_y,
            options,
            &ready.environment,
        )
        .await
    }

    async fn draw_cursor_on_image(
        &self,
        image_bytes: Vec<u8>,
        x: i32,
        y: i32,
        options: &DesktopScreenshotOptions,
        environment: &HashMap<String, String>,
    ) -> Result<Vec<u8>, DesktopProblem> {
        // Draw a crosshair cursor using ImageMagick convert
        let draw_cmd = format!(
            "stroke red stroke-width 2 line {},{},{},{} line {},{},{},{}",
            x - 10,
            y,
            x + 10,
            y,
            x,
            y - 10,
            x,
            y + 10
        );
        let args = vec![
            "-".to_string(), // read from stdin
            "-draw".to_string(),
            draw_cmd,
            options.output_arg().to_string(),
        ];
        let output = run_command_output_with_stdin(
            "convert",
            &args,
            environment,
            SCREENSHOT_TIMEOUT,
            image_bytes.clone(),
        )
        .await
        .map_err(|err| {
            DesktopProblem::screenshot_failed(
                format!("failed to composite cursor: {err}"),
                Vec::new(),
            )
        })?;
        if !output.status.success() {
            // Fall back to returning the original screenshot without cursor
            return Ok(image_bytes);
        }
        Ok(output.stdout)
    }

    pub async fn stream_status(&self) -> DesktopStreamStatusResponse {
        self.streaming_manager.status().await
    }
}

fn desktop_problem_to_sandbox_error(problem: DesktopProblem) -> SandboxError {
    SandboxError::Conflict {
        message: problem.to_error_info().message,
    }
}

fn default_state_dir() -> PathBuf {
    if let Ok(value) = std::env::var("XDG_STATE_HOME") {
        return PathBuf::from(value).join("sandbox-agent").join("desktop");
    }
    if let Some(home) = dirs::home_dir() {
        return home
            .join(".local")
            .join("state")
            .join("sandbox-agent")
            .join("desktop");
    }
    std::env::temp_dir().join("sandbox-agent-desktop")
}

fn socket_path(display_num: i32) -> PathBuf {
    PathBuf::from(format!("/tmp/.X11-unix/X{display_num}"))
}

fn find_binary(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for path in std::env::split_paths(&path_env) {
        let candidate = path.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

async fn run_command_output(
    command: &str,
    args: &[String],
    environment: &HashMap<String, String>,
    timeout: Duration,
) -> Result<Output, String> {
    run_command_output_with_optional_stdin(command, args, environment, timeout, None).await
}

async fn run_command_output_with_stdin(
    command: &str,
    args: &[String],
    environment: &HashMap<String, String>,
    timeout: Duration,
    stdin_bytes: Vec<u8>,
) -> Result<Output, String> {
    run_command_output_with_optional_stdin(command, args, environment, timeout, Some(stdin_bytes))
        .await
}

async fn run_command_output_with_optional_stdin(
    command: &str,
    args: &[String],
    environment: &HashMap<String, String>,
    timeout: Duration,
    stdin_bytes: Option<Vec<u8>>,
) -> Result<Output, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut child = Command::new(command);
    child.args(args);
    child.envs(environment);
    child.stdin(if stdin_bytes.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    child.stdout(Stdio::piped());
    child.stderr(Stdio::piped());

    let mut child = child.spawn().map_err(|err| err.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture child stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture child stderr".to_string())?;

    let stdin_task = if let Some(bytes) = stdin_bytes {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture child stdin".to_string())?;
        Some(tokio::spawn(async move {
            stdin.write_all(&bytes).await?;
            stdin.shutdown().await
        }))
    } else {
        None
    };

    let stdout_task = tokio::spawn(async move {
        let mut stdout = stdout;
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut stderr = stderr;
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(|err| err.to_string())?,
        Err(_) => {
            terminate_child(&mut child).await?;
            if let Some(stdin_task) = stdin_task {
                let _ = stdin_task.await;
            }
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("command timed out after {}s", timeout.as_secs()));
        }
    };

    if let Some(stdin_task) = stdin_task {
        stdin_task
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string())?;
    }

    let stdout = stdout_task
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    let stderr = stderr_task
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

async fn terminate_child(child: &mut Child) -> Result<(), String> {
    if let Ok(Some(_)) = child.try_wait() {
        return Ok(());
    }
    child.start_kill().map_err(|err| err.to_string())?;
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    Ok(())
}

fn process_exists(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        return libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn parse_xrandr_resolution(bytes: &[u8]) -> Result<DesktopResolution, String> {
    let text = String::from_utf8_lossy(bytes);
    for line in text.lines() {
        if let Some(index) = line.find(" current ") {
            let tail = &line[index + " current ".len()..];
            let mut parts = tail.split(',');
            if let Some(current) = parts.next() {
                let dims: Vec<&str> = current.split_whitespace().collect();
                if dims.len() >= 3 {
                    let width = dims[0]
                        .parse::<u32>()
                        .map_err(|_| "failed to parse xrandr width".to_string())?;
                    let height = dims[2]
                        .parse::<u32>()
                        .map_err(|_| "failed to parse xrandr height".to_string())?;
                    return Ok(DesktopResolution {
                        width,
                        height,
                        dpi: None,
                    });
                }
            }
        }
    }
    Err("unable to parse xrandr current resolution".to_string())
}

fn parse_mouse_position(bytes: &[u8]) -> Result<DesktopMousePositionResponse, String> {
    let text = String::from_utf8_lossy(bytes);
    let mut x = None;
    let mut y = None;
    let mut screen = None;
    let mut window = None;
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            match key {
                "X" => x = value.parse::<i32>().ok(),
                "Y" => y = value.parse::<i32>().ok(),
                "SCREEN" => screen = value.parse::<i32>().ok(),
                "WINDOW" => window = Some(value.to_string()),
                _ => {}
            }
        }
    }
    match (x, y) {
        (Some(x), Some(y)) => Ok(DesktopMousePositionResponse {
            x,
            y,
            screen,
            window,
        }),
        _ => Err("unable to parse xdotool mouse position".to_string()),
    }
}

fn type_text_args(text: String, delay_ms: u32) -> Vec<String> {
    vec![
        "type".to_string(),
        "--delay".to_string(),
        delay_ms.to_string(),
        "--".to_string(),
        text,
    ]
}

fn press_key_args(key: String, modifiers: Option<DesktopKeyModifiers>) -> Vec<String> {
    vec![
        "key".to_string(),
        "--".to_string(),
        key_with_modifiers(key, modifiers),
    ]
}

fn key_transition_args(command: &str, key: String) -> Vec<String> {
    vec![command.to_string(), "--".to_string(), key]
}

fn key_with_modifiers(key: String, modifiers: Option<DesktopKeyModifiers>) -> String {
    let Some(modifiers) = modifiers else {
        return key;
    };

    let mut parts = Vec::new();
    if modifiers.ctrl == Some(true) {
        parts.push("ctrl");
    }
    if modifiers.shift == Some(true) {
        parts.push("shift");
    }
    if modifiers.alt == Some(true) {
        parts.push("alt");
    }
    if modifiers.cmd == Some(true) {
        parts.push("super");
    }
    parts.push(key.as_str());
    parts.join("+")
}

fn mouse_button_transition_args(
    command: &str,
    coordinates: Option<(i32, i32)>,
    button: u8,
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some((x, y)) = coordinates {
        args.push("mousemove".to_string());
        args.push(x.to_string());
        args.push(y.to_string());
    }
    args.push(command.to_string());
    args.push(button.to_string());
    args
}

fn screenshot_options(
    format: Option<DesktopScreenshotFormat>,
    quality: Option<u8>,
    scale: Option<f32>,
) -> Result<DesktopScreenshotOptions, DesktopProblem> {
    let quality = quality.unwrap_or(85);
    if !(1..=100).contains(&quality) {
        return Err(DesktopProblem::invalid_action(
            "quality must be between 1 and 100",
        ));
    }

    let scale = scale.unwrap_or(1.0);
    if !(0.1..=1.0).contains(&scale) {
        return Err(DesktopProblem::invalid_action(
            "scale must be between 0.1 and 1.0",
        ));
    }

    Ok(DesktopScreenshotOptions {
        format: format.unwrap_or(DesktopScreenshotFormat::Png),
        quality,
        scale,
    })
}

async fn maybe_convert_screenshot(
    bytes: Vec<u8>,
    options: &DesktopScreenshotOptions,
    environment: &HashMap<String, String>,
) -> Result<Vec<u8>, String> {
    if !options.needs_convert() {
        return Ok(bytes);
    }

    let mut args = vec!["png:-".to_string()];
    if (options.scale - 1.0).abs() > f32::EPSILON {
        args.push("-resize".to_string());
        args.push(format!("{:.2}%", options.scale * 100.0));
    }
    if options.format != DesktopScreenshotFormat::Png {
        args.push("-quality".to_string());
        args.push(options.quality.to_string());
    }
    args.push(options.output_arg().to_string());

    let output =
        run_command_output_with_stdin("convert", &args, environment, SCREENSHOT_TIMEOUT, bytes)
            .await?;
    if !output.status.success() {
        return Err(format!(
            "desktop screenshot conversion failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn validate_image_bytes(bytes: &[u8], format: DesktopScreenshotFormat) -> Result<(), String> {
    match format {
        DesktopScreenshotFormat::Png => {
            if bytes.len() < PNG_SIGNATURE.len() || &bytes[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
                return Err("desktop screenshot did not return PNG bytes".to_string());
            }
        }
        DesktopScreenshotFormat::Jpeg => {
            if bytes.len() < JPEG_SIGNATURE.len()
                || &bytes[..JPEG_SIGNATURE.len()] != JPEG_SIGNATURE
            {
                return Err("desktop screenshot did not return JPEG bytes".to_string());
            }
        }
        DesktopScreenshotFormat::Webp => {
            if bytes.len() < 12
                || &bytes[..WEBP_RIFF_SIGNATURE.len()] != WEBP_RIFF_SIGNATURE
                || &bytes[8..12] != WEBP_WEBP_SIGNATURE
            {
                return Err("desktop screenshot did not return WebP bytes".to_string());
            }
        }
    }
    Ok(())
}

fn validate_start_request(width: u32, height: u32, dpi: u32) -> Result<(), DesktopProblem> {
    if width == 0 || height == 0 {
        return Err(DesktopProblem::invalid_action(
            "Desktop width and height must be greater than 0",
        ));
    }
    if dpi == 0 {
        return Err(DesktopProblem::invalid_action(
            "Desktop dpi must be greater than 0",
        ));
    }
    Ok(())
}

fn validate_region(query: &DesktopRegionScreenshotQuery) -> Result<(), DesktopProblem> {
    validate_coordinates(query.x, query.y)?;
    if query.width == 0 || query.height == 0 {
        return Err(DesktopProblem::invalid_action(
            "Screenshot region width and height must be greater than 0",
        ));
    }
    Ok(())
}

fn validate_optional_coordinates(
    x: Option<i32>,
    y: Option<i32>,
) -> Result<Option<(i32, i32)>, DesktopProblem> {
    match (x, y) {
        (Some(x), Some(y)) => {
            validate_coordinates(x, y)?;
            Ok(Some((x, y)))
        }
        (None, None) => Ok(None),
        _ => Err(DesktopProblem::invalid_action(
            "x and y must both be provided when setting coordinates",
        )),
    }
}

fn validate_coordinates(x: i32, y: i32) -> Result<(), DesktopProblem> {
    if x < 0 || y < 0 {
        return Err(DesktopProblem::invalid_action(
            "Desktop coordinates must be non-negative",
        ));
    }
    Ok(())
}

fn mouse_button_code(button: DesktopMouseButton) -> u8 {
    match button {
        DesktopMouseButton::Left => 1,
        DesktopMouseButton::Middle => 2,
        DesktopMouseButton::Right => 3,
    }
}

fn append_scroll_clicks(
    args: &mut Vec<String>,
    delta: i32,
    positive_button: u8,
    negative_button: u8,
) {
    if delta == 0 {
        return;
    }
    let button = if delta > 0 {
        positive_button
    } else {
        negative_button
    };
    let repeat = delta.unsigned_abs();
    args.push("click".to_string());
    if repeat > 1 {
        args.push("--repeat".to_string());
        args.push(repeat.to_string());
    }
    args.push(button.to_string());
}

fn parse_window_geometry(bytes: &[u8]) -> Result<(i32, i32, u32, u32), String> {
    let text = String::from_utf8_lossy(bytes);
    let mut position = None;
    let mut geometry = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("Position:") {
            let coordinate_text = value
                .trim()
                .split_whitespace()
                .next()
                .ok_or_else(|| "unable to parse window position".to_string())?;
            let (x, y) = coordinate_text
                .split_once(',')
                .ok_or_else(|| "unable to parse window position".to_string())?;
            let x = x
                .parse::<i32>()
                .map_err(|_| "failed to parse window x coordinate".to_string())?;
            let y = y
                .parse::<i32>()
                .map_err(|_| "failed to parse window y coordinate".to_string())?;
            position = Some((x, y));
        }
        if let Some(value) = trimmed.strip_prefix("Geometry:") {
            let (width, height) = value
                .trim()
                .split_once('x')
                .ok_or_else(|| "unable to parse window geometry".to_string())?;
            let width = width
                .parse::<u32>()
                .map_err(|_| "failed to parse window width".to_string())?;
            let height = height
                .parse::<u32>()
                .map_err(|_| "failed to parse window height".to_string())?;
            geometry = Some((width, height));
        }
    }

    match (position, geometry) {
        (Some((x, y)), Some((width, height))) => Ok((x, y, width, height)),
        _ => Err("unable to parse xdotool window geometry".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_xrandr_resolution_reads_current_geometry() {
        let bytes = b"Screen 0: minimum 1 x 1, current 1440 x 900, maximum 32767 x 32767\n";
        let parsed = parse_xrandr_resolution(bytes).expect("parse resolution");
        assert_eq!(parsed.width, 1440);
        assert_eq!(parsed.height, 900);
    }

    #[test]
    fn parse_mouse_position_reads_shell_output() {
        let bytes = b"X=123\nY=456\nSCREEN=0\nWINDOW=0\n";
        let parsed = parse_mouse_position(bytes).expect("parse mouse position");
        assert_eq!(parsed.x, 123);
        assert_eq!(parsed.y, 456);
        assert_eq!(parsed.screen, Some(0));
        assert_eq!(parsed.window.as_deref(), Some("0"));
    }

    #[test]
    fn png_validation_rejects_non_png_bytes() {
        let error = validate_image_bytes(b"not png", DesktopScreenshotFormat::Png)
            .expect_err("validation should fail");
        assert!(error.contains("PNG"));
    }

    #[test]
    fn type_text_args_insert_double_dash_before_user_text() {
        let args = type_text_args("--help".to_string(), 5);
        assert_eq!(args, vec!["type", "--delay", "5", "--", "--help"]);
    }

    #[test]
    fn press_key_args_insert_double_dash_before_user_key() {
        let args = press_key_args("--help".to_string(), None);
        assert_eq!(args, vec!["key", "--", "--help"]);
    }

    #[test]
    fn press_key_args_builds_key_sequence_from_modifiers() {
        let args = press_key_args(
            "a".to_string(),
            Some(DesktopKeyModifiers {
                ctrl: Some(true),
                shift: Some(true),
                alt: Some(false),
                cmd: None,
            }),
        );
        assert_eq!(args, vec!["key", "--", "ctrl+shift+a"]);
    }

    #[test]
    fn append_scroll_clicks_uses_positive_direction_buttons() {
        let mut args = Vec::new();
        append_scroll_clicks(&mut args, 2, 5, 4);
        append_scroll_clicks(&mut args, -3, 7, 6);
        assert_eq!(
            args,
            vec!["click", "--repeat", "2", "5", "click", "--repeat", "3", "6"]
        );
    }

    #[test]
    fn parse_window_geometry_reads_xdotool_output() {
        let bytes = b"Window 123\n  Position: 400,300 (screen: 0)\n  Geometry: 1440x900\n";
        let parsed = parse_window_geometry(bytes).expect("parse geometry");
        assert_eq!(parsed, (400, 300, 1440, 900));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_command_output_kills_child_on_timeout() {
        let pid_file = std::env::temp_dir().join(format!(
            "sandbox-agent-desktop-runtime-timeout-{}.pid",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&pid_file);
        let command = format!("echo $$ > {}; exec sleep 30", pid_file.display());
        let args = vec!["-c".to_string(), command];

        let error = run_command_output("sh", &args, &HashMap::new(), Duration::from_millis(200))
            .await
            .expect_err("command should time out");
        assert!(error.contains("timed out"));

        let pid = std::fs::read_to_string(&pid_file)
            .expect("pid file should exist")
            .trim()
            .parse::<u32>()
            .expect("pid should parse");

        for _ in 0..20 {
            if !process_exists(pid) {
                let _ = std::fs::remove_file(&pid_file);
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let _ = std::fs::remove_file(&pid_file);
        panic!("timed out child process {pid} still exists after timeout cleanup");
    }
}
