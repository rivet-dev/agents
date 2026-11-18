import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStyletron } from "baseui";
import { LabelSmall, LabelXSmall } from "baseui/typography";
import { Select, type Value } from "baseui/select";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CloudUpload,
  CreditCard,
  GitPullRequestDraft,
  ListChecks,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Settings,
  User,
} from "lucide-react";

import { formatRelativeAge, type Task, type RepositorySection } from "./view-model";
import { ContextMenuOverlay, TaskIndicator, PanelHeaderBar, SPanel, ScrollBody, useContextMenu } from "./ui";
import { activeMockOrganization, eligibleOrganizations, useMockAppClient, useMockAppSnapshot } from "../../lib/mock-app";
import { useFoundryTokens } from "../../app/theme";
import type { FoundryTokens } from "../../styles/tokens";

const REPOSITORY_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"];

/** Strip the org prefix (e.g. "rivet-dev/") when all repos share the same org. */
function stripCommonOrgPrefix(label: string, repos: Array<{ label: string }>): string {
  const slashIdx = label.indexOf("/");
  if (slashIdx < 0) return label;
  const prefix = label.slice(0, slashIdx + 1);
  if (repos.every((r) => r.label.startsWith(prefix))) {
    return label.slice(slashIdx + 1);
  }
  return label;
}

function repositoryInitial(label: string): string {
  const parts = label.split("/");
  const name = parts[parts.length - 1] ?? label;
  return name.charAt(0).toUpperCase();
}

function repositoryIconColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return REPOSITORY_COLORS[Math.abs(hash) % REPOSITORY_COLORS.length]!;
}

export const Sidebar = memo(function Sidebar({
  repositories,
  newTaskRepos,
  selectedNewTaskRepoId,
  activeId,
  onSelect,
  onCreate,
  onSelectNewTaskRepo,
  onMarkUnread,
  onRenameTask,
  onReorderRepositories,
  taskOrderByRepository,
  onReorderTasks,
  onReloadOrganization,
  onReloadRepository,
  onToggleSidebar,
}: {
  repositories: RepositorySection[];
  newTaskRepos: Array<{ id: string; label: string }>;
  selectedNewTaskRepoId: string;
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (repoId?: string) => void;
  onSelectNewTaskRepo: (repoId: string) => void;
  onMarkUnread: (id: string) => void;
  onRenameTask: (id: string) => void;
  onReorderRepositories: (fromIndex: number, toIndex: number) => void;
  taskOrderByRepository: Record<string, string[]>;
  onReorderTasks: (repositoryId: string, fromIndex: number, toIndex: number) => void;
  onReloadOrganization: () => void;
  onReloadRepository: (repoId: string) => void;
  onToggleSidebar?: () => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const contextMenu = useContextMenu();
  const [collapsedRepositories, setCollapsedRepositories] = useState<Record<string, boolean>>({});
  const [hoveredRepositoryId, setHoveredRepositoryId] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mouse-based drag and drop state
  type DragState =
    | { type: "repository"; fromIdx: number; overIdx: number | null }
    | { type: "task"; repositoryId: string; fromIdx: number; overIdx: number | null }
    | null;
  const [drag, setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  const startYRef = useRef(0);
  const didDragRef = useRef(false);

  // Attach global mousemove/mouseup when dragging
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      // Detect which element is under the cursor using data attributes
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      const repositoryEl = (el as HTMLElement).closest?.("[data-repository-idx]") as HTMLElement | null;
      const taskEl = (el as HTMLElement).closest?.("[data-task-idx]") as HTMLElement | null;

      if (drag.type === "repository" && repositoryEl) {
        const overIdx = Number(repositoryEl.dataset.repositoryIdx);
        if (overIdx !== drag.overIdx) {
          setDrag({ ...drag, overIdx });
          dragRef.current = { ...drag, overIdx };
        }
      } else if (drag.type === "task" && taskEl) {
        const overRepositoryId = taskEl.dataset.taskRepositoryId ?? "";
        const overIdx = Number(taskEl.dataset.taskIdx);
        if (overRepositoryId === drag.repositoryId && overIdx !== drag.overIdx) {
          setDrag({ ...drag, overIdx });
          dragRef.current = { ...drag, overIdx };
        }
      }
      // Mark that we actually moved (to distinguish from clicks)
      if (Math.abs(e.clientY - startYRef.current) > 4) {
        didDragRef.current = true;
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d && didDragRef.current && d.overIdx !== null && d.fromIdx !== d.overIdx) {
        if (d.type === "repository") {
          onReorderRepositories(d.fromIdx, d.overIdx);
        } else {
          onReorderTasks(d.repositoryId, d.fromIdx, d.overIdx);
        }
      }
      dragRef.current = null;
      didDragRef.current = false;
      setDrag(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [drag, onReorderRepositories, onReorderTasks]);

  useEffect(() => {
    if (!headerMenuOpen) {
      return;
    }
    const onMouseDown = (event: MouseEvent) => {
      if (headerMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setHeaderMenuOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [headerMenuOpen]);

  const [createSelectOpen, setCreateSelectOpen] = useState(false);
  const selectOptions = useMemo(() => newTaskRepos.map((repo) => ({ id: repo.id, label: stripCommonOrgPrefix(repo.label, newTaskRepos) })), [newTaskRepos]);
  type FlatItem =
    | { key: string; type: "repository-header"; repository: RepositorySection; repositoryIndex: number }
    | { key: string; type: "task"; repository: RepositorySection; repositoryIndex: number; task: Task; taskIndex: number }
    | { key: string; type: "task-drop-zone"; repository: RepositorySection; repositoryIndex: number; taskCount: number }
    | { key: string; type: "repository-drop-zone"; repositoryCount: number };
  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    repositories.forEach((repository, repositoryIndex) => {
      items.push({ key: `repository:${repository.id}`, type: "repository-header", repository, repositoryIndex });
      if (!collapsedRepositories[repository.id]) {
        const orderedTaskIds = taskOrderByRepository[repository.id];
        const orderedTasks = orderedTaskIds
          ? (() => {
              const byId = new Map(repository.tasks.map((t) => [t.id, t]));
              const sorted = orderedTaskIds.map((id) => byId.get(id)).filter(Boolean) as typeof repository.tasks;
              for (const t of repository.tasks) {
                if (!orderedTaskIds.includes(t.id)) sorted.push(t);
              }
              return sorted;
            })()
          : repository.tasks;
        orderedTasks.forEach((task, taskIndex) => {
          items.push({ key: `task:${task.id}`, type: "task" as const, repository, repositoryIndex, task, taskIndex });
        });
        items.push({ key: `task-drop:${repository.id}`, type: "task-drop-zone", repository, repositoryIndex, taskCount: orderedTasks.length });
      }
    });
    items.push({ key: "repository-drop-zone", type: "repository-drop-zone", repositoryCount: repositories.length });
    return items;
  }, [collapsedRepositories, repositories, taskOrderByRepository]);
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getItemKey: (index) => flatItems[index]?.key ?? index,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 12,
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  return (
    <SPanel>
      <style>{`
        [data-repository-header]:hover [data-chevron] {
          display: inline-flex !important;
        }
        [data-repository-header]:hover [data-repository-icon] {
          display: none !important;
        }
      `}</style>
      {import.meta.env.VITE_DESKTOP ? (
        <div
          className={css({
            height: "38px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            paddingRight: "10px",
            flexShrink: 0,
            position: "relative",
            zIndex: 9999,
          })}
        >
          {onToggleSidebar ? (
            <div
              role="button"
              tabIndex={0}
              onClick={onToggleSidebar}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onToggleSidebar();
              }}
              className={css({
                width: "26px",
                height: "26px",
                borderRadius: "6px",
                color: t.textTertiary,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                ":hover": { color: t.textSecondary, backgroundColor: t.interactiveHover },
              })}
            >
              <PanelLeft size={14} />
            </div>
          ) : null}
        </div>
      ) : null}
      <PanelHeaderBar $style={{ backgroundColor: "transparent", borderBottom: "none" }}>
        <LabelSmall
          color={t.textPrimary}
          $style={{ fontWeight: 500, flex: 1, fontSize: "13px", display: "flex", alignItems: "center", gap: "6px", lineHeight: 1 }}
        >
          <ListChecks size={14} />
          Tasks
        </LabelSmall>
        {!import.meta.env.VITE_DESKTOP && onToggleSidebar ? (
          <div
            role="button"
            tabIndex={0}
            onClick={onToggleSidebar}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onToggleSidebar();
            }}
            className={css({
              width: "26px",
              height: "26px",
              borderRadius: "6px",
              color: t.textTertiary,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              ":hover": { color: t.textSecondary, backgroundColor: t.interactiveHover },
            })}
          >
            <PanelLeft size={14} />
          </div>
        ) : null}
        {createSelectOpen ? (
          <div className={css({ flex: 1, minWidth: 0 })}>
            <Select
              options={selectOptions}
              value={[]}
              placeholder="Search repos..."
              type="search"
              openOnClick
              autoFocus
              onChange={({ value }: { value: Value }) => {
                const selected = value[0];
                if (selected) {
                  onSelectNewTaskRepo(selected.id as string);
                  setCreateSelectOpen(false);
                  onCreate(selected.id as string);
                }
              }}
              onClose={() => setCreateSelectOpen(false)}
              overrides={{
                Root: {
                  style: {
                    width: "100%",
                  },
                },
                ControlContainer: {
                  style: {
                    backgroundColor: t.surfaceTertiary,
                    borderTopColor: t.borderSubtle,
                    borderBottomColor: t.borderSubtle,
                    borderLeftColor: t.borderSubtle,
                    borderRightColor: t.borderSubtle,
                    borderTopWidth: "1px",
                    borderBottomWidth: "1px",
                    borderLeftWidth: "1px",
                    borderRightWidth: "1px",
                    borderTopLeftRadius: "6px",
                    borderTopRightRadius: "6px",
                    borderBottomLeftRadius: "6px",
                    borderBottomRightRadius: "6px",
                    minHeight: "28px",
                    paddingLeft: "8px",
                  },
                },
                ValueContainer: {
                  style: {
                    paddingTop: "0px",
                    paddingBottom: "0px",
                  },
                },
                Input: {
                  style: {
                    fontSize: "12px",
                    color: t.textPrimary,
                  },
                },
                Placeholder: {
                  style: {
                    fontSize: "12px",
                    color: t.textMuted,
                  },
                },
                Dropdown: {
                  style: {
                    backgroundColor: t.surfaceElevated,
                    borderTopColor: t.borderDefault,
                    borderBottomColor: t.borderDefault,
                    borderLeftColor: t.borderDefault,
                    borderRightColor: t.borderDefault,
                    maxHeight: "min(320px, 50vh)",
                  },
                },
                DropdownListItem: {
                  style: {
                    fontSize: "12px",
                    paddingTop: "6px",
                    paddingBottom: "6px",
                  },
                },
                IconsContainer: {
                  style: {
                    paddingRight: "4px",
                  },
                },
                SearchIconContainer: {
                  style: {
                    paddingLeft: "0px",
                    paddingRight: "4px",
                  },
                },
              }}
            />
          </div>
        ) : (
          <div className={css({ display: "flex", alignItems: "center", gap: "6px", position: "relative" })} ref={headerMenuRef}>
            <button
              type="button"
              onClick={() => setHeaderMenuOpen((value) => !value)}
              className={css({
                width: "26px",
                height: "26px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: t.interactiveHover,
                color: t.textPrimary,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 200ms ease",
                flexShrink: 0,
                ":hover": { backgroundColor: t.borderMedium },
              })}
              title="GitHub actions"
            >
              <MoreHorizontal size={14} />
            </button>
            {headerMenuOpen ? (
              <div
                className={css({
                  position: "absolute",
                  top: "32px",
                  right: 0,
                  minWidth: "180px",
                  padding: "6px",
                  borderRadius: "10px",
                  backgroundColor: t.surfaceElevated,
                  border: `1px solid ${t.borderDefault}`,
                  boxShadow: `${t.shadow}, 0 0 0 1px ${t.interactiveSubtle}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  zIndex: 20,
                })}
              >
                <button
                  type="button"
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    onReloadOrganization();
                  }}
                  className={css(menuButtonStyle(false, t))}
                >
                  Reload organization
                </button>
              </div>
            ) : null}
            <div
              role="button"
              tabIndex={0}
              aria-disabled={newTaskRepos.length === 0}
              onClick={() => {
                if (newTaskRepos.length === 0) return;
                if (newTaskRepos.length === 1) {
                  onSelectNewTaskRepo(newTaskRepos[0]!.id);
                  onCreate(newTaskRepos[0]!.id);
                } else {
                  setCreateSelectOpen(true);
                }
              }}
              onKeyDown={(event) => {
                if (newTaskRepos.length === 0) return;
                if (event.key === "Enter" || event.key === " ") {
                  if (newTaskRepos.length === 1) {
                    onSelectNewTaskRepo(newTaskRepos[0]!.id);
                    onCreate(newTaskRepos[0]!.id);
                  } else {
                    setCreateSelectOpen(true);
                  }
                }
              }}
              className={css({
                width: "26px",
                height: "26px",
                borderRadius: "8px",
                backgroundColor: newTaskRepos.length > 0 ? t.borderMedium : t.interactiveHover,
                color: t.textPrimary,
                cursor: newTaskRepos.length > 0 ? "pointer" : "not-allowed",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 200ms ease",
                flexShrink: 0,
                opacity: newTaskRepos.length > 0 ? 1 : 0.6,
                ":hover": newTaskRepos.length > 0 ? { backgroundColor: "rgba(255, 255, 255, 0.20)" } : undefined,
              })}
            >
              <Plus size={14} style={{ display: "block" }} />
            </div>
          </div>
        )}
      </PanelHeaderBar>
      <ScrollBody ref={scrollRef}>
        <div className={css({ padding: "8px" })}>
          <div
            className={css({ position: "relative", width: "100%" })}
            style={{
              height: `${virtualizer.getTotalSize()}px`,
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = flatItems[virtualItem.index];
              if (!item) {
                return null;
              }

              if (item.type === "repository-header") {
                const { repository, repositoryIndex } = item;
                const isCollapsed = collapsedRepositories[repository.id] === true;
                const isRepositoryDropTarget = drag?.type === "repository" && drag.overIdx === repositoryIndex && drag.fromIdx !== repositoryIndex;
                const isBeingDragged = drag?.type === "repository" && drag.fromIdx === repositoryIndex && didDragRef.current;

                return (
                  <div
                    key={item.key}
                    data-index={virtualItem.index}
                    data-repository-idx={repositoryIndex}
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
                      opacity: isBeingDragged ? 0.4 : 1,
                      transition: "opacity 150ms ease",
                    }}
                  >
                    {isRepositoryDropTarget ? (
                      <div className={css({ height: "2px", backgroundColor: t.textPrimary, transition: "background-color 100ms ease" })} />
                    ) : null}
                    <div className={css({ paddingBottom: "4px" })}>
                      <div
                        onMouseEnter={() => setHoveredRepositoryId(repository.id)}
                        onMouseLeave={() => setHoveredRepositoryId((cur) => (cur === repository.id ? null : cur))}
                        onMouseDown={(event) => {
                          if (event.button !== 0) return;
                          startYRef.current = event.clientY;
                          didDragRef.current = false;
                          setHoveredRepositoryId(null);
                          const state: DragState = { type: "repository", fromIdx: repositoryIndex, overIdx: null };
                          dragRef.current = state;
                          setDrag(state);
                        }}
                        onClick={() => {
                          if (!didDragRef.current) {
                            setCollapsedRepositories((current) => ({
                              ...current,
                              [repository.id]: !current[repository.id],
                            }));
                          }
                        }}
                        onContextMenu={(event) =>
                          contextMenu.open(event, [
                            { label: "Reload repository", onClick: () => onReloadRepository(repository.id) },
                            { label: "New task", onClick: () => onCreate(repository.id) },
                          ])
                        }
                        data-repository-header
                        className={css({
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 8px 4px",
                          gap: "8px",
                          cursor: "grab",
                          userSelect: "none",
                        })}
                      >
                        <div className={css({ display: "flex", alignItems: "center", gap: "4px", overflow: "hidden" })}>
                          <div className={css({ position: "relative", width: "14px", height: "14px", flexShrink: 0 })}>
                            <span
                              className={css({
                                position: "absolute",
                                inset: 0,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                borderRadius: "3px",
                                fontSize: "9px",
                                fontWeight: 700,
                                lineHeight: 1,
                                color: t.textOnAccent,
                                backgroundColor: repositoryIconColor(repository.label),
                              })}
                              data-repository-icon
                            >
                              {repositoryInitial(repository.label)}
                            </span>
                            <span
                              className={css({ position: "absolute", inset: 0, display: "none", alignItems: "center", justifyContent: "center" })}
                              data-chevron
                            >
                              {isCollapsed ? <ChevronDown size={12} color={t.textTertiary} /> : <ChevronUp size={12} color={t.textTertiary} />}
                            </span>
                          </div>
                          <LabelSmall
                            color={t.textSecondary}
                            $style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              letterSpacing: "0.05em",
                              textTransform: "uppercase",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {stripCommonOrgPrefix(repository.label, repositories)}
                          </LabelSmall>
                        </div>
                        <div className={css({ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 })}>
                          {isCollapsed ? <LabelXSmall color={t.textTertiary}>{formatRelativeAge(repository.updatedAtMs)}</LabelXSmall> : null}
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              setHoveredRepositoryId(null);
                              onSelectNewTaskRepo(repository.id);
                              onCreate(repository.id);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className={css({
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: "26px",
                              height: "26px",
                              borderRadius: "6px",
                              border: "none",
                              backgroundColor: "transparent",
                              padding: 0,
                              margin: 0,
                              cursor: "pointer",
                              color: t.textTertiary,
                              opacity: hoveredRepositoryId === repository.id ? 1 : 0,
                              transition: "opacity 150ms ease, background-color 200ms ease, color 200ms ease",
                              pointerEvents: hoveredRepositoryId === repository.id ? "auto" : "none",
                              ":hover": { backgroundColor: t.interactiveHover, color: t.textSecondary },
                            })}
                            title={`New task in ${repository.label}`}
                          >
                            <Plus size={12} color={t.textTertiary} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              if (item.type === "task") {
                const { repository, task, taskIndex } = item;
                const isActive = task.id === activeId;
                const isRunning = task.sessions.some((s) => s.status === "running");
                const isProvisioning =
                  (String(task.status).startsWith("init_") && task.status !== "init_complete") ||
                  task.sessions.some((s) => s.status === "pending_provision" || s.status === "pending_session_create");
                const hasUnread = task.sessions.some((s) => s.unread);
                const isDraft = task.pullRequest?.isDraft ?? true;
                const totalAdded = task.fileChanges.reduce((sum, file) => sum + file.added, 0);
                const totalRemoved = task.fileChanges.reduce((sum, file) => sum + file.removed, 0);
                const hasDiffs = totalAdded > 0 || totalRemoved > 0;
                const isTaskDropTarget =
                  drag?.type === "task" && drag.repositoryId === repository.id && drag.overIdx === taskIndex && drag.fromIdx !== taskIndex;
                const isTaskBeingDragged = drag?.type === "task" && drag.repositoryId === repository.id && drag.fromIdx === taskIndex && didDragRef.current;

                return (
                  <div
                    key={item.key}
                    data-index={virtualItem.index}
                    data-task-idx={taskIndex}
                    data-task-repository-id={repository.id}
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
                      opacity: isTaskBeingDragged ? 0.4 : 1,
                      transition: "opacity 150ms ease",
                    }}
                    onMouseDown={(event) => {
                      if (event.button !== 0) return;
                      if (dragRef.current) return;
                      event.stopPropagation();
                      startYRef.current = event.clientY;
                      didDragRef.current = false;
                      const state: DragState = { type: "task", repositoryId: repository.id, fromIdx: taskIndex, overIdx: null };
                      dragRef.current = state;
                      setDrag(state);
                    }}
                  >
                    {isTaskDropTarget ? (
                      <div className={css({ height: "2px", backgroundColor: t.textPrimary, transition: "background-color 100ms ease" })} />
                    ) : null}
                    <div className={css({ paddingBottom: "4px" })}>
                      <div
                        onClick={() => onSelect(task.id)}
                        onContextMenu={(event) => {
                          const items = [
                            { label: "Rename task", onClick: () => onRenameTask(task.id) },
                            { label: "Mark as unread", onClick: () => onMarkUnread(task.id) },
                          ];
                          contextMenu.open(event, items);
                        }}
                        className={css({
                          padding: "8px 12px",
                          borderRadius: "8px",
                          backgroundColor: isActive ? t.interactiveHover : "transparent",
                          cursor: "pointer",
                          transition: "all 150ms ease",
                          ":hover": {
                            backgroundColor: t.interactiveHover,
                          },
                        })}
                      >
                        <div className={css({ display: "flex", alignItems: "center", gap: "8px" })}>
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
                            <TaskIndicator isRunning={isRunning} isProvisioning={isProvisioning} hasUnread={hasUnread} isDraft={isDraft} />
                          </div>
                          <div className={css({ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: "1px" })}>
                            <LabelSmall
                              $style={{
                                fontWeight: hasUnread ? 600 : 400,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                minWidth: 0,
                                flexShrink: 1,
                              }}
                              color={hasUnread ? t.textPrimary : t.textSecondary}
                            >
                              {task.title}
                            </LabelSmall>
                          </div>
                          {task.primaryUserLogin ? (
                            <span
                              className={css({
                                fontSize: "10px",
                                fontWeight: 500,
                                color: t.statusSuccess,
                                whiteSpace: "nowrap",
                                flexShrink: 0,
                                maxWidth: "80px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              })}
                              title={task.primaryUserLogin}
                            >
                              {task.primaryUserLogin}
                            </span>
                          ) : null}
                          {task.pullRequest != null ? (
                            <span className={css({ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 })}>
                              <LabelXSmall color={t.textSecondary} $style={{ fontWeight: 600 }}>
                                #{task.pullRequest.number}
                              </LabelXSmall>
                              {task.pullRequest.isDraft ? <CloudUpload size={11} color={t.accent} /> : null}
                            </span>
                          ) : (
                            <GitPullRequestDraft size={11} color={t.textTertiary} />
                          )}
                          {hasDiffs ? (
                            <div className={css({ display: "flex", gap: "4px", flexShrink: 0, marginLeft: "auto" })}>
                              <span className={css({ fontSize: "11px", color: t.statusSuccess })}>+{totalAdded}</span>
                              <span className={css({ fontSize: "11px", color: t.statusError })}>-{totalRemoved}</span>
                            </div>
                          ) : null}
                          <LabelXSmall color={t.textTertiary} $style={{ flexShrink: 0, marginLeft: hasDiffs ? undefined : "auto" }}>
                            {formatRelativeAge(task.updatedAtMs)}
                          </LabelXSmall>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              if (item.type === "task-drop-zone") {
                const { repository, taskCount } = item;
                const isDropTarget = drag?.type === "task" && drag.repositoryId === repository.id && drag.overIdx === taskCount && drag.fromIdx !== taskCount;
                return (
                  <div
                    key={item.key}
                    data-index={virtualItem.index}
                    data-task-idx={taskCount}
                    data-task-repository-id={repository.id}
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
                    className={css({
                      minHeight: "4px",
                      position: "relative",
                      "::before": {
                        content: '""',
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        height: "2px",
                        backgroundColor: isDropTarget ? t.textPrimary : "transparent",
                        transition: "background-color 100ms ease",
                      },
                    })}
                  />
                );
              }

              if (item.type === "repository-drop-zone") {
                const isDropTarget = drag?.type === "repository" && drag.overIdx === item.repositoryCount && drag.fromIdx !== item.repositoryCount;
                return (
                  <div
                    key={item.key}
                    data-index={virtualItem.index}
                    data-repository-idx={item.repositoryCount}
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
                    className={css({
                      minHeight: "4px",
                      position: "relative",
                      "::before": {
                        content: '""',
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        height: "2px",
                        backgroundColor: isDropTarget ? t.textPrimary : "transparent",
                        transition: "background-color 100ms ease",
                      },
                    })}
                  />
                );
              }

              return null;
            })}
          </div>
        </div>
      </ScrollBody>
      <SidebarFooter />
      {contextMenu.menu ? <ContextMenuOverlay menu={contextMenu.menu} onClose={contextMenu.close} /> : null}
    </SPanel>
  );
});

const menuButtonStyle = (highlight: boolean, tokens: FoundryTokens) =>
  ({
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "8px 12px",
    borderRadius: "6px",
    border: "none",
    background: highlight ? tokens.interactiveHover : "transparent",
    color: tokens.textSecondary,
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 400 as const,
    textAlign: "left" as const,
    transition: "background 120ms ease, color 120ms ease",
  }) satisfies React.CSSProperties;

function SidebarFooter() {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const navigate = useNavigate();
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const organization = activeMockOrganization(snapshot);
  const [open, setOpen] = useState(false);
  const [organizationFlyoutOpen, setOrganizationFlyoutOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const flyoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const organizationTriggerRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (organizationFlyoutOpen && organizationTriggerRef.current) {
      const rect = organizationTriggerRef.current.getBoundingClientRect();
      setFlyoutPos({ top: rect.top, left: rect.right + 4 });
    }
  }, [organizationFlyoutOpen]);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      const target = event.target as Node;
      const inContainer = containerRef.current?.contains(target);
      const inFlyout = flyoutRef.current?.contains(target);
      if (!inContainer && !inFlyout) {
        setOpen(false);
        setOrganizationFlyoutOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const switchToOrg = useCallback(
    (org: (typeof snapshot.organizations)[number]) => {
      setOpen(false);
      setOrganizationFlyoutOpen(false);
      void (async () => {
        await client.selectOrganization(org.id);
        await navigate({ to: `/organizations/${org.organizationId}` as never });
      })();
    },
    [client, navigate],
  );

  const openFlyout = useCallback(() => {
    if (flyoutTimerRef.current) clearTimeout(flyoutTimerRef.current);
    setOrganizationFlyoutOpen(true);
  }, []);

  const closeFlyout = useCallback(() => {
    flyoutTimerRef.current = setTimeout(() => setOrganizationFlyoutOpen(false), 150);
  }, []);

  const menuItems: Array<{ icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }> = [];

  if (organization) {
    menuItems.push(
      {
        icon: <Settings size={14} />,
        label: "Settings",
        onClick: () => {
          setOpen(false);
          void navigate({ to: "/organizations/$organizationId/settings" as never, params: { organizationId: organization.id } as never });
        },
      },
      {
        icon: <CreditCard size={14} />,
        label: "Billing",
        onClick: () => {
          setOpen(false);
          void navigate({ to: "/organizations/$organizationId/billing" as never, params: { organizationId: organization.id } as never });
        },
      },
    );
  }

  menuItems.push(
    {
      icon: <User size={14} />,
      label: "Account",
      onClick: () => {
        setOpen(false);
        void navigate({ to: "/account" as never });
      },
    },
    {
      icon: <LogOut size={14} />,
      label: "Sign Out",
      danger: true,
      onClick: () => {
        setOpen(false);
        void (async () => {
          await client.signOut();
          await navigate({ to: "/signin" });
        })();
      },
    },
  );

  const popoverStyle = css({
    borderRadius: "10px",
    border: `1px solid ${t.borderDefault}`,
    backgroundColor: t.surfaceElevated,
    boxShadow: `${t.shadow}, 0 0 0 1px ${t.interactiveSubtle}`,
    padding: "4px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  });

  return (
    <div ref={containerRef} className={css({ position: "relative", flexShrink: 0 })}>
      {open ? (
        <div
          className={css({
            position: "absolute",
            bottom: "100%",
            left: "8px",
            right: "8px",
            marginBottom: "4px",
            zIndex: 9999,
          })}
        >
          <div className={popoverStyle}>
            {/* Organization flyout trigger */}
            {organization ? (
              <div ref={organizationTriggerRef} onMouseEnter={openFlyout} onMouseLeave={closeFlyout}>
                <button
                  type="button"
                  onClick={() => setOrganizationFlyoutOpen((prev) => !prev)}
                  className={css({
                    ...menuButtonStyle(organizationFlyoutOpen, t),
                    fontWeight: 500,
                    ":hover": {
                      backgroundColor: t.interactiveHover,
                      color: t.textPrimary,
                    },
                  })}
                >
                  <span
                    className={css({
                      width: "18px",
                      height: "18px",
                      borderRadius: "4px",
                      background: `linear-gradient(135deg, ${repositoryIconColor(organization.settings.displayName)}, ${repositoryIconColor(organization.settings.displayName + "x")})`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "9px",
                      fontWeight: 700,
                      color: t.textOnAccent,
                      flexShrink: 0,
                    })}
                  >
                    {organization.settings.displayName.charAt(0).toUpperCase()}
                  </span>
                  <span className={css({ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                    {organization.settings.displayName}
                  </span>
                  <ChevronRight size={12} className={css({ flexShrink: 0, color: t.textMuted })} />
                </button>
              </div>
            ) : null}

            {/* Organization flyout portal */}
            {organizationFlyoutOpen && organization && flyoutPos
              ? createPortal(
                  <div
                    ref={flyoutRef}
                    className={css({
                      position: "fixed",
                      top: `${flyoutPos.top}px`,
                      left: `${flyoutPos.left}px`,
                      minWidth: "200px",
                      zIndex: 10000,
                    })}
                    onMouseEnter={() => {
                      openFlyout();
                    }}
                    onMouseLeave={() => {
                      closeFlyout();
                    }}
                  >
                    <div className={popoverStyle}>
                      {eligibleOrganizations(snapshot).map((org) => {
                        const isActive = organization.id === org.id;
                        return (
                          <button
                            key={org.id}
                            type="button"
                            onClick={() => {
                              if (!isActive) switchToOrg(org);
                              else {
                                setOpen(false);
                                setOrganizationFlyoutOpen(false);
                              }
                            }}
                            className={css({
                              ...menuButtonStyle(isActive, t),
                              fontWeight: isActive ? 600 : 400,
                              color: isActive ? t.textPrimary : t.textTertiary,
                              ":hover": {
                                backgroundColor: t.interactiveHover,
                                color: t.textPrimary,
                              },
                            })}
                          >
                            <span
                              className={css({
                                width: "18px",
                                height: "18px",
                                borderRadius: "4px",
                                background: `linear-gradient(135deg, ${repositoryIconColor(org.settings.displayName)}, ${repositoryIconColor(org.settings.displayName + "x")})`,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "9px",
                                fontWeight: 700,
                                color: t.textOnAccent,
                                flexShrink: 0,
                              })}
                            >
                              {org.settings.displayName.charAt(0).toUpperCase()}
                            </span>
                            <span className={css({ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                              {org.settings.displayName}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>,
                  document.body,
                )
              : null}

            {menuItems.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.onClick}
                className={css({
                  ...menuButtonStyle(false, t),
                  color: item.danger ? t.statusError : t.textSecondary,
                  ":hover": {
                    backgroundColor: t.interactiveHover,
                    color: item.danger ? t.statusError : t.textPrimary,
                  },
                })}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className={css({ padding: "8px" })}>
        <button
          type="button"
          onClick={() => {
            setOpen((prev) => {
              if (prev) setOrganizationFlyoutOpen(false);
              return !prev;
            });
          }}
          className={css({
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "28px",
            height: "28px",
            borderRadius: "6px",
            border: "none",
            background: open ? t.interactiveHover : "transparent",
            color: open ? t.textPrimary : t.textTertiary,
            cursor: "pointer",
            transition: "all 160ms ease",
            ":hover": {
              backgroundColor: t.interactiveHover,
              color: t.textSecondary,
            },
          })}
        >
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}
