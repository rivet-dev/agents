# Type definitions for coding agent CLIs in SDK mode

Four major coding agent CLIs now offer programmatic access through TypeScript SDKs with well-defined type systems. **OpenCode provides the most complete formal specification** with a published OpenAPI 3.1.1 schema, while Claude Code and Codex offer comprehensive TypeScript types through npm packages. All four tools use similar patterns: streaming events via JSON lines, discriminated union types for messages, and structured configuration schemas.

## Codex CLI has TypeScript SDK but no formal schema

OpenAI's Codex CLI provides programmatic control through the **`@openai/codex-sdk`** package, which wraps the bundled binary and exchanges JSONL events over stdin/stdout. Types are well-defined in source code but not published as JSON Schema or OpenAPI specifications.

**Core SDK types from `@openai/codex-sdk`:**

```typescript
interface CodexOptions {
  codexPathOverride?: string;
  baseURL?: string;
  apiKey?: string;
  env?: Record<string, string>;
}

interface ThreadOptions {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
}

interface TurnOptions {
  outputSchema?: Record<string, unknown>;  // JSON Schema for structured output
}

type Input = string | UserInput[];
interface UserInput {
  type: "text" | "local_image";
  text?: string;
  path?: string;
}
```

**Event types for streaming (`runStreamed()`):**

```typescript
type EventType = "thread.started" | "turn.started" | "turn.completed" | 
                 "turn.failed" | "item.started" | "item.updated" | 
                 "item.completed" | "error";

interface ThreadEvent {
  type: EventType;
  thread_id?: string;
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  error?: { message: string };
  item?: ThreadItem;
}

type ItemType = "agent_message" | "reasoning" | "command_execution" | 
                "file_change" | "mcp_tool_call" | "web_search" | 
                "todo_list" | "error" | "unknown";
```

**Key source files:** `sdk/typescript/src/` contains `items.ts`, `events.ts`, `options.ts`, `input.ts`, and `thread.ts`. Documentation at https://developers.openai.com/codex/sdk/ and https://developers.openai.com/codex/noninteractive/.

---

## Claude Code SDK offers the most comprehensive TypeScript types

Now rebranded as the **Claude Agent SDK**, the official package `@anthropic-ai/claude-agent-sdk` provides production-ready types with full coverage of tools, hooks, permissions, and streaming events.

**Core query function and options:**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

interface Options {
  cwd?: string;
  model?: string;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  maxTurns?: number;
  maxBudgetUsd?: number;
  outputFormat?: { type: 'json_schema', schema: JSONSchema };
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  sandbox?: SandboxSettings;
  // ... 30+ additional options
}
```

**Message types (SDK output):**

```typescript
type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKResultMessage | 
                  SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage;

type SDKResultMessage = {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 
           'error_max_budget_usd' | 'error_max_structured_output_retries';
  uuid: UUID;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result?: string;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number; /* ... */ };
  modelUsage: { [modelName: string]: ModelUsage };
  structured_output?: unknown;
  errors?: string[];
};
```

**Built-in tool input types:**

```typescript
type ToolInput = AgentInput | BashInput | FileEditInput | FileReadInput | 
                 FileWriteInput | GlobInput | GrepInput | WebFetchInput | 
                 WebSearchInput | /* ... 10+ more */;

interface BashInput {
  command: string;
  timeout?: number;  // Max 600000ms
  description?: string;
  run_in_background?: boolean;
}

interface FileEditInput {
  file_path: string;  // Absolute path
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
```

**Source:** https://github.com/anthropics/claude-agent-sdk-typescript and https://platform.claude.com/docs/en/agent-sdk/typescript

---

## OpenCode provides a full OpenAPI specification

The sst/opencode project is the **only CLI with a published OpenAPI 3.1.1 specification**, enabling automatic client generation. Types are auto-generated from the spec using `@hey-api/openapi-ts`.

**Key resources:**
- **OpenAPI spec:** `packages/sdk/openapi.json` at https://github.com/sst/opencode/blob/dev/packages/sdk/openapi.json
- **Generated types:** `packages/sdk/js/src/gen/types.gen.ts`
- **npm packages:** `@opencode-ai/sdk` and `@opencode-ai/plugin`

**Core types from the SDK:**

```typescript
interface Session {
  id: string;  // Pattern: ^ses.*
  version: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  time: { created: number; updated: number; compacting?: number; archived?: number };
}

type Message = UserMessage | AssistantMessage;

interface AssistantMessage {
  id: string;
  role: "assistant";
  sessionID: string;
  error?: NamedError;
  tokens: { input: number; output: number; cache: { read: number; write: number } };
  cost: { input: number; output: number };
  modelID: string;
  providerID: string;
}

type Part = TextPart | ReasoningPart | ToolPart | FilePart | AgentPart | 
            StepStartPart | StepFinishPart | SnapshotPart | PatchPart | RetryPart;
```

**SSE event types:**

```typescript
type Event = 
  | { type: "session.created"; properties: { session: Session } }
  | { type: "session.updated"; properties: { session: Session } }
  | { type: "message.updated"; properties: { message: Message } }
  | { type: "message.part.updated"; properties: { part: Part } }
  | { type: "permission.asked"; properties: { permission: Permission } }
  | { type: "pty.created"; properties: { pty: Pty } }
  // 30+ total event types
```

**Plugin system types (`@opencode-ai/plugin`):**

```typescript
type Plugin = (ctx: PluginInput) => Promise<Hooks>;

interface Hooks {
  event?: (input: { event: Event }) => Promise<void>;
  tool?: { [key: string]: ToolDefinition };
  "tool.execute.before"?: (input, output) => Promise<void>;
  "tool.execute.after"?: (input, output) => Promise<void>;
  stop?: (input: { sessionID: string }) => Promise<{ continue?: boolean }>;
}
```

---

## Amp CLI documents stream JSON schema in manual

Sourcegraph's Amp provides `@sourcegraph/amp-sdk` with documented TypeScript types, though the package source is closed. The **stream JSON schema is fully documented** at https://ampcode.com/manual/appendix.

**Complete StreamJSONMessage type:**

```typescript
type StreamJSONMessage =
  | {
      type: "assistant";
      message: {
        type: "message";
        role: "assistant";
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
          | { type: "thinking"; thinking: string }
          | { type: "redacted_thinking"; data: string }
        >;
        stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
        usage?: { input_tokens: number; output_tokens: number; /* ... */ };
      };
      parent_tool_use_id: string | null;
      session_id: string;
    }
  | {
      type: "user";
      message: {
        role: "user";
        content: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }>;
      };
      parent_tool_use_id: string | null;
      session_id: string;
    }
  | {
      type: "result";
      subtype: "success";
      duration_ms: number;
      is_error: false;
      num_turns: number;
      result: string;
      session_id: string;
    }
  | {
      type: "system";
      subtype: "init";
      cwd: string;
      session_id: string;
      tools: string[];
      mcp_servers: { name: string; status: "connected" | "connecting" | "connection-failed" | "disabled" }[];
    };
```

**SDK execute function:**

```typescript
import { execute, type AmpOptions, type MCPConfig } from '@sourcegraph/amp-sdk';

interface AmpOptions {
  cwd?: string;
  dangerouslyAllowAll?: boolean;
  toolbox?: string;
  mcpConfig?: MCPConfig;
  permissions?: PermissionRule[];
  continue?: boolean | string;
}

interface PermissionRule {
  tool: string;  // Glob pattern like "Bash", "mcp__playwright__*"
  matches?: { [argumentName: string]: string | string[] | boolean };
  action: "allow" | "reject" | "ask" | "delegate";
  context?: "thread" | "subagent";
}
```

Documentation at https://ampcode.com/manual/sdk and npm package at https://www.npmjs.com/package/@sourcegraph/amp-sdk.

---

## Comparing schema availability across all four CLIs

| CLI | TypeScript Types | OpenAPI/JSON Schema | Source Available |
|-----|------------------|---------------------|------------------|
| **Codex** | ✅ Full SDK types | ❌ None published | ✅ GitHub |
| **Claude Code** | ✅ Comprehensive | ❌ None published | ✅ GitHub |
| **OpenCode** | ✅ Auto-generated | ✅ **OpenAPI 3.1.1** | ✅ GitHub |
| **Amp** | ✅ Documented types | ❌ None published | ❌ Closed |

**Common patterns across all SDKs:**

All four tools share remarkably similar architectural patterns. They use discriminated union types for messages (user, assistant, system, result), JSONL streaming for real-time output, session/thread-based conversation management, MCP server integration with identical config shapes, and permission systems with allow/deny/ask actions.

**For maximum type safety**, OpenCode is the only option with a formal OpenAPI specification that enables automatic client generation in any language. Claude Code provides the most comprehensive TypeScript-native types with **35+ option fields** and full hook/plugin typing. Codex types are well-structured but require importing from source. Amp types are documented but not directly inspectable in source code.

## Conclusion

Developers building integrations should prioritize **OpenCode for formal schema needs** (OpenAPI enables code generation) and **Claude Code for TypeScript-first development** (most complete type exports). All four SDKs are actively maintained and converging on similar patterns, suggesting a de facto standard for coding agent interfaces is emerging around discriminated message unions, streaming events, and permission-based tool control.
