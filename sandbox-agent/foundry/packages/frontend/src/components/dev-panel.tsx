import { memo, useEffect, useMemo, useState } from "react";
import { useStyletron } from "baseui";
import { useFoundryTokens } from "../app/theme";
import { isMockFrontendClient } from "../lib/env";
import { subscriptionManager } from "../lib/subscription";
import type {
  FoundryAppSnapshot,
  FoundryOrganization,
  TaskWorkspaceSnapshot,
  WorkspaceSandboxSummary,
  WorkspaceSessionSummary,
  WorkspaceTaskStatus,
} from "@sandbox-agent/foundry-shared";
import { useSubscription } from "@sandbox-agent/foundry-client";
import type { DebugSubscriptionTopic } from "@sandbox-agent/foundry-client";
import { describeTaskState } from "../features/tasks/status";

interface DevPanelProps {
  organizationId: string;
  snapshot: TaskWorkspaceSnapshot;
  organization?: FoundryOrganization | null;
  focusedTask?: DevPanelFocusedTask | null;
}

export interface DevPanelFocusedTask {
  id: string;
  repoId: string;
  title: string | null;
  status: WorkspaceTaskStatus;
  branch?: string | null;
  activeSandboxId?: string | null;
  activeSessionId?: string | null;
  sandboxes?: WorkspaceSandboxSummary[];
  sessions?: WorkspaceSessionSummary[];
}

interface TopicInfo {
  label: string;
  key: string;
  /** Parsed params portion of the cache key, or empty if none. */
  params: string;
  listenerCount: number;
  hasConnection: boolean;
  status: "loading" | "connected" | "error";
  lastRefresh: number | null;
}

function topicLabel(topic: DebugSubscriptionTopic): string {
  switch (topic.topicKey) {
    case "app":
      return "App";
    case "organization":
      return "Organization";
    case "task":
      return "Task";
    case "session":
      return "Session";
    case "sandboxProcesses":
      return "Sandbox";
  }
}

/** Extract the params portion of a cache key (everything after the first `:`) */
function topicParams(topic: DebugSubscriptionTopic): string {
  const idx = topic.cacheKey.indexOf(":");
  return idx >= 0 ? topic.cacheKey.slice(idx + 1) : "";
}

function timeAgo(ts: number | null): string {
  if (!ts) return "never";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function statusColor(status: string, t: ReturnType<typeof useFoundryTokens>): string {
  if (status.startsWith("init_") || status.startsWith("archive_") || status.startsWith("kill_") || status.startsWith("pending_")) {
    return t.statusWarning;
  }
  switch (status) {
    case "connected":
    case "running":
    case "ready":
      return t.statusSuccess;
    case "loading":
      return t.statusWarning;
    case "archived":
      return t.textMuted;
    case "error":
    case "failed":
      return t.statusError;
    default:
      return t.textTertiary;
  }
}

function syncStatusColor(status: string, t: ReturnType<typeof useFoundryTokens>): string {
  switch (status) {
    case "synced":
      return t.statusSuccess;
    case "syncing":
    case "pending":
      return t.statusWarning;
    case "error":
      return t.statusError;
    default:
      return t.textMuted;
  }
}

function installStatusColor(status: string, t: ReturnType<typeof useFoundryTokens>): string {
  switch (status) {
    case "connected":
      return t.statusSuccess;
    case "install_required":
      return t.statusWarning;
    case "reconnect_required":
      return t.statusError;
    default:
      return t.textMuted;
  }
}

/** Format elapsed thinking time as a compact string. */
function thinkingLabel(sinceMs: number | null, now: number): string | null {
  if (!sinceMs) return null;
  const elapsed = Math.floor((now - sinceMs) / 1000);
  if (elapsed < 1) return "thinking";
  return `thinking ${elapsed}s`;
}

export const DevPanel = memo(function DevPanel({ organizationId, snapshot, organization, focusedTask }: DevPanelProps) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const [now, setNow] = useState(Date.now());

  // Tick every 2s to keep relative timestamps fresh
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  const topics = useMemo((): TopicInfo[] => {
    return subscriptionManager.listDebugTopics().map((topic) => ({
      label: topicLabel(topic),
      key: topic.cacheKey,
      params: topicParams(topic),
      listenerCount: topic.listenerCount,
      hasConnection: topic.status === "connected",
      status: topic.status,
      lastRefresh: topic.lastRefreshAt,
    }));
  }, [now]);

  const appState = useSubscription(subscriptionManager, "app", {});
  const organizationState = useSubscription(subscriptionManager, "organization", { organizationId });
  const appSnapshot: FoundryAppSnapshot | null = appState.data ?? null;
  const liveGithub = organizationState.data?.github ?? organization?.github ?? null;

  const repos = snapshot.repos ?? [];
  const tasks = snapshot.tasks ?? [];
  const prCount = tasks.filter((task) => task.pullRequest != null).length;
  const focusedTaskStatus = focusedTask?.status ?? null;
  const focusedTaskState = describeTaskState(focusedTaskStatus);
  const lastWebhookAt = liveGithub?.lastWebhookAt ?? null;
  const hasRecentWebhook = lastWebhookAt != null && now - lastWebhookAt < 5 * 60_000;
  const totalOrgs = appSnapshot?.organizations.length ?? 0;
  const authStatus = appSnapshot?.auth.status ?? "unknown";

  const mono = css({
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, monospace",
    fontSize: "10px",
  });

  return (
    <div
      className={css({
        position: "fixed",
        bottom: "8px",
        right: "8px",
        width: "320px",
        maxHeight: "50vh",
        zIndex: 99999,
        backgroundColor: t.surfaceElevated,
        border: `1px solid ${t.borderMedium}`,
        borderRadius: "6px",
        boxShadow: t.shadow,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      })}
    >
      {/* Header */}
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          borderBottom: `1px solid ${t.borderSubtle}`,
          backgroundColor: t.surfaceTertiary,
          flexShrink: 0,
        })}
      >
        <span
          className={css({
            fontSize: "10px",
            fontWeight: 600,
            color: t.textSecondary,
            letterSpacing: "0.5px",
            textTransform: "uppercase",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          })}
        >
          Dev
          {isMockFrontendClient && <span className={css({ fontSize: "8px", fontWeight: 600, color: t.statusWarning, letterSpacing: "0.3px" })}>MOCK</span>}
        </span>
        <span className={css({ fontSize: "9px", color: t.textMuted })}>Shift+D</span>
      </div>

      {/* Body */}
      <div className={css({ overflowY: "auto", padding: "6px" })}>
        {/* Subscription Topics */}
        <Section label="Subscription Topics" t={t} css={css}>
          {topics.map((topic) => (
            <div
              key={topic.key}
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "2px 0",
              })}
            >
              <span
                className={css({
                  width: "5px",
                  height: "5px",
                  borderRadius: "50%",
                  backgroundColor: topic.hasConnection ? t.statusSuccess : t.textMuted,
                  flexShrink: 0,
                })}
              />
              <span className={css({ fontSize: "10px", color: t.textPrimary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                {topic.label}
              </span>
              <span className={`${mono} ${css({ color: statusColor(topic.status, t) })}`}>{topic.status}</span>
              {topic.params && (
                <span
                  className={`${mono} ${css({ color: t.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100px" })}`}
                >
                  {topic.params}
                </span>
              )}
              <span className={`${mono} ${css({ color: t.textTertiary })}`}>{timeAgo(topic.lastRefresh)}</span>
            </div>
          ))}
          {topics.length === 0 && <span className={css({ fontSize: "10px", color: t.textMuted })}>No active subscriptions</span>}
        </Section>

        {/* App State */}
        <Section label="App" t={t} css={css}>
          <div className={css({ display: "flex", flexDirection: "column", gap: "3px", fontSize: "10px" })}>
            <div className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
              <span
                className={css({
                  width: "5px",
                  height: "5px",
                  borderRadius: "50%",
                  backgroundColor: authStatus === "signed_in" ? t.statusSuccess : authStatus === "signed_out" ? t.statusError : t.textMuted,
                  flexShrink: 0,
                })}
              />
              <span className={css({ color: t.textPrimary, flex: 1 })}>Auth</span>
              <span className={`${mono} ${css({ color: authStatus === "signed_in" ? t.statusSuccess : t.statusError })}`}>{authStatus.replace(/_/g, " ")}</span>
            </div>
            <div className={css({ display: "flex", gap: "10px", marginTop: "2px" })}>
              <Stat label="orgs" value={totalOrgs} t={t} css={css} />
              <Stat label="users" value={appSnapshot?.users.length ?? 0} t={t} css={css} />
            </div>
            <div className={`${mono} ${css({ color: t.textTertiary })}`}>app topic: {appState.status}</div>
          </div>
        </Section>

        {/* Snapshot Summary */}
        <Section label="Organization Snapshot" t={t} css={css}>
          <div className={css({ display: "flex", gap: "10px", fontSize: "10px" })}>
            <Stat label="repos" value={repos.length} t={t} css={css} />
            <Stat label="tasks" value={tasks.length} t={t} css={css} />
            <Stat label="PRs" value={prCount} t={t} css={css} />
          </div>
        </Section>

        <Section label="Focused Task" t={t} css={css}>
          {focusedTask ? (
            <div className={css({ display: "flex", flexDirection: "column", gap: "3px", fontSize: "10px" })}>
              <div className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
                <span
                  className={css({
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    backgroundColor: statusColor(focusedTaskStatus ?? focusedTask.status, t),
                    flexShrink: 0,
                  })}
                />
                <span className={css({ color: t.textPrimary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                  {focusedTask.title || focusedTask.id.slice(0, 12)}
                </span>
                <span className={`${mono} ${css({ color: statusColor(focusedTaskStatus ?? focusedTask.status, t) })}`}>
                  {focusedTaskStatus ?? focusedTask.status}
                </span>
              </div>
              <div className={`${mono} ${css({ color: t.textMuted })}`}>{focusedTaskState.detail}</div>
              <div className={`${mono} ${css({ color: t.textTertiary })}`}>task: {focusedTask.id}</div>
              <div className={`${mono} ${css({ color: t.textTertiary })}`}>repo: {focusedTask.repoId}</div>
              <div className={`${mono} ${css({ color: t.textTertiary })}`}>branch: {focusedTask.branch ?? "-"}</div>
            </div>
          ) : (
            <span className={css({ fontSize: "10px", color: t.textMuted })}>No task focused</span>
          )}
        </Section>

        {/* Session — only when a task is focused */}
        {focusedTask && (
          <Section label="Session" t={t} css={css}>
            {(focusedTask.sessions?.length ?? 0) > 0 ? (
              focusedTask.sessions!.map((session) => {
                const isActive = session.id === focusedTask.activeSessionId;
                const thinking = thinkingLabel(session.thinkingSinceMs, now);
                return (
                  <div
                    key={session.id}
                    className={css({
                      display: "flex",
                      flexDirection: "column",
                      gap: "1px",
                      padding: "2px 0",
                      fontSize: "10px",
                    })}
                  >
                    <div className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
                      <span
                        className={css({
                          width: "5px",
                          height: "5px",
                          borderRadius: "50%",
                          backgroundColor: statusColor(session.status, t),
                          flexShrink: 0,
                        })}
                      />
                      <span
                        className={css({
                          color: isActive ? t.textPrimary : t.textTertiary,
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        })}
                      >
                        {session.sessionName || session.id.slice(0, 12)}
                        {isActive ? " *" : ""}
                      </span>
                      <span className={`${mono} ${css({ color: statusColor(session.status, t) })}`}>{session.status}</span>
                    </div>
                    <div className={css({ display: "flex", gap: "6px", paddingLeft: "11px" })}>
                      <span className={`${mono} ${css({ color: t.textMuted })}`}>{session.agent}</span>
                      <span className={`${mono} ${css({ color: t.textMuted })}`}>{session.model}</span>
                      {!session.created && <span className={`${mono} ${css({ color: t.statusWarning })}`}>not created</span>}
                      {session.unread && <span className={`${mono} ${css({ color: t.statusWarning })}`}>unread</span>}
                      {thinking && <span className={`${mono} ${css({ color: t.statusWarning })}`}>{thinking}</span>}
                    </div>
                    {session.errorMessage && (
                      <div className={`${mono} ${css({ color: t.statusError, paddingLeft: "11px", wordBreak: "break-word" })}`}>{session.errorMessage}</div>
                    )}
                    {session.sessionId && <div className={`${mono} ${css({ color: t.textTertiary, paddingLeft: "11px" })}`}>sid: {session.sessionId}</div>}
                  </div>
                );
              })
            ) : (
              <span className={css({ fontSize: "10px", color: t.textMuted })}>No sessions</span>
            )}
          </Section>
        )}

        {/* Sandbox — only when a task is focused */}
        {focusedTask && (
          <Section label="Sandbox" t={t} css={css}>
            {(focusedTask.sandboxes?.length ?? 0) > 0 ? (
              focusedTask.sandboxes!.map((sandbox) => {
                const isActive = sandbox.sandboxId === focusedTask.activeSandboxId;
                return (
                  <div
                    key={sandbox.sandboxId}
                    className={css({
                      display: "flex",
                      flexDirection: "column",
                      gap: "1px",
                      padding: "2px 0",
                      fontSize: "10px",
                    })}
                  >
                    <div className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
                      <span
                        className={css({
                          width: "5px",
                          height: "5px",
                          borderRadius: "50%",
                          backgroundColor: isActive ? t.statusSuccess : t.textMuted,
                          flexShrink: 0,
                        })}
                      />
                      <span
                        className={css({
                          color: isActive ? t.textPrimary : t.textTertiary,
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        })}
                      >
                        {sandbox.sandboxId.slice(0, 16)}
                        {isActive ? " *" : ""}
                      </span>
                      <span className={`${mono} ${css({ color: t.textMuted })}`}>{sandbox.sandboxProviderId}</span>
                    </div>
                    {sandbox.cwd && <div className={`${mono} ${css({ color: t.textTertiary, paddingLeft: "11px" })}`}>cwd: {sandbox.cwd}</div>}
                  </div>
                );
              })
            ) : (
              <span className={css({ fontSize: "10px", color: t.textMuted })}>No sandboxes</span>
            )}
          </Section>
        )}

        {/* GitHub */}
        <Section label="GitHub" t={t} css={css}>
          {liveGithub ? (
            <div className={css({ display: "flex", flexDirection: "column", gap: "3px", fontSize: "10px" })}>
              <div className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
                <span
                  className={css({
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    backgroundColor: installStatusColor(liveGithub.installationStatus, t),
                    flexShrink: 0,
                  })}
                />
                <span className={css({ color: t.textPrimary, flex: 1 })}>App Install</span>
                <span className={`${mono} ${css({ color: installStatusColor(liveGithub.installationStatus, t) })}`}>
                  {liveGithub.installationStatus.replace(/_/g, " ")}
                </span>
              </div>
              <div className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
                <span
                  className={css({
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    backgroundColor: syncStatusColor(liveGithub.syncStatus, t),
                    flexShrink: 0,
                  })}
                />
                <span className={css({ color: t.textPrimary, flex: 1 })}>Sync</span>
                <span className={`${mono} ${css({ color: syncStatusColor(liveGithub.syncStatus, t) })}`}>{liveGithub.syncStatus}</span>
                {liveGithub.lastSyncAt != null && <span className={`${mono} ${css({ color: t.textTertiary })}`}>{timeAgo(liveGithub.lastSyncAt)}</span>}
              </div>
              <div className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
                <span
                  className={css({
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    backgroundColor: hasRecentWebhook ? t.statusSuccess : t.textMuted,
                    flexShrink: 0,
                  })}
                />
                <span className={css({ color: t.textPrimary, flex: 1 })}>Webhook</span>
                {lastWebhookAt != null ? (
                  <span className={`${mono} ${css({ color: hasRecentWebhook ? t.textPrimary : t.textMuted })}`}>
                    {liveGithub.lastWebhookEvent} · {timeAgo(lastWebhookAt)}
                  </span>
                ) : (
                  <span className={`${mono} ${css({ color: t.statusWarning })}`}>never received</span>
                )}
              </div>
              <div className={css({ display: "flex", gap: "10px", marginTop: "2px" })}>
                <Stat label="imported" value={liveGithub.importedRepoCount} t={t} css={css} />
                <Stat label="catalog" value={organization?.repoCatalog.length ?? repos.length} t={t} css={css} />
                <Stat label="target" value={liveGithub.totalRepositoryCount ?? 0} t={t} css={css} />
              </div>
              {liveGithub.connectedAccount && <div className={`${mono} ${css({ color: t.textMuted, marginTop: "1px" })}`}>@{liveGithub.connectedAccount}</div>}
              {liveGithub.lastSyncLabel && <div className={`${mono} ${css({ color: t.textMuted })}`}>last sync: {liveGithub.lastSyncLabel}</div>}
              {liveGithub.syncPhase && (
                <div className={`${mono} ${css({ color: t.textTertiary })}`}>
                  phase: {liveGithub.syncPhase.replace(/^syncing_/, "").replace(/_/g, " ")} ({liveGithub.processedRepositoryCount}/
                  {liveGithub.totalRepositoryCount})
                </div>
              )}
            </div>
          ) : (
            <span className={css({ fontSize: "10px", color: t.textMuted })}>No organization data loaded</span>
          )}
        </Section>

        {/* Organization */}
        <Section label="Organization" t={t} css={css}>
          <div className={`${mono} ${css({ color: t.textTertiary })}`}>{organizationId}</div>
          {organization && (
            <div className={`${mono} ${css({ color: t.textMuted, marginTop: "2px" })}`}>
              org: {organization.settings.displayName} ({organization.kind})
            </div>
          )}
        </Section>
      </div>
    </div>
  );
});

function Section({
  label,
  t,
  css: cssFn,
  children,
}: {
  label: string;
  t: ReturnType<typeof useFoundryTokens>;
  css: ReturnType<typeof useStyletron>[0];
  children: React.ReactNode;
}) {
  return (
    <div className={cssFn({ marginBottom: "6px" })}>
      <div
        className={cssFn({
          fontSize: "9px",
          fontWeight: 600,
          color: t.textMuted,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          marginBottom: "2px",
        })}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  t,
  css: cssFn,
}: {
  label: string;
  value: number;
  t: ReturnType<typeof useFoundryTokens>;
  css: ReturnType<typeof useStyletron>[0];
}) {
  return (
    <span>
      <span className={cssFn({ fontWeight: 600, color: t.textPrimary })}>{value}</span>
      <span className={cssFn({ color: t.textTertiary, marginLeft: "2px" })}>{label}</span>
    </span>
  );
}

export function useDevPanel() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "D" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        setVisible((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return visible;
}
