import claudeConfig from "../../../../scripts/agent-configs/resources/claude.json" with { type: "json" };
import codexConfig from "../../../../scripts/agent-configs/resources/codex.json" with { type: "json" };

export type WorkspaceAgentKind = string;
export type WorkspaceModelId = string;

export interface WorkspaceModelOption {
  id: WorkspaceModelId;
  label: string;
}

export interface WorkspaceModelGroup {
  provider: string;
  agentKind: WorkspaceAgentKind;
  sandboxAgentId: string;
  models: WorkspaceModelOption[];
}

interface AgentConfigResource {
  defaultModel?: string;
  models?: Array<{ id?: string; name?: string }>;
}

interface SandboxAgentInfoLike {
  id?: unknown;
  configOptions?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeModelLabel(model: { id?: string; name?: string }): string {
  const name = model.name?.trim();
  if (name && name.length > 0) {
    return name;
  }
  return model.id?.trim() || "Unknown";
}

function buildGroup(provider: string, agentKind: WorkspaceAgentKind, sandboxAgentId: string, config: AgentConfigResource): WorkspaceModelGroup {
  return {
    provider,
    agentKind,
    sandboxAgentId,
    models: (config.models ?? [])
      .map((model) => {
        const id = model.id?.trim();
        if (!id) {
          return null;
        }
        return {
          id,
          label: normalizeModelLabel(model),
        };
      })
      .filter((model): model is WorkspaceModelOption => model != null),
  };
}

function titleCaseIdentifier(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function workspaceAgentMetadata(agentId: string): { provider: string; agentKind: string } {
  const normalized = agentId.trim().toLowerCase();
  switch (normalized) {
    case "claude":
      return { provider: "Claude", agentKind: "Claude" };
    case "codex":
      return { provider: "Codex", agentKind: "Codex" };
    default:
      return {
        provider: titleCaseIdentifier(agentId),
        agentKind: titleCaseIdentifier(agentId),
      };
  }
}

function normalizeOptionLabel(entry: Record<string, unknown>): string | null {
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (name) {
    return name;
  }

  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  if (label) {
    return label;
  }

  const value = typeof entry.value === "string" ? entry.value.trim() : "";
  return value || null;
}

function appendSelectOptionModels(target: WorkspaceModelOption[], options: unknown): void {
  if (!Array.isArray(options)) {
    return;
  }

  for (const entry of options) {
    if (!isRecord(entry)) {
      continue;
    }

    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    if (value) {
      target.push({
        id: value,
        label: normalizeOptionLabel(entry) ?? value,
      });
      continue;
    }

    appendSelectOptionModels(target, entry.options);
  }
}

function normalizeAgentModels(configOptions: unknown): WorkspaceModelOption[] {
  if (!Array.isArray(configOptions)) {
    return [];
  }

  const options = configOptions.find((entry) => isRecord(entry) && entry.category === "model" && entry.type === "select");
  if (!isRecord(options)) {
    return [];
  }

  const models: WorkspaceModelOption[] = [];
  appendSelectOptionModels(models, options.options);

  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}

export function workspaceModelGroupsFromSandboxAgents(agents: SandboxAgentInfoLike[]): WorkspaceModelGroup[] {
  return agents
    .map((agent) => {
      const sandboxAgentId = typeof agent.id === "string" ? agent.id.trim() : "";
      if (!sandboxAgentId) {
        return null;
      }

      const models = normalizeAgentModels(agent.configOptions);
      if (models.length === 0) {
        return null;
      }

      const metadata = workspaceAgentMetadata(sandboxAgentId);
      return {
        provider: metadata.provider,
        agentKind: metadata.agentKind,
        sandboxAgentId,
        models,
      } satisfies WorkspaceModelGroup;
    })
    .filter((group): group is WorkspaceModelGroup => group != null);
}

export const DEFAULT_WORKSPACE_MODEL_GROUPS: WorkspaceModelGroup[] = [
  buildGroup("Claude", "Claude", "claude", claudeConfig as AgentConfigResource),
  buildGroup("Codex", "Codex", "codex", codexConfig as AgentConfigResource),
].filter((group) => group.models.length > 0);

export const DEFAULT_WORKSPACE_MODEL_ID: WorkspaceModelId = (
  (codexConfig as AgentConfigResource).defaultModel ??
  DEFAULT_WORKSPACE_MODEL_GROUPS[0]?.models[0]?.id ??
  "default"
).trim();

export function workspaceProviderAgent(provider: string, groups: WorkspaceModelGroup[] = DEFAULT_WORKSPACE_MODEL_GROUPS): WorkspaceAgentKind {
  return groups.find((group) => group.provider === provider)?.agentKind ?? provider;
}

export function workspaceModelGroupForId(id: WorkspaceModelId, groups: WorkspaceModelGroup[] = DEFAULT_WORKSPACE_MODEL_GROUPS): WorkspaceModelGroup | null {
  return groups.find((group) => group.models.some((model) => model.id === id)) ?? null;
}

export function workspaceModelLabel(id: WorkspaceModelId, groups: WorkspaceModelGroup[] = DEFAULT_WORKSPACE_MODEL_GROUPS): string {
  const group = workspaceModelGroupForId(id, groups);
  const model = group?.models.find((candidate) => candidate.id === id);
  return model && group ? `${group.provider} ${model.label}` : id;
}

export function workspaceAgentForModel(id: WorkspaceModelId, groups: WorkspaceModelGroup[] = DEFAULT_WORKSPACE_MODEL_GROUPS): WorkspaceAgentKind {
  const group = workspaceModelGroupForId(id, groups);
  if (group) {
    return group.agentKind;
  }
  return groups[0]?.agentKind ?? "Claude";
}

export function workspaceSandboxAgentIdForModel(id: WorkspaceModelId, groups: WorkspaceModelGroup[] = DEFAULT_WORKSPACE_MODEL_GROUPS): string {
  const group = workspaceModelGroupForId(id, groups);
  return group?.sandboxAgentId ?? groups[0]?.sandboxAgentId ?? "claude";
}
