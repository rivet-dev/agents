import { Download, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AgentInfo } from "sandbox-agent";

type AgentModeInfo = { id: string; name: string; description: string };
import FeatureCoverageBadges from "../agents/FeatureCoverageBadges";
import { emptyFeatureCoverage } from "../../types/agents";
const MIN_REFRESH_SPIN_MS = 350;

const AgentsTab = ({
  agents,
  defaultAgents,
  modesByAgent,
  onRefresh,
  onInstall,
  loading,
  error,
}: {
  agents: AgentInfo[];
  defaultAgents: string[];
  modesByAgent: Record<string, AgentModeInfo[]>;
  onRefresh: () => void;
  onInstall: (agentId: string, reinstall: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
}) => {
  const [installingAgent, setInstallingAgent] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const handleInstall = async (agentId: string, reinstall: boolean) => {
    setInstallingAgent(agentId);
    try {
      await onInstall(agentId, reinstall);
    } finally {
      setInstallingAgent(null);
    }
  };

  const handleRefresh = async () => {
    if (refreshing) return;
    const startedAt = Date.now();
    setRefreshing(true);
    try {
      await Promise.resolve(onRefresh());
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_REFRESH_SPIN_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, MIN_REFRESH_SPIN_MS - elapsedMs));
      }
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="inline-row" style={{ marginBottom: 16 }}>
        <button className="button secondary small" onClick={() => void handleRefresh()} disabled={loading || refreshing}>
          <RefreshCw className={`button-icon ${loading || refreshing ? "spinner-icon" : ""}`} /> Refresh
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {!loading && agents.length === 0 && <div className="card-meta">No agents reported. Click refresh to check.</div>}

      {(agents.length
        ? agents
        : defaultAgents.map((id) => ({
            id,
            installed: false,
            credentialsAvailable: false,
            version: undefined as string | undefined,
            path: undefined as string | undefined,
            capabilities: emptyFeatureCoverage as AgentInfo["capabilities"],
          }))
      ).map((agent) => {
        const isInstalling = installingAgent === agent.id;
        return (
          <div key={agent.id} className="card">
            <div className="card-header">
              <span className="card-title">{agent.id}</span>
              <div className="card-header-pills">
                <span className={`pill ${agent.installed ? "success" : "danger"}`}>{agent.installed ? "Installed" : "Missing"}</span>
                <span className={`pill ${agent.credentialsAvailable ? "success" : "warning"}`}>
                  {agent.credentialsAvailable ? "Authenticated" : "No Credentials"}
                </span>
              </div>
            </div>
            <div className="card-meta">
              {agent.version ?? "Version unknown"}
              {agent.path && (
                <span className="mono muted" style={{ marginLeft: 8 }}>
                  {agent.path}
                </span>
              )}
            </div>
            <div className="card-meta" style={{ marginTop: 8 }}>
              Feature coverage
            </div>
            <div style={{ marginTop: 8 }}>
              <FeatureCoverageBadges featureCoverage={agent.capabilities ?? emptyFeatureCoverage} />
            </div>
            {modesByAgent[agent.id] && modesByAgent[agent.id].length > 0 && (
              <div className="card-meta" style={{ marginTop: 8 }}>
                Modes: {modesByAgent[agent.id].map((mode) => mode.id).join(", ")}
              </div>
            )}
            <div className="card-actions">
              <button className="button secondary small" onClick={() => handleInstall(agent.id, agent.installed)} disabled={isInstalling}>
                {isInstalling ? <Loader2 className="button-icon spinner-icon" /> : <Download className="button-icon" />}
                {isInstalling ? "Installing..." : agent.installed ? "Reinstall" : "Install"}
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
};

export default AgentsTab;
