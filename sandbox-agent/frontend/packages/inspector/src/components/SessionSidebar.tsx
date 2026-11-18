import { Archive, ArrowLeft, ArrowUpRight, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentInfo } from "sandbox-agent";
import { formatShortId } from "../utils/format";

type AgentModeInfo = { id: string; name: string; description: string };
type AgentModelInfo = { id: string; name?: string };
import SessionCreateMenu, { type SessionConfig } from "./SessionCreateMenu";

type SessionListItem = {
  sessionId: string;
  agent: string;
  ended: boolean;
  archived: boolean;
};

const agentLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  pi: "Pi",
  cursor: "Cursor",
};
const persistenceDocsUrl = "https://sandboxagent.dev/docs/session-persistence";
const MIN_REFRESH_SPIN_MS = 350;

const SessionSidebar = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  onRefresh,
  onCreateSession,
  onSelectAgent,
  agents,
  agentsLoading,
  agentsError,
  sessionsLoading,
  sessionsError,
  modesByAgent,
  modelsByAgent,
  defaultModelByAgent,
}: {
  sessions: SessionListItem[];
  selectedSessionId: string;
  onSelectSession: (session: SessionListItem) => void;
  onRefresh: () => void;
  onCreateSession: (agentId: string, config: SessionConfig) => Promise<void>;
  onSelectAgent: (agentId: string) => Promise<void>;
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  sessionsLoading: boolean;
  sessionsError: string | null;
  modesByAgent: Record<string, AgentModeInfo[]>;
  modelsByAgent: Record<string, AgentModelInfo[]>;
  defaultModelByAgent: Record<string, string>;
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const archivedCount = sessions.filter((session) => session.archived).length;
  const activeSessions = sessions.filter((session) => !session.archived);
  const archivedSessions = sessions.filter((session) => session.archived);
  const visibleSessions = showArchived ? archivedSessions : activeSessions;
  const orderedVisibleSessions = showArchived ? [...visibleSessions].sort((a, b) => Number(a.ended) - Number(b.ended)) : visibleSessions;

  useEffect(() => {
    if (!showMenu) return;
    const handler = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  useEffect(() => {
    // Prevent getting stuck in archived view when there are no archived sessions.
    if (!showArchived) return;
    if (archivedSessions.length === 0) {
      setShowArchived(false);
    }
  }, [showArchived, archivedSessions.length]);

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
    <div className="session-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <div className="sidebar-header-actions">
          {archivedCount > 0 && (
            <button
              className={`button secondary small ${showArchived ? "active" : ""}`}
              onClick={() => setShowArchived((value) => !value)}
              title={showArchived ? "Hide archived sessions" : `Show archived sessions (${archivedCount})`}
            >
              {showArchived ? <ArrowLeft size={12} className="button-icon" /> : <Archive size={12} className="button-icon" />}
            </button>
          )}
          <button className="button secondary small" onClick={() => void handleRefresh()} title="Refresh sessions" disabled={sessionsLoading || refreshing}>
            <RefreshCw size={12} className={`button-icon ${sessionsLoading || refreshing ? "spinner-icon" : ""}`} />
          </button>
          <div className="sidebar-add-menu-wrapper" ref={menuRef}>
            <button className="sidebar-add-btn" onClick={() => setShowMenu((value) => !value)} title="New session">
              <Plus size={14} />
            </button>
            <SessionCreateMenu
              agents={agents}
              agentsLoading={agentsLoading}
              agentsError={agentsError}
              modesByAgent={modesByAgent}
              modelsByAgent={modelsByAgent}
              defaultModelByAgent={defaultModelByAgent}
              onCreateSession={onCreateSession}
              onSelectAgent={onSelectAgent}
              open={showMenu}
              onClose={() => setShowMenu(false)}
            />
          </div>
        </div>
      </div>

      <div className="session-list">
        {sessionsLoading ? (
          <div className="sidebar-empty">Loading sessions...</div>
        ) : sessionsError ? (
          <div className="sidebar-empty error">{sessionsError}</div>
        ) : visibleSessions.length === 0 ? (
          <div className="sidebar-empty">{showArchived ? "No archived sessions." : "No sessions yet."}</div>
        ) : (
          <>
            {showArchived && <div className="sidebar-empty">Archived Sessions</div>}
            {orderedVisibleSessions.map((session) => (
              <div
                key={session.sessionId}
                className={`session-item ${session.sessionId === selectedSessionId ? "active" : ""} ${session.ended ? "ended" : ""} ${session.archived ? "ended" : ""}`}
              >
                <button className="session-item-content" onClick={() => onSelectSession(session)}>
                  <div className="session-item-id" title={session.sessionId}>
                    {formatShortId(session.sessionId)}
                  </div>
                  <div className="session-item-meta">
                    <span className="session-item-agent">{agentLabels[session.agent] ?? session.agent}</span>
                    {(session.archived || session.ended) && <span className="session-item-ended">ended</span>}
                  </div>
                </button>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="session-persistence-note">
        Sessions are persisted in your browser using IndexedDB. These sessions are only from your browser; your SDK sessions are separate. Adding inspector
        support for SDK soon.{" "}
        <a href={persistenceDocsUrl} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          Configure persistence
          <ArrowUpRight size={10} />
        </a>
      </div>
    </div>
  );
};

export default SessionSidebar;
