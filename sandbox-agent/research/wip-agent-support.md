# Universal Agent Configuration Support

Work-in-progress research on configuration features across agents and what can be made universal.

---

## TODO: Features Needed for Full Coverage

### Currently Implemented (in `CreateSessionRequest`)

- [x] `agent` - Agent selection (claude, codex, opencode, amp)
- [x] `agentMode` - Agent mode (plan, build, default)
- [x] `permissionMode` - Permission mode (default, plan, bypass)
- [x] `model` - Model selection
- [x] `variant` - Reasoning variant
- [x] `agentVersion` - Agent version selection
- [x] `mcp` - MCP server configuration (Claude/Codex/OpenCode/Amp)
- [x] `skills` - Skill path configuration (link or copy into agent skill roots)

### Tier 1: Universal Features (High Priority)

- [ ] `projectInstructions` - Inject CLAUDE.md / AGENTS.md content
  - Write to appropriate file before agent spawn
  - All agents support this natively
- [ ] `workingDirectory` - Set working directory for session
  - Currently captures server `cwd` on session creation; not yet user-configurable
- [x] `mcp` - MCP server configuration
  - Claude: Writes `.mcp.json` entries under `mcpServers`
  - Codex: Updates `.codex/config.toml` with `mcp_servers`
  - Amp: Calls `amp mcp add` for each server
  - OpenCode: Uses `/mcp` API
- [x] `skills` - Skill path configuration
  - Claude: Link to `./.claude/skills/<name>/`
  - Codex: Link to `./.agents/skills/<name>/`
  - OpenCode: Link to `./.opencode/skill/<name>/` + config `skills.paths`
  - Amp: Link to Claude/Codex-style directories
- [ ] `credentials` - Pass credentials via API (not just env vars)
  - Currently extracted from host env
  - Need API-level credential injection

### Filesystem API (Implemented)

- [x] `/v1/fs` - Read/write/list/move/delete/stat files and upload batches
  - Batch upload is tar-only (`application/x-tar`) with path output capped at 1024
  - Relative paths resolve from session working dir when `sessionId` is provided
  - CLI `sandbox-agent api fs ...` covers all filesystem endpoints

### Message Attachments (Implemented)

- [x] `MessageRequest.attachments` - Attach uploaded files when sending prompts
  - OpenCode receives file parts; other agents get attachment paths appended to the prompt

### Tier 2: Partial Support (Medium Priority)

- [ ] `appendSystemPrompt` - High-priority system prompt additions
  - Claude: `--append-system-prompt` flag
  - Codex: `developer_instructions` config
  - OpenCode: Custom agent definition
  - Amp: Not supported (fallback to projectInstructions)
- [ ] `resumeSession` / native session resume
  - Claude: `--resume SESSION_ID`
  - Codex: Thread persistence (automatic)
  - OpenCode: `-c/--continue`
  - Amp: `--continue SESSION_ID`

### Tier 3: Agent-Specific Pass-through (Low Priority)

- [ ] `agentSpecific.claude` - Raw Claude options
- [ ] `agentSpecific.codex` - Raw Codex options (e.g., `replaceSystemPrompt`)
- [ ] `agentSpecific.opencode` - Raw OpenCode options (e.g., `customAgent`)
- [ ] `agentSpecific.amp` - Raw Amp options (e.g., `permissionRules`)

### Event/Feature Coverage Gaps (from compatibility matrix)

| Feature | Claude | Codex | OpenCode | Amp | Status |
|---------|--------|-------|----------|-----|--------|
| Tool Calls | —* | ✓ | ✓ | ✓ | Claude coming soon |
| Tool Results | —* | ✓ | ✓ | ✓ | Claude coming soon |
| Questions (HITL) | —* | — | ✓ | — | Only OpenCode |
| Permissions (HITL) | —* | — | ✓ | — | Only OpenCode |
| Images | — | ✓ | ✓ | — | 2/4 agents |
| File Attachments | — | ✓ | ✓ | — | 2/4 agents |
| Session Lifecycle | — | ✓ | ✓ | — | 2/4 agents |
| Reasoning/Thinking | — | ✓ | — | — | Codex only |
| Command Execution | — | ✓ | — | — | Codex only |
| File Changes | — | ✓ | — | — | Codex only |
| MCP Tools | ✓ | ✓ | ✓ | ✓ | Supported via session MCP config injection |
| Streaming Deltas | — | ✓ | ✓ | — | 2/4 agents |

\* Claude features marked as "coming imminently"

### Implementation Order (Suggested)

1. **mcp** - Done (session config injection + agent config writers)
2. **skills** - Done (session config injection + skill directory linking)
3. **projectInstructions** - Highest value, all agents support
4. **appendSystemPrompt** - High-priority instructions
5. **workingDirectory** - Basic session configuration
6. **resumeSession** - Session continuity
7. **credentials** - API-level auth injection
8. **agentSpecific** - Escape hatch for edge cases

---

## Legend

- ✅ Native support
- 🔄 Can be adapted/emulated
- ❌ Not supported
- ⚠️ Supported with caveats

---

## 1. Instructions & System Prompt

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **Project instructions file** | ✅ `CLAUDE.md` | ✅ `AGENTS.md` | 🔄 Config-based | ⚠️ Limited | ✅ Yes - write to agent's file |
| **Append to system prompt** | ✅ `--append-system-prompt` | ✅ `developer_instructions` | 🔄 Custom agent | ❌ | ⚠️ Partial - 3/4 agents |
| **Replace system prompt** | ❌ | ✅ `model_instructions_file` | 🔄 Custom agent | ❌ | ❌ No - Codex only |
| **Hierarchical discovery** | ✅ cwd → root | ✅ root → cwd | ❌ | ❌ | ❌ No - Claude/Codex only |

### Priority Comparison

| Agent | Priority Order (highest → lowest) |
|-------|-----------------------------------|
| Claude | `--append-system-prompt` > base prompt > `CLAUDE.md` |
| Codex | `AGENTS.md` > `developer_instructions` > base prompt |
| OpenCode | Custom agent prompt > base prompt |
| Amp | Server-controlled (opaque) |

### Key Differences

**Claude**: System prompt additions have highest priority. `CLAUDE.md` is injected as first user message (below system prompt).

**Codex**: Project instructions (`AGENTS.md`) have highest priority and can override system prompt. This is the inverse of Claude's model.

---

## 2. Permission Modes

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **Read-only** | ✅ `plan` | ✅ `read-only` | 🔄 Rulesets | 🔄 Rules | ✅ Yes |
| **Write workspace** | ✅ `acceptEdits` | ✅ `workspace-write` | 🔄 Rulesets | 🔄 Rules | ✅ Yes |
| **Full bypass** | ✅ `--dangerously-skip-permissions` | ✅ `danger-full-access` | 🔄 Allow-all ruleset | ✅ `--dangerously-skip-permissions` | ✅ Yes |
| **Per-tool rules** | ❌ | ❌ | ✅ | ✅ | ❌ No - OpenCode/Amp only |

### Universal Mapping

```typescript
type PermissionMode = "readonly" | "write" | "bypass";

// Maps to:
// Claude: plan | acceptEdits | --dangerously-skip-permissions
// Codex: read-only | workspace-write | danger-full-access
// OpenCode: restrictive ruleset | permissive ruleset | allow-all
// Amp: reject rules | allow rules | dangerouslyAllowAll
```

---

## 3. Agent Modes

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **Plan mode** | ✅ `--permission-mode plan` | 🔄 Prompt prefix | ✅ `--agent plan` | 🔄 Mode selection | ✅ Yes |
| **Build/execute mode** | ✅ Default | ✅ Default | ✅ `--agent build` | ✅ Default | ✅ Yes |
| **Chat mode** | ❌ | 🔄 Prompt prefix | ❌ | ❌ | ❌ No - Codex only |
| **Custom agents** | ❌ | ❌ | ✅ Config-defined | ❌ | ❌ No - OpenCode only |

---

## 4. Model & Variant Selection

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **Model selection** | ✅ `--model` | ✅ `-m/--model` | ✅ `-m provider/model` | ⚠️ `--mode` (abstracted) | ⚠️ Partial |
| **Model discovery API** | ✅ Anthropic API | ✅ `model/list` RPC | ✅ `GET /provider` | ❌ Server-side | ⚠️ Partial - 3/4 |
| **Reasoning variants** | ❌ | ✅ `model_reasoning_effort` | ✅ `--variant` | ✅ Deep mode levels | ⚠️ Partial |

---

## 5. MCP & Tools

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **MCP servers** | ✅ `mcpServers` in settings | ✅ `mcp_servers` in config | ✅ `/mcp` API | ✅ `--toolbox` | ✅ Yes - inject config |
| **Tool restrictions** | ❌ | ❌ | ✅ Per-tool permissions | ✅ Permission rules | ⚠️ Partial |

### MCP Config Mapping

| Agent | Local Server | Remote Server |
|-------|--------------|---------------|
| Claude | `.mcp.json` or `.claude/settings.json` → `mcpServers` | Same, with `url` |
| Codex | `.codex/config.toml` → `mcp_servers` | Same schema |
| OpenCode | `/mcp` API with `McpLocalConfig` | `McpRemoteConfig` with `url`, `headers` |
| Amp | `amp mcp add` CLI | Supports remote with headers |

Local MCP servers can be bundled (for example with `tsup`) and uploaded via the filesystem API, then referenced in the session `mcp` config to auto-start and serve custom tools.

---

## 6. Skills & Extensions

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **Skills/plugins** | ✅ `.claude/skills/` | ✅ `.agents/skills/` | ✅ `.opencode/skill/` | 🔄 Claude-style | ✅ Yes - link dirs |
| **Slash commands** | ✅ `.claude/commands/` | ✅ Custom prompts (deprecated) | ❌ | ❌ | ⚠️ Partial |

### Skill Path Mapping

| Agent | Project Skills | User Skills |
|-------|----------------|-------------|
| Claude | `.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` |
| Codex | `.agents/skills/` | `~/.agents/skills/` |
| OpenCode | `.opencode/skill/`, `.claude/skills/`, `.agents/skills/` | `~/.config/opencode/skill/` |
| Amp | Uses Claude/Codex directories | — |

---

## 7. Session Management

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **Resume session** | ✅ `--resume` | ✅ Thread persistence | ✅ `-c/--continue` | ✅ `--continue` | ✅ Yes |
| **Session ID** | ✅ `session_id` | ✅ `thread_id` | ✅ `sessionID` | ✅ `session_id` | ✅ Yes |

---

## 8. Human-in-the-Loop

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **Permission requests** | ✅ Events | ⚠️ Upfront only | ✅ SSE events | ❌ Pre-configured | ⚠️ Partial |
| **Questions** | ⚠️ Limited in headless | ❌ | ✅ Full support | ❌ | ❌ No - OpenCode best |

---

## 9. Credentials

| Feature | Claude | Codex | OpenCode | Amp | Universal? |
|---------|--------|-------|----------|-----|------------|
| **API key env var** | ✅ `ANTHROPIC_API_KEY` | ✅ `OPENAI_API_KEY` | ✅ Both | ✅ `ANTHROPIC_API_KEY` | ✅ Yes |
| **OAuth tokens** | ✅ | ✅ | ✅ | ✅ | ✅ Yes |
| **Config file auth** | ✅ `~/.claude.json` | ✅ `~/.codex/auth.json` | ✅ `~/.local/share/opencode/auth.json` | ✅ `~/.amp/config.json` | ✅ Yes - extract per agent |

---

## Configuration Files Per Agent

### Claude Code

| File/Location | Purpose |
|---------------|---------|
| `CLAUDE.md` | Project instructions (hierarchical, cwd → root) |
| `~/.claude/CLAUDE.md` | Global user instructions |
| `~/.claude/settings.json` | User settings (permissions, MCP servers, env) |
| `.claude/settings.json` | Project-level settings |
| `.claude/settings.local.json` | Local overrides (gitignored) |
| `~/.claude/commands/` | Custom slash commands (user-level) |
| `.claude/commands/` | Project-level slash commands |
| `~/.claude/skills/` | Installed skills |
| `~/.claude/keybindings.json` | Custom keyboard shortcuts |
| `~/.claude/projects/<hash>/memory/MEMORY.md` | Auto-memory per project |
| `~/.claude.json` | Authentication/credentials |
| `~/.claude.json.api` | API key storage |

### OpenAI Codex

| File/Location | Purpose |
|---------------|---------|
| `AGENTS.md` | Project instructions (hierarchical, root → cwd) |
| `AGENTS.override.md` | Override file (takes precedence) |
| `~/.codex/AGENTS.md` | Global user instructions |
| `~/.codex/AGENTS.override.md` | Global override |
| `~/.codex/config.toml` | User configuration |
| `.codex/config.toml` | Project-level configuration |
| `~/.codex/auth.json` | Authentication/credentials |

Key config.toml options:
- `model` - Default model
- `developer_instructions` - Appended to system prompt
- `model_instructions_file` - Replace entire system prompt
- `project_doc_max_bytes` - Max AGENTS.md size (default 32KB)
- `project_doc_fallback_filenames` - Alternative instruction files
- `mcp_servers` - MCP server configuration

### OpenCode

| File/Location | Purpose |
|---------------|---------|
| `~/.local/share/opencode/auth.json` | Authentication |
| `~/.config/opencode/config.toml` | User configuration |
| `.opencode/config.toml` | Project configuration |

### Amp

| File/Location | Purpose |
|---------------|---------|
| `~/.amp/config.json` | Main configuration |
| `~/.config/amp/settings.json` | Additional settings |
| `.amp/rules.json` | Project permission rules |

---

## Summary: Universalization Tiers

### Tier 1: Fully Universal (implement now)

| Feature | API | Notes |
|---------|-----|-------|
| Project instructions | `projectInstructions: string` | Write to CLAUDE.md / AGENTS.md |
| Permission mode | `permissionMode: "readonly" \| "write" \| "bypass"` | Map to agent-specific flags |
| Agent mode | `agentMode: "plan" \| "build"` | Map to agent-specific mechanisms |
| Model selection | `model: string` | Pass through to agent |
| Resume session | `sessionId: string` | Map to agent's resume flag |
| Credentials | `credentials: { apiKey?, oauthToken? }` | Inject via env vars |
| MCP servers | `mcp: McpConfig` | Write to agent's config (docs drafted) |
| Skills | `skills: { paths: string[] }` | Link to agent's skill dirs (docs drafted) |

### Tier 2: Partial Support (with fallbacks)

| Feature | API | Notes |
|---------|-----|-------|
| Append system prompt | `appendSystemPrompt: string` | Falls back to projectInstructions for Amp |
| Reasoning variant | `variant: string` | Ignored for Claude |

### Tier 3: Agent-Specific (pass-through)

| Feature | Notes |
|---------|-------|
| Replace system prompt | Codex only (`model_instructions_file`) |
| Per-tool permissions | OpenCode/Amp only |
| Custom agents | OpenCode only |
| Hierarchical file discovery | Let agents handle natively |

---

## Recommended Universal API

```typescript
interface UniversalSessionConfig {
  // Tier 1 - Universal
  agent: "claude" | "codex" | "opencode" | "amp";
  model?: string;
  permissionMode?: "readonly" | "write" | "bypass";
  agentMode?: "plan" | "build";
  projectInstructions?: string;
  sessionId?: string;  // For resume
  workingDirectory?: string;
  credentials?: {
    apiKey?: string;
    oauthToken?: string;
  };

  // MCP servers (docs drafted in docs/mcp.mdx)
  mcp?: Record<string, McpServerConfig>;

  // Skills (docs drafted in docs/skills.mdx)
  skills?: {
    paths: string[];
  };

  // Tier 2 - Partial (with fallbacks)
  appendSystemPrompt?: string;
  variant?: string;

  // Tier 3 - Pass-through
  agentSpecific?: {
    claude?: { /* raw Claude options */ };
    codex?: { replaceSystemPrompt?: string; /* etc */ };
    opencode?: { customAgent?: AgentDef; /* etc */ };
    amp?: { permissionRules?: Rule[]; /* etc */ };
  };
}

interface McpServerConfig {
  type: "local" | "remote";
  // Local
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  // Remote
  url?: string;
  headers?: Record<string, string>;
}
```

---

## Implementation Notes

### Priority Inversion Warning

Claude and Codex have inverted priority for project instructions vs system prompt:

- **Claude**: `--append-system-prompt` > base prompt > `CLAUDE.md`
- **Codex**: `AGENTS.md` > `developer_instructions` > base prompt

This means:
- In Claude, system prompt additions override project files
- In Codex, project files override system prompt additions

When using both `appendSystemPrompt` and `projectInstructions`, document this behavior clearly or consider normalizing by only using one mechanism.

### File Injection Strategy

For `projectInstructions`, sandbox-agent should:

1. Create a temp directory or use session working directory
2. Write instructions to the appropriate file:
   - Claude: `.claude/CLAUDE.md` or `CLAUDE.md` in cwd
   - Codex: `.codex/AGENTS.md` or `AGENTS.md` in cwd
   - OpenCode: Config file or environment
   - Amp: Limited - may only influence via context
3. Start agent in that directory
4. Agent discovers and loads instructions automatically

### MCP Server Injection

For `mcp`, sandbox-agent should:

1. Write MCP config to agent's settings file:
   - Claude: `.mcp.json` or `.claude/settings.json` → `mcpServers` key
   - Codex: `.codex/config.toml` → `mcp_servers`
   - OpenCode: Call `/mcp` API
   - Amp: Run `amp mcp add` or pass via `--toolbox`
2. Ensure MCP server binaries are available in PATH
3. Handle cleanup on session end

### Skill Linking

For `skills.paths`, sandbox-agent should:

1. For each skill path, symlink or copy to agent's skill directory:
   - Claude: `.claude/skills/<name>/`
   - Codex: `.agents/skills/<name>/`
   - OpenCode: Update `skills.paths` in config
2. Skill directory must contain `SKILL.md`
3. Handle cleanup on session end
