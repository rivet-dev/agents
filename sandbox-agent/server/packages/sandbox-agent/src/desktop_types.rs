use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopState {
    Inactive,
    InstallRequired,
    Starting,
    Active,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResolution {
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dpi: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopErrorInfo {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProcessInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatusResponse {
    pub state: DesktopState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<DesktopResolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<DesktopErrorInfo>,
    #[serde(default)]
    pub missing_dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    #[serde(default)]
    pub processes: Vec<DesktopProcessInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_log_path: Option<String>,
    /// Current visible windows (included when the desktop is active).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<DesktopWindowInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, IntoParams, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStartRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dpi: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_num: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_video_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_audio_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_frame_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webrtc_port_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_fps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, IntoParams, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopScreenshotQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<DesktopScreenshotFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_cursor: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopScreenshotFormat {
    Png,
    Jpeg,
    Webp,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRegionScreenshotQuery {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<DesktopScreenshotFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_cursor: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMousePositionResponse {
    pub x: i32,
    pub y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopMouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseMoveRequest {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseClickRequest {
    pub x: i32,
    pub y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<DesktopMouseButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub click_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseDownRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<DesktopMouseButton>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseUpRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<DesktopMouseButton>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseDragRequest {
    pub start_x: i32,
    pub start_y: i32,
    pub end_x: i32,
    pub end_y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<DesktopMouseButton>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseScrollRequest {
    pub x: i32,
    pub y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_y: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopKeyboardTypeRequest {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopKeyboardPressRequest {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<DesktopKeyModifiers>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopKeyModifiers {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctrl: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shift: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmd: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopKeyboardDownRequest {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopKeyboardUpRequest {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActionResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDisplayInfoResponse {
    pub display: String,
    pub resolution: DesktopResolution,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowInfo {
    pub id: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowListResponse {
    pub windows: Vec<DesktopWindowInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRecordingStartRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopRecordingStatus {
    Recording,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRecordingInfo {
    pub id: String,
    pub status: DesktopRecordingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    pub file_name: String,
    pub bytes: u64,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRecordingListResponse {
    pub recordings: Vec<DesktopRecordingInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStreamStatusResponse {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardResponse {
    pub text: String,
    pub selection: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, IntoParams, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardWriteRequest {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLaunchRequest {
    pub app: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLaunchResponse {
    pub process_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenRequest {
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenResponse {
    pub process_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowMoveRequest {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowResizeRequest {
    pub width: u32,
    pub height: u32,
}
