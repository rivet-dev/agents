import { memo } from "react";
import { useStyletron } from "baseui";
import { LabelXSmall } from "baseui/typography";
import { FileCode, Plus, X } from "lucide-react";

import { useFoundryTokens } from "../../app/theme";
import { ContextMenuOverlay, SessionAvatar, useContextMenu } from "./ui";
import { diffTabId, fileName, type Task } from "./view-model";

export const SessionStrip = memo(function SessionStrip({
  task,
  activeSessionId,
  openDiffs,
  editingSessionId,
  editingSessionName,
  onEditingSessionNameChange,
  onSwitchSession,
  onStartRenamingSession,
  onCommitSessionRename,
  onCancelSessionRename,
  onSetSessionUnread,
  onCloseSession,
  onCloseDiffTab,
  onAddSession,
  sidebarCollapsed,
}: {
  task: Task;
  activeSessionId: string | null;
  openDiffs: string[];
  editingSessionId: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onSwitchSession: (sessionId: string) => void;
  onStartRenamingSession: (sessionId: string) => void;
  onCommitSessionRename: () => void;
  onCancelSessionRename: () => void;
  onSetSessionUnread: (sessionId: string, unread: boolean) => void;
  onCloseSession: (sessionId: string) => void;
  onCloseDiffTab: (path: string) => void;
  onAddSession: () => void;
  sidebarCollapsed?: boolean;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const isDesktop = !!import.meta.env.VITE_DESKTOP;
  const contextMenu = useContextMenu();

  return (
    <>
      <style>{`
        [data-session]:hover [data-session-close] { opacity: 0.5 !important; }
        [data-session]:hover [data-session-close]:hover { opacity: 1 !important; }
      `}</style>
      <div
        className={css({
          display: "flex",
          alignItems: "stretch",
          borderBottom: `1px solid ${t.borderDefault}`,
          gap: "4px",
          backgroundColor: t.surfacePrimary,
          paddingLeft: sidebarCollapsed ? "14px" : "6px",
          height: "41px",
          minHeight: "41px",
          overflowX: "auto",
          scrollbarWidth: "none",
          flexShrink: 0,
          "::-webkit-scrollbar": { display: "none" },
        })}
      >
        {task.sessions.map((tab) => {
          const isActive = tab.id === activeSessionId;
          return (
            <div
              key={tab.id}
              onClick={() => onSwitchSession(tab.id)}
              onDoubleClick={() => onStartRenamingSession(tab.id)}
              onMouseDown={(event) => {
                if (event.button === 1 && task.sessions.length > 1) {
                  event.preventDefault();
                  onCloseSession(tab.id);
                }
              }}
              onContextMenu={(event) =>
                contextMenu.open(event, [
                  { label: "Rename session", onClick: () => onStartRenamingSession(tab.id) },
                  {
                    label: tab.unread ? "Mark as read" : "Mark as unread",
                    onClick: () => onSetSessionUnread(tab.id, !tab.unread),
                  },
                  ...(task.sessions.length > 1 ? [{ label: "Close session", onClick: () => onCloseSession(tab.id) }] : []),
                ])
              }
              data-session
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 12px",
                marginTop: "6px",
                marginBottom: "6px",
                borderRadius: "8px",
                backgroundColor: isActive ? t.interactiveHover : "transparent",
                cursor: "pointer",
                transition: "color 200ms ease, background-color 200ms ease",
                flexShrink: 0,
                ":hover": { color: t.textPrimary, backgroundColor: isActive ? t.interactiveHover : t.interactiveSubtle },
              })}
            >
              <div
                className={css({
                  width: "14px",
                  minWidth: "14px",
                  height: "14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                })}
              >
                <SessionAvatar session={tab} />
              </div>
              {editingSessionId === tab.id ? (
                <input
                  autoFocus
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onBlur={onCommitSessionRename}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onCommitSessionRename();
                    } else if (event.key === "Escape") {
                      onCancelSessionRename();
                    }
                  }}
                  className={css({
                    appearance: "none",
                    WebkitAppearance: "none",
                    background: "none",
                    border: "none",
                    padding: "0",
                    margin: "0",
                    outline: "none",
                    minWidth: "72px",
                    maxWidth: "180px",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: t.textPrimary,
                    borderBottom: `1px solid ${t.borderFocus}`,
                  })}
                />
              ) : (
                <LabelXSmall color={isActive ? t.textPrimary : t.textSecondary} $style={{ fontWeight: 500 }}>
                  {tab.sessionName}
                </LabelXSmall>
              )}
              {task.sessions.length > 1 ? (
                <X
                  size={11}
                  color={t.textTertiary}
                  data-session-close
                  className={css({ cursor: "pointer", opacity: 0 })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseSession(tab.id);
                  }}
                />
              ) : null}
            </div>
          );
        })}
        {openDiffs.map((path) => {
          const sessionId = diffTabId(path);
          const isActive = sessionId === activeSessionId;
          return (
            <div
              key={sessionId}
              onClick={() => onSwitchSession(sessionId)}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onCloseDiffTab(path);
                }
              }}
              data-session
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 12px",
                marginTop: "6px",
                marginBottom: "6px",
                borderRadius: "8px",
                backgroundColor: isActive ? t.interactiveHover : "transparent",
                cursor: "pointer",
                transition: "color 200ms ease, background-color 200ms ease",
                flexShrink: 0,
                ":hover": { color: t.textPrimary, backgroundColor: isActive ? t.interactiveHover : t.interactiveSubtle },
              })}
            >
              <FileCode size={12} color={isActive ? t.textPrimary : t.textSecondary} />
              <LabelXSmall color={isActive ? t.textPrimary : t.textSecondary} $style={{ fontWeight: 500, fontFamily: '"IBM Plex Mono", monospace' }}>
                {fileName(path)}
              </LabelXSmall>
              <X
                size={11}
                color={t.textTertiary}
                data-session-close
                className={css({ cursor: "pointer", opacity: 0 })}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseDiffTab(path);
                }}
              />
            </div>
          );
        })}
        <div
          onClick={onAddSession}
          className={css({
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            cursor: "pointer",
            opacity: 0.4,
            lineHeight: 0,
            ":hover": { opacity: 0.7 },
            flexShrink: 0,
          })}
        >
          <Plus size={14} color={t.textTertiary} />
        </div>
      </div>
      {contextMenu.menu ? <ContextMenuOverlay menu={contextMenu.menu} onClose={contextMenu.close} /> : null}
    </>
  );
});
