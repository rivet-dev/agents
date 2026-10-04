import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentInfo } from "sandbox-agent";

type AgentModeInfo = { id: string; name: string; description: string };
type AgentModelInfo = { id: string; name?: string };

export type SessionConfig = {
  agentMode: string;
  model: string;
};

const CUSTOM_MODEL_VALUE = "__custom__";

const agentLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  pi: "Pi",
  cursor: "Cursor",
};

const agentLogos: Record<string, string> = {
  claude: `${import.meta.env.BASE_URL}logos/claude.svg`,
  codex: `${import.meta.env.BASE_URL}logos/openai.svg`,
  opencode: `${import.meta.env.BASE_URL}logos/opencode.svg`,
  amp: `${import.meta.env.BASE_URL}logos/amp.svg`,
  pi: `${import.meta.env.BASE_URL}logos/pi.svg`,
};

const SessionCreateMenu = ({
  agents,
  agentsLoading,
  agentsError,
  modesByAgent,
  modelsByAgent,
  defaultModelByAgent,
  onCreateSession,
  onSelectAgent,
  open,
  onClose,
}: {
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  modesByAgent: Record<string, AgentModeInfo[]>;
  modelsByAgent: Record<string, AgentModelInfo[]>;
  defaultModelByAgent: Record<string, string>;
  onCreateSession: (agentId: string, config: SessionConfig) => Promise<void>;
  onSelectAgent: (agentId: string) => Promise<void>;
  open: boolean;
  onClose: () => void;
}) => {
  const [phase, setPhase] = useState<"agent" | "config" | "loading-config">("agent");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [agentMode, setAgentMode] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [creating, setCreating] = useState(false);

  // Reset state when menu closes
  useEffect(() => {
    if (!open) {
      setPhase("agent");
      setSelectedAgent("");
      setAgentMode("");
      setSelectedModel("");
      setCustomModel("");
      setIsCustomModel(false);
      setCreating(false);
    }
  }, [open]);

  // Auto-select first mode when modes load for selected agent
  useEffect(() => {
    if (!selectedAgent) return;
    const modes = modesByAgent[selectedAgent];
    if (modes && modes.length > 0 && !agentMode) {
      setAgentMode(modes[0].id);
    }
  }, [modesByAgent, selectedAgent, agentMode]);

  // Agent-specific config should not leak between agent selections.
  useEffect(() => {
    setAgentMode("");
    setSelectedModel("");
    setCustomModel("");
    setIsCustomModel(false);
  }, [selectedAgent]);

  // Auto-select default model when agent is selected
  useEffect(() => {
    if (!selectedAgent) return;
    if (selectedModel) return;
    const defaultModel = defaultModelByAgent[selectedAgent];
    if (defaultModel) {
      setSelectedModel(defaultModel);
    } else {
      const models = modelsByAgent[selectedAgent];
      if (models && models.length > 0) {
        setSelectedModel(models[0].id);
      }
    }
  }, [modelsByAgent, defaultModelByAgent, selectedAgent, selectedModel]);

  if (!open) return null;

  const handleAgentClick = (agentId: string) => {
    setSelectedAgent(agentId);
    setPhase("config");
    // Load agent config in background; creation should not block on this call.
    void onSelectAgent(agentId).catch((error) => {
      console.error("[SessionCreateMenu] Failed to load agent config:", error);
    });
  };

  const handleBack = () => {
    if (creating) return;
    setPhase("agent");
    setSelectedAgent("");
    setAgentMode("");
    setSelectedModel("");
    setCustomModel("");
    setIsCustomModel(false);
  };

  const handleModelSelectChange = (value: string) => {
    if (value === CUSTOM_MODEL_VALUE) {
      setIsCustomModel(true);
      setSelectedModel("");
    } else {
      setIsCustomModel(false);
      setCustomModel("");
      setSelectedModel(value);
    }
  };

  const resolvedModel = isCustomModel ? customModel : selectedModel;

  const handleCreate = async () => {
    if (!selectedAgent) return;
    setCreating(true);
    try {
      await onCreateSession(selectedAgent, { agentMode, model: resolvedModel });
      onClose();
    } catch (error) {
      console.error("[SessionCreateMenu] Failed to create session:", error);
    } finally {
      setCreating(false);
    }
  };

  if (phase === "agent") {
    return (
      <div className="session-create-menu">
        {agentsLoading && <div className="sidebar-add-status">Loading agents...</div>}
        {agentsError && <div className="sidebar-add-status error">{agentsError}</div>}
        {!agentsLoading && !agentsError && agents.length === 0 && <div className="sidebar-add-status">No agents available.</div>}
        {!agentsLoading &&
          !agentsError &&
          (() => {
            const codingAgents = agents.filter((a) => a.id !== "mock");
            const mockAgent = agents.find((a) => a.id === "mock");
            return (
              <>
                {codingAgents.map((agent) => (
                  <button key={agent.id} className="sidebar-add-option" onClick={() => handleAgentClick(agent.id)}>
                    <div className="agent-option-left">
                      {agentLogos[agent.id] && <img src={agentLogos[agent.id]} alt="" className="agent-option-logo" />}
                      <span className="agent-option-name">{agentLabels[agent.id] ?? agent.id}</span>
                      {agent.version && <span className="agent-option-version">{agent.version}</span>}
                    </div>
                    <div className="agent-option-badges">
                      {agent.installed && <span className="agent-badge installed">Installed</span>}
                      <ArrowRight size={12} className="agent-option-arrow" />
                    </div>
                  </button>
                ))}
                {mockAgent && (
                  <>
                    <div className="agent-divider" />
                    <button className="sidebar-add-option" onClick={() => handleAgentClick(mockAgent.id)}>
                      <div className="agent-option-left">
                        <span className="agent-option-name">{agentLabels[mockAgent.id] ?? mockAgent.id}</span>
                        {mockAgent.version && <span className="agent-option-version">{mockAgent.version}</span>}
                      </div>
                      <div className="agent-option-badges">
                        {mockAgent.installed && <span className="agent-badge installed">Installed</span>}
                        <ArrowRight size={12} className="agent-option-arrow" />
                      </div>
                    </button>
                  </>
                )}
              </>
            );
          })()}
      </div>
    );
  }

  const agentLabel = agentLabels[selectedAgent] ?? selectedAgent;

  // Phase 2: config form
  const activeModes = modesByAgent[selectedAgent] ?? [];
  const activeModels = modelsByAgent[selectedAgent] ?? [];

  return (
    <div className="session-create-menu">
      <div className="session-create-header">
        <button className="session-create-back" onClick={handleBack} title="Back to agents">
          <ArrowLeft size={14} />
        </button>
        <span className="session-create-agent-name">{agentLabel}</span>
      </div>

      <div className="session-create-form">
        <div className="setup-field">
          <span className="setup-label">Model</span>
          {isCustomModel ? (
            <input
              className="setup-input"
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="Enter model name..."
              autoFocus
            />
          ) : (
            <select className="setup-select" value={selectedModel} onChange={(e) => handleModelSelectChange(e.target.value)} title="Model">
              {activeModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
              <option value={CUSTOM_MODEL_VALUE}>Custom...</option>
            </select>
          )}
          {isCustomModel && (
            <button
              className="setup-custom-back"
              onClick={() => {
                setIsCustomModel(false);
                setCustomModel("");
                const defaultModel = defaultModelByAgent[selectedAgent];
                setSelectedModel(defaultModel || (activeModels.length > 0 ? activeModels[0].id : ""));
              }}
              title="Back to model list"
              type="button"
            >
              ← List
            </button>
          )}
        </div>
        {activeModes.length > 0 && (
          <div className="setup-field">
            <span className="setup-label">Mode</span>
            <select className="setup-select" value={agentMode} onChange={(e) => setAgentMode(e.target.value)} title="Mode">
              {activeModes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="session-create-actions">
        <button className="button primary" onClick={() => void handleCreate()} disabled={creating}>
          {creating ? "Creating..." : "Create Session"}
        </button>
      </div>
    </div>
  );
};

export default SessionCreateMenu;
