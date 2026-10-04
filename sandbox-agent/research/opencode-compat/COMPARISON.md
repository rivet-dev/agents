# Native OpenCode vs Sandbox-Agent: OpenCode API Comparison

## Overview

Captured API output from both native OpenCode server (v1.1.49) and sandbox-agent's
OpenCode compatibility layer, sending identical request patterns:
1. Message 1: Simple text response (echo/text)
2. Message 2: Tool call (ls/mock.search)

## Bugs Found and Fixed

### 1. Tool name (`tool` field) changed between events [FIXED]

**Bug**: The `tool` field in tool part events changed between `pending` and `running`/`completed`
states. In the `pending` event it correctly showed `"mock.search"`, but in subsequent events
(from ToolResult) it showed `"tool"` because `extract_tool_content` doesn't return tool_name
for ToolResult items.

**Fix**: Added `tool_name_by_call` HashMap to `OpenCodeSessionRuntime` to persist tool names
from ToolCall events and look them up during ToolResult processing.

### 2. Tool `input` lost on ToolResult events [FIXED]

**Bug**: When the ToolResult event came in, the tool's input arguments were lost because
ToolResult content only contains `call_id` and `output`, not arguments.

**Fix**: Added `tool_args_by_call` HashMap to `OpenCodeSessionRuntime` to persist arguments
from ToolCall events and look them up during ToolResult processing.

### 3. Tool `output` in wrong field (`error` instead of `output`) [FIXED]

**Bug**: When tool result status was `Failed`, the output text was put in `"error"` field.
Native OpenCode uses `"output"` field for tool output regardless of success/failure.

**Fix**: Changed the failed tool result JSON to use `"output"` instead of `"error"`.

### 4. Text doubling in streaming [FIXED]

**Bug**: During text streaming, `ItemStarted` emitted a text part with full content, then
`ItemDelta` appended delta text, then `ItemCompleted` emitted again, causing doubled text.

**Fix**: `ItemStarted` now only initializes empty text in runtime without emitting a part event.
`ItemCompleted` emits the final text using accumulated delta text or fallback to content text.

### 5. Missing `delta` field in text streaming events [FIXED]

**Bug**: `delta` field was not included in `message.part.updated` events for text streaming.
Native OpenCode includes `delta` on streaming events and omits it on the final event.

**Fix**: Changed `apply_item_delta` to use `part_event_with_delta` instead of `part_event`.

### 6. Not bugs (noted for completeness)

- **Missing `step-start`/`step-finish` parts**: These are OpenCode-specific (git snapshot
  tracking) and not expected from sandbox-agent.
- **Missing `time` on text parts**: Minor; could be added in future.
- **Missing `time.completed` on some assistant messages**: Minor timing issue.

## Verification

After fixes, all tool events now correctly show:
- `"tool": "mock.search"` across all states (pending, running, error)
- `"input": {"query": "example"}` preserved across all states
- `"output": "mock search results"` on the error event (not `"error"`)
- Text streaming includes `delta` field
- No text doubling

All 28 OpenCode compat tests pass.
All 10 session snapshot tests pass.
All 3 HTTP endpoint tests pass.
