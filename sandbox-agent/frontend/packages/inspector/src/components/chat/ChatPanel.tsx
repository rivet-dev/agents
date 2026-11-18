import type { TranscriptEntry } from "@sandbox-agent/react";
import { AlertTriangle, Archive, CheckSquare, MessageSquare, Plus, Square, Terminal } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { AgentInfo } from "sandbox-agent";
import { formatShortId } from "../../utils/format";

type AgentModeInfo = { id: string; name: string; description: string };
type AgentModelInfo = { id: string; name?: string };
import SessionCreateMenu, { type SessionConfig } from "../SessionCreateMenu";
import InspectorConversation from "./InspectorConversation";

const HistoryLoadingSkeleton = () => (
  <div className="chat-loading-skeleton" aria-hidden>
    <div className="chat-skeleton-row assistant">
      <div className="chat-skeleton-bubble w-lg" />
    </div>
    <div className="chat-skeleton-row user">
      <div className="chat-skeleton-bubble w-md" />
    </div>
    <div className="chat-skeleton-row assistant">
      <div className="chat-skeleton-bubble w-xl" />
    </div>
    <div className="chat-skeleton-row assistant">
      <div className="chat-skeleton-bubble w-sm" />
    </div>
  </div>
);

const ChatPanel = ({
  sessionId,
  transcriptEntries,
  isLoadingHistory,
  sessionError,
  message,
  onMessageChange,
  onSendMessage,
  onKeyDown,
  onCreateSession,
  onSelectAgent,
  agents,
  agentsLoading,
  agentsError,
  scrollRef,
  agentLabel,
  modelLabel,
  currentAgentVersion,
  sessionEnded,
  sessionArchived,
  onEndSession,
  onArchiveSession,
  onUnarchiveSession,
  modesByAgent,
  modelsByAgent,
  defaultModelByAgent,
  onEventClick,
  isThinking,
  agentId,
  tokenUsage,
  onPermissionReply,
}: {
  sessionId: string;
  transcriptEntries: TranscriptEntry[];
  isLoadingHistory?: boolean;
  sessionError: string | null;
  message: string;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCreateSession: (agentId: string, config: SessionConfig) => Promise<void>;
  onSelectAgent: (agentId: string) => Promise<void>;
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  agentLabel: string;
  modelLabel?: string | null;
  currentAgentVersion?: string | null;
  sessionEnded: boolean;
  sessionArchived: boolean;
  onEndSession: () => void;
  onArchiveSession: () => void;
  onUnarchiveSession: () => void;
  modesByAgent: Record<string, AgentModeInfo[]>;
  modelsByAgent: Record<string, AgentModelInfo[]>;
  defaultModelByAgent: Record<string, string>;
  onEventClick?: (eventId: string) => void;
  isThinking?: boolean;
  agentId?: string;
  tokenUsage?: { used: number; size: number; cost?: number } | null;
  onPermissionReply?: (permissionId: string, reply: "once" | "always" | "reject") => void;
}) => {
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showAgentMenu) return;
    const handler = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setShowAgentMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAgentMenu]);

  const copySessionId = async () => {
    if (!sessionId) return;
    const onSuccess = () => {
      setCopiedSessionId(true);
      window.setTimeout(() => setCopiedSessionId(false), 1200);
    };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(sessionId);
        onSuccess();
        return;
      }
    } catch {
      // Fallback below for older/insecure contexts.
    }

    const textarea = document.createElement("textarea");
    textarea.value = sessionId;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      onSuccess();
    } finally {
      document.body.removeChild(textarea);
    }
  };

  const handleArchiveSession = () => {
    if (!sessionId) return;
    onArchiveSession();
  };

  const handleUnarchiveSession = () => {
    if (!sessionId) return;
    onUnarchiveSession();
  };

  return (
    <div className="chat-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <MessageSquare className="button-icon" />
          <span className="panel-title">{sessionId ? agentLabel : "No Session"}</span>
          {sessionId && modelLabel && (
            <span className="header-meta-pill" title={modelLabel}>
              {modelLabel}
            </span>
          )}
          {sessionId && currentAgentVersion && <span className="header-meta-pill">v{currentAgentVersion}</span>}
          {sessionId && (
            <button
              type="button"
              className="session-id-display"
              title={copiedSessionId ? "Copied" : `${sessionId} (click to copy)`}
              onClick={() => void copySessionId()}
            >
              {copiedSessionId ? "Copied" : formatShortId(sessionId)}
            </button>
          )}
        </div>
        <div className="panel-header-right">
          {sessionId && tokenUsage && <span className="token-pill">{tokenUsage.used.toLocaleString()} tokens</span>}
          {sessionId &&
            (sessionEnded ? (
              <>
                <span className="button ghost small session-ended-status" title="Session ended">
                  <CheckSquare size={12} />
                  Ended
                </span>
                <button
                  type="button"
                  className="button ghost small"
                  onClick={sessionArchived ? handleUnarchiveSession : handleArchiveSession}
                  title={sessionArchived ? "Unarchive session" : "Archive session"}
                >
                  <Archive size={12} />
                  {sessionArchived ? "Unarchive" : "Archive"}
                </button>
              </>
            ) : (
              <button type="button" className="button ghost small" onClick={onEndSession} title="End session">
                <Square size={12} />
                End
              </button>
            ))}
        </div>
      </div>

      {sessionError && (
        <div className="error-banner">
          <AlertTriangle size={14} />
          <span>{sessionError}</span>
        </div>
      )}

      {!sessionId ? (
        <div className="messages-container">
          <div className="empty-state">
            <div className="empty-state-title">No Session Selected</div>
            <p className="empty-state-text no-session-subtext">Create a new session to start chatting with an agent.</p>
            <div className="empty-state-menu-wrapper" ref={menuRef}>
              <button className="button primary" onClick={() => setShowAgentMenu((value) => !value)}>
                <Plus className="button-icon" />
                Create Session
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
                open={showAgentMenu}
                onClose={() => setShowAgentMenu(false)}
              />
            </div>
          </div>
        </div>
      ) : (
        <InspectorConversation
          entries={transcriptEntries}
          sessionError={sessionError}
          eventError={null}
          scrollRef={scrollRef}
          onEventClick={onEventClick}
          isThinking={isThinking}
          agentId={agentId}
          emptyState={
            isLoadingHistory ? (
              <HistoryLoadingSkeleton />
            ) : (
              <div className="empty-state">
                <Terminal className="empty-state-icon" />
                <div className="empty-state-title">Ready to Chat</div>
                <p className="empty-state-text">Send a message to start a conversation with the agent.</p>
              </div>
            )
          }
          message={message}
          onMessageChange={onMessageChange}
          onSendMessage={onSendMessage}
          onKeyDown={onKeyDown}
          placeholder={sessionEnded ? "Session ended" : "Send a message..."}
          disabled={sessionEnded}
          onPermissionReply={onPermissionReply}
        />
      )}
    </div>
  );
};

export default ChatPanel;
