import { memo, useMemo } from "react";
import { useStyletron } from "baseui";
import { LabelSmall } from "baseui/typography";
import { Clock, PanelLeft, PanelRight } from "lucide-react";

import { useFoundryTokens } from "../../app/theme";
import { deriveHeaderStatus } from "../../features/tasks/status";
import { HeaderStatusPill, PanelHeaderBar } from "./ui";
import { type AgentSession, type Task } from "./view-model";

export const TranscriptHeader = memo(function TranscriptHeader({
  task,
  hasSandbox,
  activeSession,
  editingField,
  editValue,
  onEditValueChange,
  onStartEditingField,
  onCommitEditingField,
  onCancelEditingField,
  onSetActiveSessionUnread,
  sidebarCollapsed,
  onToggleSidebar,
  onSidebarPeekStart,
  onSidebarPeekEnd,
  rightSidebarCollapsed,
  onToggleRightSidebar,
  onNavigateToUsage,
}: {
  task: Task;
  hasSandbox: boolean;
  activeSession: AgentSession | null | undefined;
  editingField: "title" | null;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onStartEditingField: (field: "title", value: string) => void;
  onCommitEditingField: (field: "title") => void;
  onCancelEditingField: () => void;
  onSetActiveSessionUnread: (unread: boolean) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onSidebarPeekStart?: () => void;
  onSidebarPeekEnd?: () => void;
  rightSidebarCollapsed?: boolean;
  onToggleRightSidebar?: () => void;
  onNavigateToUsage?: () => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const isDesktop = !!import.meta.env.VITE_DESKTOP;
  const needsTrafficLightInset = isDesktop && sidebarCollapsed;
  const headerStatus = useMemo(
    () => deriveHeaderStatus(task.status, activeSession?.status ?? null, activeSession?.errorMessage ?? null, hasSandbox),
    [task.status, activeSession?.status, activeSession?.errorMessage, hasSandbox],
  );

  return (
    <PanelHeaderBar $style={{ backgroundColor: t.surfaceSecondary, borderBottom: "none", paddingLeft: needsTrafficLightInset ? "74px" : "14px" }}>
      {sidebarCollapsed && onToggleSidebar ? (
        <div
          className={css({
            width: "26px",
            height: "26px",
            borderRadius: "6px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: t.textTertiary,
            flexShrink: 0,
            ":hover": { color: t.textSecondary, backgroundColor: t.interactiveHover },
          })}
          onClick={onToggleSidebar}
          onMouseEnter={onSidebarPeekStart}
          onMouseLeave={onSidebarPeekEnd}
        >
          <PanelLeft size={14} />
        </div>
      ) : null}
      {editingField === "title" ? (
        <input
          autoFocus
          value={editValue}
          onChange={(event) => onEditValueChange(event.target.value)}
          onBlur={() => onCommitEditingField("title")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCommitEditingField("title");
            } else if (event.key === "Escape") {
              onCancelEditingField();
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
            fontWeight: 500,
            fontSize: "14px",
            color: t.textPrimary,
            borderBottom: `1px solid ${t.borderFocus}`,
            minWidth: "80px",
            maxWidth: "300px",
          })}
        />
      ) : (
        <LabelSmall
          title="Rename"
          color={t.textPrimary}
          $style={{ fontWeight: 400, whiteSpace: "nowrap", cursor: "pointer", ":hover": { textDecoration: "underline" } }}
          onClick={() => onStartEditingField("title", task.title)}
        >
          {task.title}
        </LabelSmall>
      )}
      {task.branch ? (
        <span
          className={css({
            padding: "2px 8px",
            borderRadius: "999px",
            border: `1px solid ${t.borderMedium}`,
            backgroundColor: t.interactiveSubtle,
            color: t.textPrimary,
            fontSize: "11px",
            whiteSpace: "nowrap",
            fontFamily: '"IBM Plex Mono", monospace',
          })}
        >
          {task.branch}
        </span>
      ) : null}
      <HeaderStatusPill status={headerStatus} />
      <div className={css({ flex: 1 })} />
      <div
        role="button"
        tabIndex={0}
        onClick={onNavigateToUsage}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onNavigateToUsage?.();
        }}
        className={css({
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "4px 12px",
          borderRadius: "6px",
          backgroundColor: "transparent",
          fontSize: "11px",
          fontWeight: 500,
          lineHeight: 1,
          color: t.textTertiary,
          whiteSpace: "nowrap",
          cursor: "pointer",
          transition: "background 200ms ease, color 200ms ease",
          ":hover": { backgroundColor: t.interactiveHover, color: t.textSecondary },
        })}
      >
        <Clock size={11} style={{ flexShrink: 0 }} />
        <span>{task.minutesUsed ?? 0} min used</span>
      </div>
      {rightSidebarCollapsed && onToggleRightSidebar ? (
        <div
          className={css({
            width: "26px",
            height: "26px",
            borderRadius: "6px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: t.textTertiary,
            flexShrink: 0,
            ":hover": { color: t.textSecondary, backgroundColor: t.interactiveHover },
          })}
          onClick={onToggleRightSidebar}
        >
          <PanelRight size={14} />
        </div>
      ) : null}
    </PanelHeaderBar>
  );
});
