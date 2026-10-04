use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct UniversalEvent {
    pub event_id: String,
    pub sequence: u64,
    pub time: String,
    pub session_id: String,
    pub native_session_id: Option<String>,
    pub synthetic: bool,
    pub source: EventSource,
    #[serde(rename = "type")]
    pub event_type: UniversalEventType,
    pub data: UniversalEventData,
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Agent,
    Daemon,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
pub enum UniversalEventType {
    #[serde(rename = "session.started")]
    SessionStarted,
    #[serde(rename = "session.ended")]
    SessionEnded,
    #[serde(rename = "turn.started")]
    TurnStarted,
    #[serde(rename = "turn.ended")]
    TurnEnded,
    #[serde(rename = "item.started")]
    ItemStarted,
    #[serde(rename = "item.delta")]
    ItemDelta,
    #[serde(rename = "item.completed")]
    ItemCompleted,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "permission.requested")]
    PermissionRequested,
    #[serde(rename = "permission.resolved")]
    PermissionResolved,
    #[serde(rename = "question.requested")]
    QuestionRequested,
    #[serde(rename = "question.resolved")]
    QuestionResolved,
    #[serde(rename = "agent.unparsed")]
    AgentUnparsed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(untagged)]
pub enum UniversalEventData {
    Turn(TurnEventData),
    SessionStarted(SessionStartedData),
    SessionEnded(SessionEndedData),
    Item(ItemEventData),
    ItemDelta(ItemDeltaData),
    Error(ErrorData),
    Permission(PermissionEventData),
    Question(QuestionEventData),
    AgentUnparsed(AgentUnparsedData),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct SessionStartedData {
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct SessionEndedData {
    pub reason: SessionEndReason,
    pub terminated_by: TerminatedBy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<StderrOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct TurnEventData {
    pub phase: TurnPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnPhase {
    Started,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct StderrOutput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionEndReason {
    Completed,
    Error,
    Terminated,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminatedBy {
    Agent,
    Daemon,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct ItemEventData {
    pub item: UniversalItem,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct ItemDeltaData {
    pub item_id: String,
    pub native_item_id: Option<String>,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct ErrorData {
    pub message: String,
    pub code: Option<String>,
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct AgentUnparsedData {
    pub error: String,
    pub location: String,
    pub raw_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct PermissionEventData {
    pub permission_id: String,
    pub action: String,
    pub status: PermissionStatus,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    Requested,
    Accept,
    AcceptForSession,
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct QuestionEventData {
    pub question_id: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub response: Option<String>,
    pub status: QuestionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    Requested,
    Answered,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct UniversalItem {
    pub item_id: String,
    pub native_item_id: Option<String>,
    pub parent_id: Option<String>,
    pub kind: ItemKind,
    pub role: Option<ItemRole>,
    pub content: Vec<ContentPart>,
    pub status: ItemStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Message,
    ToolCall,
    ToolResult,
    System,
    Status,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ItemRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    Json {
        json: Value,
    },
    ToolCall {
        name: String,
        arguments: String,
        call_id: String,
    },
    ToolResult {
        call_id: String,
        output: String,
    },
    FileRef {
        path: String,
        action: FileAction,
        diff: Option<String>,
    },
    Reasoning {
        text: String,
        visibility: ReasoningVisibility,
    },
    Image {
        path: String,
        mime: Option<String>,
    },
    Status {
        label: String,
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileAction {
    Read,
    Write,
    Patch,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningVisibility {
    Public,
    Private,
}
