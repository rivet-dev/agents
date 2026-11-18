# Feature 14: Message Attachments

**Implementation approach:** ACP extension via `_meta` in `session/prompt`

## Summary

v1 `MessageRequest.attachments` allowed sending file attachments (path, mime, filename) with prompts. v1 ACP `embeddedContext` is only partial. Need to support file attachments in prompt messages.

## Current v1 State

- ACP `session/prompt` accepts `params.content` as the prompt text
- No attachment mechanism in the current ACP prompt flow
- `embeddedContext` in ACP is for inline context, not file references
- The runtime currently passes prompt content through to the agent process as-is

## v1 Reference (source commit)

Port behavior from commit `8ecd27bc24e62505d7aa4c50cbdd1c9dbb09f836`.

## v1 Types

```rust
#[derive(Debug, Deserialize, JsonSchema, ToSchema)]
pub struct MessageRequest {
    pub message: String,
    pub attachments: Option<Vec<MessageAttachment>>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, ToSchema)]
pub struct MessageAttachment {
    pub path: String,
    pub mime: Option<String>,
    pub filename: Option<String>,
}
```

## v1 Attachment Processing (from `router.rs`)

```rust
fn format_message_with_attachments(message: &str, attachments: &[MessageAttachment]) -> String {
    if attachments.is_empty() {
        return message.to_string();
    }
    let mut combined = String::new();
    combined.push_str(message);
    combined.push_str("\n\nAttachments:\n");
    for attachment in attachments {
        combined.push_str("- ");
        combined.push_str(&attachment.path);
        combined.push('\n');
    }
    combined
}

fn opencode_file_part_input(attachment: &MessageAttachment) -> Value {
    let path = attachment.path.as_str();
    let url = if path.starts_with("file://") {
        path.to_string()
    } else {
        format!("file://{path}")
    };
    let filename = attachment.filename.clone().or_else(|| {
        let clean = path.strip_prefix("file://").unwrap_or(path);
        StdPath::new(clean)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
    });
    let mut map = serde_json::Map::new();
    map.insert("type".to_string(), json!("file"));
    map.insert("mime".to_string(), json!(attachment.mime.clone()
        .unwrap_or_else(|| "application/octet-stream".to_string())));
    map.insert("url".to_string(), json!(url));
    if let Some(filename) = filename {
        map.insert("filename".to_string(), json!(filename));
    }
    Value::Object(map)
}
```

### Per-Agent Handling

- **Claude**: Attachments appended as text to the prompt message (basic)
- **OpenCode**: Attachments converted to `file://` URIs in the `input` array using `opencode_file_part_input()`
- **Codex**: Attachments converted to file references in the Codex request format

## Implementation Plan

### Extension via `_meta` in `session/prompt`

Attachments are passed in `_meta.sandboxagent.dev.attachments`:

```json
{
  "method": "session/prompt",
  "params": {
    "content": "Review this file",
    "_meta": {
      "sandboxagent.dev": {
        "attachments": [
          {
            "path": "/workspace/file.py",
            "mime": "text/x-python",
            "filename": "file.py"
          }
        ]
      }
    }
  }
}
```

### Runtime Processing

The runtime extracts attachments from `_meta` and transforms them per agent:
1. **ACP-native agents**: Forward attachments in `_meta` — the agent process handles them
2. **Non-ACP fallback**: Append attachment paths to prompt text (like v1 Claude behavior)

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Extract `attachments` from `session/prompt` `_meta`; transform per agent before forwarding |
| `server/packages/sandbox-agent/src/acp_runtime/mock.rs` | Add mock handling for attachments |
| `sdks/typescript/src/client.ts` | Add `attachments` option to prompt method |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Add attachment prompt test |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/sdks/typescript.mdx` | Document attachment support in prompts |
| `research/acp/spec.md` | Document attachment extension behavior |
