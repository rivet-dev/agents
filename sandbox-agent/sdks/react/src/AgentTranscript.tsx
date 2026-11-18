"use client";

import type { ReactNode, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranscriptVirtualizer } from "./useTranscriptVirtualizer.ts";

export type PermissionReply = "once" | "always" | "reject";

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: string;
};

export type TranscriptEntry = {
  id: string;
  eventId?: string;
  kind: "message" | "tool" | "meta" | "reasoning" | "permission";
  time: string;
  role?: "user" | "assistant";
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  toolStatus?: string;
  reasoning?: { text: string; visibility?: string };
  meta?: { title: string; detail?: string; severity?: "info" | "error" };
  permission?: {
    permissionId: string;
    title: string;
    description?: string;
    options: PermissionOption[];
    resolved?: boolean;
    selectedOptionId?: string;
  };
};

export interface AgentTranscriptClassNames {
  root: string;
  divider: string;
  dividerLine: string;
  dividerText: string;
  message: string;
  messageContent: string;
  messageText: string;
  error: string;
  toolGroupSingle: string;
  toolGroupContainer: string;
  toolGroupHeader: string;
  toolGroupIcon: string;
  toolGroupLabel: string;
  toolGroupChevron: string;
  toolGroupBody: string;
  toolItem: string;
  toolItemConnector: string;
  toolItemDot: string;
  toolItemLine: string;
  toolItemContent: string;
  toolItemHeader: string;
  toolItemIcon: string;
  toolItemLabel: string;
  toolItemSpinner: string;
  toolItemLink: string;
  toolItemChevron: string;
  toolItemBody: string;
  toolSection: string;
  toolSectionTitle: string;
  toolCode: string;
  toolCodeMuted: string;
  permissionPrompt: string;
  permissionHeader: string;
  permissionIcon: string;
  permissionTitle: string;
  permissionDescription: string;
  permissionActions: string;
  permissionButton: string;
  permissionAutoResolved: string;
  thinkingRow: string;
  thinkingAvatar: string;
  thinkingAvatarImage: string;
  thinkingAvatarLabel: string;
  thinkingIndicator: string;
  thinkingDot: string;
  endAnchor: string;
}

export interface PermissionOptionRenderContext {
  entry: TranscriptEntry;
  option: PermissionOption;
  label: string;
  reply: PermissionReply;
  selected: boolean;
  dimmed: boolean;
  resolved: boolean;
}

export interface AgentTranscriptProps {
  entries: TranscriptEntry[];
  className?: string;
  classNames?: Partial<AgentTranscriptClassNames>;
  endRef?: RefObject<HTMLDivElement | null>;
  scrollRef?: RefObject<HTMLDivElement | null>;
  scrollToEntryId?: string | null;
  sessionError?: string | null;
  eventError?: string | null;
  isThinking?: boolean;
  agentId?: string;
  virtualize?: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  onEventClick?: (eventId: string) => void;
  onPermissionReply?: (permissionId: string, reply: PermissionReply) => void;
  isDividerEntry?: (entry: TranscriptEntry) => boolean;
  canOpenEvent?: (entry: TranscriptEntry) => boolean;
  getToolGroupSummary?: (entries: TranscriptEntry[]) => string;
  renderMessageText?: (entry: TranscriptEntry) => ReactNode;
  renderInlinePendingIndicator?: () => ReactNode;
  renderThinkingState?: (context: { agentId?: string }) => ReactNode;
  renderToolItemIcon?: (entry: TranscriptEntry) => ReactNode;
  renderToolGroupIcon?: (entries: TranscriptEntry[], expanded: boolean) => ReactNode;
  renderChevron?: (expanded: boolean) => ReactNode;
  renderEventLinkContent?: (entry: TranscriptEntry) => ReactNode;
  renderPermissionIcon?: (entry: TranscriptEntry) => ReactNode;
  renderPermissionOptionContent?: (context: PermissionOptionRenderContext) => ReactNode;
}

type GroupedEntries =
  | { type: "message"; entries: TranscriptEntry[] }
  | { type: "tool-group"; entries: TranscriptEntry[] }
  | { type: "divider"; entries: TranscriptEntry[] }
  | { type: "permission"; entries: TranscriptEntry[] };

const VIRTUAL_GROUP_GAP_PX = 12;

const DEFAULT_CLASS_NAMES: AgentTranscriptClassNames = {
  root: "sa-agent-transcript",
  divider: "sa-agent-transcript-divider",
  dividerLine: "sa-agent-transcript-divider-line",
  dividerText: "sa-agent-transcript-divider-text",
  message: "sa-agent-transcript-message",
  messageContent: "sa-agent-transcript-message-content",
  messageText: "sa-agent-transcript-message-text",
  error: "sa-agent-transcript-error",
  toolGroupSingle: "sa-agent-transcript-tool-group-single",
  toolGroupContainer: "sa-agent-transcript-tool-group",
  toolGroupHeader: "sa-agent-transcript-tool-group-header",
  toolGroupIcon: "sa-agent-transcript-tool-group-icon",
  toolGroupLabel: "sa-agent-transcript-tool-group-label",
  toolGroupChevron: "sa-agent-transcript-tool-group-chevron",
  toolGroupBody: "sa-agent-transcript-tool-group-body",
  toolItem: "sa-agent-transcript-tool-item",
  toolItemConnector: "sa-agent-transcript-tool-item-connector",
  toolItemDot: "sa-agent-transcript-tool-item-dot",
  toolItemLine: "sa-agent-transcript-tool-item-line",
  toolItemContent: "sa-agent-transcript-tool-item-content",
  toolItemHeader: "sa-agent-transcript-tool-item-header",
  toolItemIcon: "sa-agent-transcript-tool-item-icon",
  toolItemLabel: "sa-agent-transcript-tool-item-label",
  toolItemSpinner: "sa-agent-transcript-tool-item-spinner",
  toolItemLink: "sa-agent-transcript-tool-item-link",
  toolItemChevron: "sa-agent-transcript-tool-item-chevron",
  toolItemBody: "sa-agent-transcript-tool-item-body",
  toolSection: "sa-agent-transcript-tool-section",
  toolSectionTitle: "sa-agent-transcript-tool-section-title",
  toolCode: "sa-agent-transcript-tool-code",
  toolCodeMuted: "sa-agent-transcript-tool-code-muted",
  permissionPrompt: "sa-agent-transcript-permission-prompt",
  permissionHeader: "sa-agent-transcript-permission-header",
  permissionIcon: "sa-agent-transcript-permission-icon",
  permissionTitle: "sa-agent-transcript-permission-title",
  permissionDescription: "sa-agent-transcript-permission-description",
  permissionActions: "sa-agent-transcript-permission-actions",
  permissionButton: "sa-agent-transcript-permission-button",
  permissionAutoResolved: "sa-agent-transcript-permission-auto-resolved",
  thinkingRow: "sa-agent-transcript-thinking-row",
  thinkingAvatar: "sa-agent-transcript-thinking-avatar",
  thinkingAvatarImage: "sa-agent-transcript-thinking-avatar-image",
  thinkingAvatarLabel: "sa-agent-transcript-thinking-avatar-label",
  thinkingIndicator: "sa-agent-transcript-thinking-indicator",
  thinkingDot: "sa-agent-transcript-thinking-dot",
  endAnchor: "sa-agent-transcript-end",
};

const DEFAULT_DIVIDER_TITLES = new Set(["Session Started", "Turn Started", "Turn Ended"]);

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

const mergeClassNames = (defaults: AgentTranscriptClassNames, overrides?: Partial<AgentTranscriptClassNames>): AgentTranscriptClassNames => ({
  root: cx(defaults.root, overrides?.root),
  divider: cx(defaults.divider, overrides?.divider),
  dividerLine: cx(defaults.dividerLine, overrides?.dividerLine),
  dividerText: cx(defaults.dividerText, overrides?.dividerText),
  message: cx(defaults.message, overrides?.message),
  messageContent: cx(defaults.messageContent, overrides?.messageContent),
  messageText: cx(defaults.messageText, overrides?.messageText),
  error: cx(defaults.error, overrides?.error),
  toolGroupSingle: cx(defaults.toolGroupSingle, overrides?.toolGroupSingle),
  toolGroupContainer: cx(defaults.toolGroupContainer, overrides?.toolGroupContainer),
  toolGroupHeader: cx(defaults.toolGroupHeader, overrides?.toolGroupHeader),
  toolGroupIcon: cx(defaults.toolGroupIcon, overrides?.toolGroupIcon),
  toolGroupLabel: cx(defaults.toolGroupLabel, overrides?.toolGroupLabel),
  toolGroupChevron: cx(defaults.toolGroupChevron, overrides?.toolGroupChevron),
  toolGroupBody: cx(defaults.toolGroupBody, overrides?.toolGroupBody),
  toolItem: cx(defaults.toolItem, overrides?.toolItem),
  toolItemConnector: cx(defaults.toolItemConnector, overrides?.toolItemConnector),
  toolItemDot: cx(defaults.toolItemDot, overrides?.toolItemDot),
  toolItemLine: cx(defaults.toolItemLine, overrides?.toolItemLine),
  toolItemContent: cx(defaults.toolItemContent, overrides?.toolItemContent),
  toolItemHeader: cx(defaults.toolItemHeader, overrides?.toolItemHeader),
  toolItemIcon: cx(defaults.toolItemIcon, overrides?.toolItemIcon),
  toolItemLabel: cx(defaults.toolItemLabel, overrides?.toolItemLabel),
  toolItemSpinner: cx(defaults.toolItemSpinner, overrides?.toolItemSpinner),
  toolItemLink: cx(defaults.toolItemLink, overrides?.toolItemLink),
  toolItemChevron: cx(defaults.toolItemChevron, overrides?.toolItemChevron),
  toolItemBody: cx(defaults.toolItemBody, overrides?.toolItemBody),
  toolSection: cx(defaults.toolSection, overrides?.toolSection),
  toolSectionTitle: cx(defaults.toolSectionTitle, overrides?.toolSectionTitle),
  toolCode: cx(defaults.toolCode, overrides?.toolCode),
  toolCodeMuted: cx(defaults.toolCodeMuted, overrides?.toolCodeMuted),
  permissionPrompt: cx(defaults.permissionPrompt, overrides?.permissionPrompt),
  permissionHeader: cx(defaults.permissionHeader, overrides?.permissionHeader),
  permissionIcon: cx(defaults.permissionIcon, overrides?.permissionIcon),
  permissionTitle: cx(defaults.permissionTitle, overrides?.permissionTitle),
  permissionDescription: cx(defaults.permissionDescription, overrides?.permissionDescription),
  permissionActions: cx(defaults.permissionActions, overrides?.permissionActions),
  permissionButton: cx(defaults.permissionButton, overrides?.permissionButton),
  permissionAutoResolved: cx(defaults.permissionAutoResolved, overrides?.permissionAutoResolved),
  thinkingRow: cx(defaults.thinkingRow, overrides?.thinkingRow),
  thinkingAvatar: cx(defaults.thinkingAvatar, overrides?.thinkingAvatar),
  thinkingAvatarImage: cx(defaults.thinkingAvatarImage, overrides?.thinkingAvatarImage),
  thinkingAvatarLabel: cx(defaults.thinkingAvatarLabel, overrides?.thinkingAvatarLabel),
  thinkingIndicator: cx(defaults.thinkingIndicator, overrides?.thinkingIndicator),
  thinkingDot: cx(defaults.thinkingDot, overrides?.thinkingDot),
  endAnchor: cx(defaults.endAnchor, overrides?.endAnchor),
});

const getMessageVariant = (entry: TranscriptEntry) => {
  if (entry.kind === "tool") return "tool";
  if (entry.kind === "meta") return entry.meta?.severity === "error" ? "error" : "system";
  if (entry.kind === "reasoning") return "assistant";
  if (entry.kind === "permission") return "system";
  if (entry.role === "user") return "user";
  return "assistant";
};

const getToolItemLabel = (entry: TranscriptEntry) => {
  if (entry.kind === "tool") {
    const statusLabel = entry.toolStatus && entry.toolStatus !== "completed" ? ` (${entry.toolStatus.replaceAll("_", " ")})` : "";
    return `${entry.toolName ?? "tool"}${statusLabel}`;
  }

  if (entry.kind === "reasoning") {
    return `Reasoning${entry.reasoning?.visibility ? ` (${entry.reasoning.visibility})` : ""}`;
  }

  return entry.meta?.title ?? "Status";
};

const getDefaultToolItemIcon = (entry: TranscriptEntry) => {
  if (entry.kind === "tool") return "Tool";
  if (entry.kind === "reasoning") return "Thought";
  return entry.meta?.severity === "error" ? "Error" : "Info";
};

const getDefaultToolGroupSummary = (entries: TranscriptEntry[]) => {
  const count = entries.length;
  return `${count} Event${count === 1 ? "" : "s"}`;
};

const getPermissionReplyForOption = (kind: string): PermissionReply => {
  if (kind === "allow_once") return "once";
  if (kind === "allow_always") return "always";
  return "reject";
};

const getPermissionOptionLabel = (option: PermissionOption) => {
  if (option.name) return option.name;
  if (option.kind === "allow_once") return "Allow Once";
  if (option.kind === "allow_always") return "Always Allow";
  if (option.kind === "reject_once") return "Reject";
  if (option.kind === "reject_always") return "Reject Always";
  return option.kind;
};

const getPermissionOptionTone = (kind: string) => (kind.startsWith("allow") ? "allow" : "reject");

const defaultRenderMessageText = (entry: TranscriptEntry) => entry.text;
const defaultRenderPendingIndicator = () => "...";
const defaultRenderChevron = (expanded: boolean) => (expanded ? "▾" : "▸");
const defaultRenderEventLinkContent = () => "Open";
const defaultRenderPermissionIcon = () => "Permission";
const defaultRenderPermissionOptionContent = ({ label }: PermissionOptionRenderContext) => label;
const defaultIsDividerEntry = (entry: TranscriptEntry) => entry.kind === "meta" && DEFAULT_DIVIDER_TITLES.has(entry.meta?.title ?? "");

const defaultCanOpenEvent = (entry: TranscriptEntry) => Boolean(entry.eventId);

const buildGroupedEntries = (entries: TranscriptEntry[], isDividerEntry: (entry: TranscriptEntry) => boolean): GroupedEntries[] => {
  const groupedEntries: GroupedEntries[] = [];
  let currentToolGroup: TranscriptEntry[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length === 0) {
      return;
    }
    groupedEntries.push({ type: "tool-group", entries: currentToolGroup });
    currentToolGroup = [];
  };

  for (const entry of entries) {
    if (isDividerEntry(entry)) {
      flushToolGroup();
      groupedEntries.push({ type: "divider", entries: [entry] });
      continue;
    }

    if (entry.kind === "permission") {
      flushToolGroup();
      groupedEntries.push({ type: "permission", entries: [entry] });
      continue;
    }

    if (entry.kind === "tool" || entry.kind === "reasoning" || entry.kind === "meta") {
      currentToolGroup.push(entry);
      continue;
    }

    flushToolGroup();
    groupedEntries.push({ type: "message", entries: [entry] });
  }

  flushToolGroup();
  return groupedEntries;
};

const getGroupedEntryKey = (group: GroupedEntries, index: number): string => {
  const firstEntry = group.entries[0];

  if (group.type === "tool-group") {
    return `tool-group:${firstEntry?.id ?? index}`;
  }

  return firstEntry?.id ?? `${group.type}:${index}`;
};

const ToolItem = ({
  entry,
  isLast,
  expanded,
  onExpandedChange,
  classNames,
  onEventClick,
  canOpenEvent,
  renderInlinePendingIndicator,
  renderToolItemIcon,
  renderChevron,
  renderEventLinkContent,
}: {
  entry: TranscriptEntry;
  isLast: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  classNames: AgentTranscriptClassNames;
  onEventClick?: (eventId: string) => void;
  canOpenEvent: (entry: TranscriptEntry) => boolean;
  renderInlinePendingIndicator: () => ReactNode;
  renderToolItemIcon: (entry: TranscriptEntry) => ReactNode;
  renderChevron: (expanded: boolean) => ReactNode;
  renderEventLinkContent: (entry: TranscriptEntry) => ReactNode;
}) => {
  const isTool = entry.kind === "tool";
  const isReasoning = entry.kind === "reasoning";
  const isMeta = entry.kind === "meta";
  const isComplete = isTool && (entry.toolStatus === "completed" || entry.toolStatus === "failed");
  const isFailed = isTool && entry.toolStatus === "failed";
  const isInProgress = isTool && entry.toolStatus === "in_progress";
  const hasContent = isTool
    ? Boolean(entry.toolInput || entry.toolOutput)
    : isReasoning
      ? Boolean(entry.reasoning?.text?.trim())
      : Boolean(entry.meta?.detail?.trim());
  const showEventLink = Boolean(entry.eventId && onEventClick && canOpenEvent(entry));

  return (
    <div
      className={cx(classNames.toolItem, isLast && "last", isFailed && "failed")}
      data-slot="tool-item"
      data-kind={entry.kind}
      data-state={entry.toolStatus}
      data-last={isLast ? "true" : undefined}
      data-failed={isFailed ? "true" : undefined}
    >
      <div className={classNames.toolItemConnector} data-slot="tool-item-connector">
        <div className={classNames.toolItemDot} data-slot="tool-item-dot" />
        {!isLast ? <div className={classNames.toolItemLine} data-slot="tool-item-line" /> : null}
      </div>
      <div className={classNames.toolItemContent} data-slot="tool-item-content">
        <button
          type="button"
          className={cx(classNames.toolItemHeader, expanded && "expanded")}
          data-slot="tool-item-header"
          data-expanded={expanded ? "true" : undefined}
          data-has-content={hasContent ? "true" : undefined}
          disabled={!hasContent}
          onClick={() => {
            if (hasContent) {
              onExpandedChange(!expanded);
            }
          }}
        >
          <span className={classNames.toolItemIcon} data-slot="tool-item-icon">
            {renderToolItemIcon(entry)}
          </span>
          <span className={classNames.toolItemLabel} data-slot="tool-item-label">
            {getToolItemLabel(entry)}
          </span>
          {isInProgress ? (
            <span className={classNames.toolItemSpinner} data-slot="tool-item-spinner">
              {renderInlinePendingIndicator()}
            </span>
          ) : null}
          {showEventLink ? (
            <span
              className={classNames.toolItemLink}
              data-slot="tool-item-link"
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                onEventClick?.(entry.eventId!);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onEventClick?.(entry.eventId!);
                }
              }}
            >
              {renderEventLinkContent(entry)}
            </span>
          ) : null}
          {hasContent ? (
            <span className={classNames.toolItemChevron} data-slot="tool-item-chevron">
              {renderChevron(expanded)}
            </span>
          ) : null}
        </button>
        {expanded && hasContent ? (
          <div className={classNames.toolItemBody} data-slot="tool-item-body">
            {isTool && entry.toolInput ? (
              <div className={classNames.toolSection} data-slot="tool-section" data-section="input">
                <div className={classNames.toolSectionTitle} data-slot="tool-section-title">
                  Input
                </div>
                <pre className={classNames.toolCode} data-slot="tool-code">
                  {entry.toolInput}
                </pre>
              </div>
            ) : null}
            {isTool && isComplete && entry.toolOutput ? (
              <div className={classNames.toolSection} data-slot="tool-section" data-section="output">
                <div className={classNames.toolSectionTitle} data-slot="tool-section-title">
                  Output
                </div>
                <pre className={classNames.toolCode} data-slot="tool-code">
                  {entry.toolOutput}
                </pre>
              </div>
            ) : null}
            {isReasoning && entry.reasoning?.text ? (
              <div className={classNames.toolSection} data-slot="tool-section" data-section="reasoning">
                <pre className={cx(classNames.toolCode, classNames.toolCodeMuted)} data-slot="tool-code">
                  {entry.reasoning.text}
                </pre>
              </div>
            ) : null}
            {isMeta && entry.meta?.detail ? (
              <div className={classNames.toolSection} data-slot="tool-section" data-section="meta">
                <pre className={classNames.toolCode} data-slot="tool-code">
                  {entry.meta.detail}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const ToolGroup = ({
  entries,
  expanded,
  onExpandedChange,
  expandedItemIds,
  onToolItemExpandedChange,
  classNames,
  onEventClick,
  canOpenEvent,
  getToolGroupSummary,
  renderInlinePendingIndicator,
  renderToolItemIcon,
  renderToolGroupIcon,
  renderChevron,
  renderEventLinkContent,
}: {
  entries: TranscriptEntry[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  expandedItemIds: Record<string, boolean>;
  onToolItemExpandedChange: (entryId: string, expanded: boolean) => void;
  classNames: AgentTranscriptClassNames;
  onEventClick?: (eventId: string) => void;
  canOpenEvent: (entry: TranscriptEntry) => boolean;
  getToolGroupSummary: (entries: TranscriptEntry[]) => string;
  renderInlinePendingIndicator: () => ReactNode;
  renderToolItemIcon: (entry: TranscriptEntry) => ReactNode;
  renderToolGroupIcon: (entries: TranscriptEntry[], expanded: boolean) => ReactNode;
  renderChevron: (expanded: boolean) => ReactNode;
  renderEventLinkContent: (entry: TranscriptEntry) => ReactNode;
}) => {
  const hasFailed = entries.some((entry) => entry.kind === "tool" && entry.toolStatus === "failed");

  if (entries.length === 1) {
    return (
      <div className={classNames.toolGroupSingle} data-slot="tool-group-single">
        <ToolItem
          entry={entries[0]}
          isLast={true}
          expanded={Boolean(expandedItemIds[entries[0]!.id])}
          onExpandedChange={(nextExpanded) => onToolItemExpandedChange(entries[0]!.id, nextExpanded)}
          classNames={classNames}
          onEventClick={onEventClick}
          canOpenEvent={canOpenEvent}
          renderInlinePendingIndicator={renderInlinePendingIndicator}
          renderToolItemIcon={renderToolItemIcon}
          renderChevron={renderChevron}
          renderEventLinkContent={renderEventLinkContent}
        />
      </div>
    );
  }

  return (
    <div className={cx(classNames.toolGroupContainer, hasFailed && "failed")} data-slot="tool-group" data-failed={hasFailed ? "true" : undefined}>
      <button
        type="button"
        className={cx(classNames.toolGroupHeader, expanded && "expanded")}
        data-slot="tool-group-header"
        data-expanded={expanded ? "true" : undefined}
        onClick={() => onExpandedChange(!expanded)}
      >
        <span className={classNames.toolGroupIcon} data-slot="tool-group-icon">
          {renderToolGroupIcon(entries, expanded)}
        </span>
        <span className={classNames.toolGroupLabel} data-slot="tool-group-label">
          {getToolGroupSummary(entries)}
        </span>
        <span className={classNames.toolGroupChevron} data-slot="tool-group-chevron">
          {renderChevron(expanded)}
        </span>
      </button>
      {expanded ? (
        <div className={classNames.toolGroupBody} data-slot="tool-group-body">
          {entries.map((entry, index) => (
            <ToolItem
              key={entry.id}
              entry={entry}
              isLast={index === entries.length - 1}
              expanded={Boolean(expandedItemIds[entry.id])}
              onExpandedChange={(nextExpanded) => onToolItemExpandedChange(entry.id, nextExpanded)}
              classNames={classNames}
              onEventClick={onEventClick}
              canOpenEvent={canOpenEvent}
              renderInlinePendingIndicator={renderInlinePendingIndicator}
              renderToolItemIcon={renderToolItemIcon}
              renderChevron={renderChevron}
              renderEventLinkContent={renderEventLinkContent}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const PermissionPrompt = ({
  entry,
  classNames,
  onPermissionReply,
  renderPermissionIcon,
  renderPermissionOptionContent,
}: {
  entry: TranscriptEntry;
  classNames: AgentTranscriptClassNames;
  onPermissionReply?: (permissionId: string, reply: PermissionReply) => void;
  renderPermissionIcon: (entry: TranscriptEntry) => ReactNode;
  renderPermissionOptionContent: (context: PermissionOptionRenderContext) => ReactNode;
}) => {
  const permission = entry.permission;
  if (!permission) {
    return null;
  }

  const resolved = Boolean(permission.resolved);
  const selectedOptionId = permission.selectedOptionId;
  const canReply = Boolean(onPermissionReply) && !resolved;

  return (
    <div className={cx(classNames.permissionPrompt, resolved && "resolved")} data-slot="permission-prompt" data-resolved={resolved ? "true" : undefined}>
      <div className={classNames.permissionHeader} data-slot="permission-header">
        <span className={classNames.permissionIcon} data-slot="permission-icon">
          {renderPermissionIcon(entry)}
        </span>
        <span className={classNames.permissionTitle} data-slot="permission-title">
          {permission.title}
        </span>
      </div>
      {permission.description ? (
        <div className={classNames.permissionDescription} data-slot="permission-description">
          {permission.description}
        </div>
      ) : null}
      <div className={classNames.permissionActions} data-slot="permission-actions">
        {permission.options.map((option) => {
          const reply = getPermissionReplyForOption(option.kind);
          const label = getPermissionOptionLabel(option);
          const selected = resolved && selectedOptionId === option.optionId;
          const dimmed = resolved && !selected && selectedOptionId != null;
          const tone = getPermissionOptionTone(option.kind);

          return (
            <button
              key={option.optionId}
              type="button"
              className={cx(classNames.permissionButton, tone, selected && "selected", dimmed && "dimmed")}
              data-slot="permission-button"
              data-tone={tone}
              data-selected={selected ? "true" : undefined}
              data-dimmed={dimmed ? "true" : undefined}
              disabled={!canReply}
              onClick={() => onPermissionReply?.(permission.permissionId, reply)}
            >
              {renderPermissionOptionContent({
                entry,
                option,
                label,
                reply,
                selected,
                dimmed,
                resolved,
              })}
            </button>
          );
        })}
        {resolved && !selectedOptionId ? (
          <span className={classNames.permissionAutoResolved} data-slot="permission-auto-resolved">
            Auto-resolved
          </span>
        ) : null}
      </div>
    </div>
  );
};

export const AgentTranscript = ({
  entries,
  className,
  classNames: classNameOverrides,
  endRef,
  scrollRef,
  scrollToEntryId,
  sessionError,
  eventError,
  isThinking,
  agentId,
  virtualize = false,
  onAtBottomChange,
  onEventClick,
  onPermissionReply,
  isDividerEntry = defaultIsDividerEntry,
  canOpenEvent = defaultCanOpenEvent,
  getToolGroupSummary = getDefaultToolGroupSummary,
  renderMessageText = defaultRenderMessageText,
  renderInlinePendingIndicator = defaultRenderPendingIndicator,
  renderThinkingState,
  renderToolItemIcon = getDefaultToolItemIcon,
  renderToolGroupIcon = () => null,
  renderChevron = defaultRenderChevron,
  renderEventLinkContent = defaultRenderEventLinkContent,
  renderPermissionIcon = defaultRenderPermissionIcon,
  renderPermissionOptionContent = defaultRenderPermissionOptionContent,
}: AgentTranscriptProps) => {
  const resolvedClassNames = useMemo(() => mergeClassNames(DEFAULT_CLASS_NAMES, classNameOverrides), [classNameOverrides]);
  const groupedEntries = useMemo(() => buildGroupedEntries(entries, isDividerEntry), [entries, isDividerEntry]);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Record<string, boolean>>({});
  const [expandedToolItems, setExpandedToolItems] = useState<Record<string, boolean>>({});
  const lastScrollTargetRef = useRef<string | null>(null);
  const isVirtualized = virtualize && Boolean(scrollRef);
  const { virtualizer, isFollowingRef } = useTranscriptVirtualizer(groupedEntries, isVirtualized ? scrollRef : undefined, onAtBottomChange);

  useEffect(() => {
    if (!scrollToEntryId) {
      lastScrollTargetRef.current = null;
      return;
    }

    if (!isVirtualized || scrollToEntryId === lastScrollTargetRef.current) {
      return;
    }

    const targetIndex = groupedEntries.findIndex((group) => group.entries.some((entry) => entry.id === scrollToEntryId));
    if (targetIndex < 0) {
      return;
    }

    lastScrollTargetRef.current = scrollToEntryId;

    const frameId = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(targetIndex, {
        align: "center",
        behavior: "smooth",
      });
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [groupedEntries, isVirtualized, scrollToEntryId, virtualizer]);

  useEffect(() => {
    if (!isVirtualized || !scrollRef?.current || !isFollowingRef.current) {
      return;
    }

    const scrollElement = scrollRef.current;
    const frameId = requestAnimationFrame(() => {
      scrollElement.scrollTo({ top: scrollElement.scrollHeight });
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [eventError, isFollowingRef, isThinking, isVirtualized, scrollRef, sessionError]);

  const setToolGroupExpanded = (groupKey: string, expanded: boolean) => {
    setExpandedToolGroups((current) => {
      if (current[groupKey] === expanded) {
        return current;
      }
      return { ...current, [groupKey]: expanded };
    });
  };

  const setToolItemExpanded = (entryId: string, expanded: boolean) => {
    setExpandedToolItems((current) => {
      if (current[entryId] === expanded) {
        return current;
      }
      return { ...current, [entryId]: expanded };
    });
  };

  const renderGroup = (group: GroupedEntries, index: number) => {
    if (group.type === "divider") {
      const entry = group.entries[0];
      const title = entry.meta?.title ?? "Status";
      return (
        <div key={entry.id} className={resolvedClassNames.divider} data-slot="divider">
          <div className={resolvedClassNames.dividerLine} data-slot="divider-line" />
          <span className={resolvedClassNames.dividerText} data-slot="divider-text">
            {title}
          </span>
          <div className={resolvedClassNames.dividerLine} data-slot="divider-line" />
        </div>
      );
    }

    if (group.type === "tool-group") {
      const groupKey = getGroupedEntryKey(group, index);

      return (
        <ToolGroup
          key={groupKey}
          entries={group.entries}
          expanded={Boolean(expandedToolGroups[groupKey])}
          onExpandedChange={(expanded) => setToolGroupExpanded(groupKey, expanded)}
          expandedItemIds={expandedToolItems}
          onToolItemExpandedChange={setToolItemExpanded}
          classNames={resolvedClassNames}
          onEventClick={onEventClick}
          canOpenEvent={canOpenEvent}
          getToolGroupSummary={getToolGroupSummary}
          renderInlinePendingIndicator={renderInlinePendingIndicator}
          renderToolItemIcon={renderToolItemIcon}
          renderToolGroupIcon={renderToolGroupIcon}
          renderChevron={renderChevron}
          renderEventLinkContent={renderEventLinkContent}
        />
      );
    }

    if (group.type === "permission") {
      const entry = group.entries[0];
      return (
        <PermissionPrompt
          key={entry.id}
          entry={entry}
          classNames={resolvedClassNames}
          onPermissionReply={onPermissionReply}
          renderPermissionIcon={renderPermissionIcon}
          renderPermissionOptionContent={renderPermissionOptionContent}
        />
      );
    }

    const entry = group.entries[0];
    const messageVariant = getMessageVariant(entry);

    return (
      <div
        key={entry.id}
        className={cx(resolvedClassNames.message, messageVariant, "no-avatar")}
        data-slot="message"
        data-kind={entry.kind}
        data-role={entry.role}
        data-variant={messageVariant}
        data-severity={entry.meta?.severity}
      >
        <div className={resolvedClassNames.messageContent} data-slot="message-content">
          {entry.text ? (
            <div className={resolvedClassNames.messageText} data-slot="message-text">
              {renderMessageText(entry)}
            </div>
          ) : (
            <span className={resolvedClassNames.thinkingIndicator} data-slot="thinking-indicator">
              {renderInlinePendingIndicator()}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={cx(resolvedClassNames.root, className)} data-slot="root" data-virtualized={isVirtualized ? "true" : undefined}>
      {isVirtualized ? (
        <div
          data-slot="virtual-list"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const group = groupedEntries[virtualItem.index];
            if (!group) {
              return null;
            }

            return (
              <div
                key={getGroupedEntryKey(group, virtualItem.index)}
                data-index={virtualItem.index}
                ref={(node) => {
                  if (node) {
                    virtualizer.measureElement(node);
                  }
                }}
                style={{
                  left: 0,
                  position: "absolute",
                  top: 0,
                  transform: `translateY(${virtualItem.start}px)`,
                  width: "100%",
                }}
              >
                <div style={{ paddingBottom: virtualItem.index === groupedEntries.length - 1 ? 0 : `${VIRTUAL_GROUP_GAP_PX}px` }}>
                  {renderGroup(group, virtualItem.index)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        groupedEntries.map((group, index) => renderGroup(group, index))
      )}
      {sessionError ? (
        <div className={resolvedClassNames.error} data-slot="error" data-source="session">
          {sessionError}
        </div>
      ) : null}
      {eventError ? (
        <div className={resolvedClassNames.error} data-slot="error" data-source="event">
          {eventError}
        </div>
      ) : null}
      {isThinking
        ? (renderThinkingState?.({ agentId }) ?? (
            <div className={resolvedClassNames.thinkingRow} data-slot="thinking-row">
              <span className={resolvedClassNames.thinkingIndicator} data-slot="thinking-indicator">
                Thinking...
              </span>
            </div>
          ))
        : null}
      {!isVirtualized ? <div ref={endRef} className={resolvedClassNames.endAnchor} data-slot="end-anchor" /> : null}
    </div>
  );
};
