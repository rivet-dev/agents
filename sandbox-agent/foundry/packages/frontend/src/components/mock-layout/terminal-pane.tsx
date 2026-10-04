import { type SandboxProcessRecord, useSubscription } from "@sandbox-agent/foundry-client";
import { ProcessTerminal } from "@sandbox-agent/react";
import { useQuery } from "@tanstack/react-query";
import { useStyletron } from "baseui";
import { useFoundryTokens } from "../../app/theme";
import { ChevronDown, ChevronUp, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SandboxAgent } from "sandbox-agent";
import { backendClient } from "../../lib/backend";
import { subscriptionManager } from "../../lib/subscription";

interface TerminalPaneProps {
  organizationId: string;
  taskId: string | null;
  isExpanded?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
  onStartResize?: (e: React.PointerEvent) => void;
}

interface ProcessTab {
  id: string;
  processId: string;
  title: string;
}

const MIN_TERMINAL_HEIGHT = 220;

function defaultShellRequest(cwd?: string | null) {
  return {
    command: "/bin/bash",
    args: ["-lc", 'if [ -n "$SHELL" ] && [ -x "$SHELL" ]; then exec "$SHELL" -l; fi; if [ -x /bin/zsh ]; then exec /bin/zsh -l; fi; exec /bin/bash -l'],
    cwd: cwd ?? undefined,
    interactive: true,
    tty: true,
  };
}

function formatProcessTabTitle(process: Pick<SandboxProcessRecord, "command" | "id">, fallbackIndex: number): string {
  const label = process.command.split("/").pop()?.trim();
  return label && label.length > 0 ? label : `Terminal ${fallbackIndex}`;
}

function formatCommandSummary(process: Pick<SandboxProcessRecord, "command" | "args">): string {
  return [process.command, ...process.args].join(" ").trim();
}

function HeaderIconButton({
  css,
  t,
  label,
  disabled,
  onClick,
  children,
}: {
  css: ReturnType<typeof useStyletron>[0];
  t: ReturnType<typeof useFoundryTokens>;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => {
        if (!disabled) onClick?.();
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) onClick?.();
      }}
      className={css({
        width: "26px",
        height: "26px",
        borderRadius: "6px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: t.textTertiary,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "background 200ms ease, color 200ms ease",
        ":hover": disabled
          ? undefined
          : {
              backgroundColor: t.interactiveHover,
              color: t.textSecondary,
            },
      })}
    >
      {children}
    </div>
  );
}

export function TerminalPane({ organizationId, taskId, isExpanded, onExpand, onCollapse, onStartResize }: TerminalPaneProps) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const [activeSessionId, setActiveTabId] = useState<string | null>(null);
  const [processTabs, setProcessTabs] = useState<ProcessTab[]>([]);
  const [creatingProcess, setCreatingProcess] = useState(false);
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const [terminalClient, setTerminalClient] = useState<SandboxAgent | null>(null);
  const [customTabNames, setCustomTabNames] = useState<Record<string, string>>({});
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Drag-to-reorder state
  const [tabDrag, setTabDrag] = useState<{ fromIdx: number; overIdx: number | null } | null>(null);
  const tabDragRef = useRef<{ fromIdx: number; overIdx: number | null } | null>(null);
  const tabDragStartY = useRef(0);
  const didTabDrag = useRef(false);

  useEffect(() => {
    if (!tabDrag) return;
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      const tabEl = (el as HTMLElement).closest?.("[data-terminal-idx]") as HTMLElement | null;
      if (tabEl) {
        const overIdx = Number(tabEl.dataset.terminalIdx);
        if (overIdx !== tabDrag.overIdx) {
          setTabDrag({ ...tabDrag, overIdx });
          tabDragRef.current = { ...tabDrag, overIdx };
        }
      }
      if (Math.abs(e.clientY - tabDragStartY.current) > 4) {
        didTabDrag.current = true;
      }
    };
    const onUp = () => {
      const d = tabDragRef.current;
      if (d && didTabDrag.current && d.overIdx !== null && d.fromIdx !== d.overIdx) {
        setProcessTabs((prev) => {
          const next = [...prev];
          const [moved] = next.splice(d.fromIdx, 1);
          if (!moved) {
            return prev;
          }
          next.splice(d.overIdx!, 0, moved);
          return next;
        });
      }
      tabDragRef.current = null;
      didTabDrag.current = false;
      setTabDrag(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [tabDrag]);

  // Horizontal splitter for terminal list width
  const DEFAULT_LIST_WIDTH = 180;
  const MIN_LIST_WIDTH = 40;
  const MAX_LIST_WIDTH = 360;
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const splitterRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onSplitterPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      splitterRef.current = { startX: e.clientX, startWidth: listWidth };
      const onMove = (ev: PointerEvent) => {
        if (!splitterRef.current) return;
        // Dragging left = increase list width, dragging right = decrease
        const delta = splitterRef.current.startX - ev.clientX;
        const next = Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, splitterRef.current.startWidth + delta));
        setListWidth(next);
      };
      const onUp = () => {
        splitterRef.current = null;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [listWidth],
  );

  const organizationState = useSubscription(subscriptionManager, "organization", { organizationId });
  const taskSummary = useMemo(
    () => (taskId ? (organizationState.data?.taskSummaries.find((task) => task.id === taskId) ?? null) : null),
    [taskId, organizationState.data?.taskSummaries],
  );
  const taskState = useSubscription(
    subscriptionManager,
    "task",
    taskSummary
      ? {
          organizationId,
          repoId: taskSummary.repoId,
          taskId: taskSummary.id,
        }
      : null,
  );

  const activeSandbox = useMemo(() => {
    const task = taskState.data;
    if (!task?.activeSandboxId) {
      return null;
    }

    return task.sandboxes.find((sandbox) => sandbox.sandboxId === task.activeSandboxId) ?? null;
  }, [taskState.data]);

  const connectionQuery = useQuery({
    queryKey: ["mock-layout", "sandbox-agent-connection", organizationId, activeSandbox?.sandboxProviderId ?? "", activeSandbox?.sandboxId ?? ""],
    enabled: Boolean(activeSandbox?.sandboxId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!activeSandbox) {
        throw new Error("Cannot load a sandbox connection without an active sandbox.");
      }

      return await backendClient.getSandboxAgentConnection(organizationId, activeSandbox.sandboxProviderId, activeSandbox.sandboxId);
    },
  });

  const processesState = useSubscription(
    subscriptionManager,
    "sandboxProcesses",
    activeSandbox
      ? {
          organizationId,
          sandboxProviderId: activeSandbox.sandboxProviderId,
          sandboxId: activeSandbox.sandboxId,
        }
      : null,
  );

  useEffect(() => {
    if (!connectionQuery.data) {
      setTerminalClient((current) => {
        if (current) {
          void current.dispose();
        }
        return null;
      });
      return;
    }

    if (connectionQuery.data.endpoint.startsWith("mock://")) {
      setTerminalClient((current) => {
        if (current) {
          void current.dispose();
        }
        return null;
      });
      return;
    }

    let cancelled = false;
    void SandboxAgent.connect({
      baseUrl: connectionQuery.data.endpoint,
      token: connectionQuery.data.token,
      waitForHealth: false,
    })
      .then((client) => {
        if (cancelled) {
          void client.dispose();
          return;
        }

        setTerminalClient((current) => {
          if (current) {
            void current.dispose();
          }
          return client;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setTerminalClient((current) => {
            if (current) {
              void current.dispose();
            }
            return null;
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connectionQuery.data]);

  useEffect(() => {
    return () => {
      if (terminalClient) {
        void terminalClient.dispose();
      }
    };
  }, [terminalClient]);

  useEffect(() => {
    setActiveTabId(null);
    setProcessTabs([]);
  }, [taskId]);

  const processesData = processesState.data;
  const processes = processesData ?? [];

  const openTerminalTab = useCallback((process: SandboxProcessRecord) => {
    setProcessTabs((current) => {
      const existing = current.find((tab) => tab.processId === process.id);
      if (existing) {
        setActiveTabId(existing.id);
        return current;
      }

      const nextTab: ProcessTab = {
        id: `terminal:${process.id}`,
        processId: process.id,
        title: formatProcessTabTitle(process, current.length + 1),
      };
      setActiveTabId(nextTab.id);
      return [...current, nextTab];
    });
  }, []);

  const closeTerminalTab = useCallback((sessionId: string) => {
    setProcessTabs((current) => {
      const next = current.filter((tab) => tab.id !== sessionId);
      setActiveTabId((currentActive) => {
        if (currentActive === sessionId) {
          return next.length > 0 ? next[next.length - 1]!.id : null;
        }
        return currentActive;
      });
      return next;
    });
  }, []);

  const spawnTerminal = useCallback(async () => {
    if (!activeSandbox?.sandboxId) {
      return;
    }

    setCreatingProcess(true);
    try {
      const created = await backendClient.createSandboxProcess({
        organizationId,
        sandboxProviderId: activeSandbox.sandboxProviderId,
        sandboxId: activeSandbox.sandboxId,
        request: defaultShellRequest(activeSandbox.cwd),
      });
      openTerminalTab(created);
    } finally {
      setCreatingProcess(false);
    }
  }, [activeSandbox, openTerminalTab, organizationId]);

  const processTabsById = useMemo(() => new Map(processTabs.map((tab) => [tab.id, tab])), [processTabs]);
  const activeProcessTab = activeSessionId ? (processTabsById.get(activeSessionId) ?? null) : null;
  const activeTerminalProcess = useMemo(
    () => (activeProcessTab ? (processes.find((process) => process.id === activeProcessTab.processId) ?? null) : null),
    [activeProcessTab, processesData],
  );

  const emptyBodyClassName = css({
    flex: 1,
    minHeight: `${MIN_TERMINAL_HEIGHT}px`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: t.surfacePrimary,
  });

  const emptyCopyClassName = css({
    maxWidth: "340px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    color: t.textSecondary,
    fontSize: "12px",
    lineHeight: 1.6,
    textAlign: "center",
  });

  const renderTerminalView = () => {
    if (!activeProcessTab) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <SquareTerminal size={24} style={{ margin: "0 auto 4px", opacity: 0.4 }} />
            <strong>No terminal open.</strong>
            <span>Click + to open a new terminal session.</span>
          </div>
        </div>
      );
    }

    if (!activeTerminalProcess) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Process not found.</strong>
            <span>This terminal tab points at a process that no longer exists.</span>
          </div>
        </div>
      );
    }

    if (!terminalClient) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Interactive terminal transport is unavailable.</strong>
            <span>Mock mode does not open a live terminal transport.</span>
          </div>
        </div>
      );
    }

    return (
      <div className={css({ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: t.surfacePrimary })}>
        <div
          className={css({
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            borderBottom: `1px solid ${t.borderDefault}`,
            fontSize: "11px",
            color: t.textMuted,
          })}
        >
          <span>{formatCommandSummary(activeTerminalProcess)}</span>
          <span>{activeTerminalProcess.id.slice(0, 8)}</span>
        </div>
        <ProcessTerminal
          key={activeTerminalProcess.id}
          client={terminalClient}
          processId={activeTerminalProcess.id}
          height="100%"
          showStatusBar={false}
          style={{
            flex: 1,
            minHeight: 0,
            border: "none",
            borderRadius: 0,
            background: t.surfacePrimary,
          }}
          terminalStyle={{
            minHeight: 0,
            height: "100%",
            padding: "18px 16px 14px",
          }}
        />
      </div>
    );
  };

  const renderBody = () => {
    if (!taskId) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Select a task to open a terminal.</strong>
          </div>
        </div>
      );
    }

    if (taskState.status === "loading") {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Loading sandbox state...</strong>
          </div>
        </div>
      );
    }

    if (taskState.error) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Could not load task state.</strong>
            <span>{taskState.error.message}</span>
          </div>
        </div>
      );
    }

    if (!activeSandbox?.sandboxId) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Waiting for sandbox...</strong>
            <span>The active task does not have a sandbox runtime yet.</span>
          </div>
        </div>
      );
    }

    return renderTerminalView();
  };

  return (
    <section
      className={css({
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: t.surfacePrimary,
        overflow: "hidden",
      })}
    >
      {/* Resize handle */}
      <div
        onPointerDown={onStartResize}
        className={css({
          height: "3px",
          flexShrink: 0,
          cursor: "ns-resize",
          position: "relative",
          "::before": {
            content: '""',
            position: "absolute",
            top: "-2px",
            left: 0,
            right: 0,
            height: "7px",
          },
        })}
      />
      {/* Full-width header bar */}
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          gap: "6px",
          minHeight: "39px",
          maxHeight: "39px",
          paddingTop: "0",
          paddingRight: "14px",
          paddingBottom: "0",
          paddingLeft: "14px",
          borderTop: `1px solid ${t.borderDefault}`,
          backgroundColor: t.surfacePrimary,
          flexShrink: 0,
        })}
      >
        <SquareTerminal size={14} color={t.textTertiary} />
        <span className={css({ fontSize: "12px", fontWeight: 600, color: t.textSecondary })}>Terminal</span>
        <div className={css({ flex: 1 })} />
        <div className={css({ display: "flex", alignItems: "center", gap: "2px" })}>
          <HeaderIconButton
            css={css}
            t={t}
            label="New terminal"
            disabled={!activeSandbox?.sandboxId || creatingProcess}
            onClick={() => {
              if (activeSandbox?.sandboxId && !creatingProcess) void spawnTerminal();
            }}
          >
            <Plus size={14} />
          </HeaderIconButton>
          <HeaderIconButton
            css={css}
            t={t}
            label="Kill terminal"
            disabled={!activeSessionId}
            onClick={() => {
              if (activeSessionId) closeTerminalTab(activeSessionId);
            }}
          >
            <Trash2 size={13} />
          </HeaderIconButton>
          <HeaderIconButton css={css} t={t} label={isExpanded ? "Collapse terminal" : "Expand terminal"} onClick={isExpanded ? onCollapse : onExpand}>
            {isExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </HeaderIconButton>
        </div>
      </div>

      {/* Two-column body: terminal left, list right — hidden when no tabs */}
      {processTabs.length > 0 && (
        <div className={css({ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" })}>
          {/* Left: terminal content */}
          <div className={css({ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" })}>{renderBody()}</div>

          {/* Splitter */}
          <div
            onPointerDown={onSplitterPointerDown}
            className={css({
              width: "1px",
              flexShrink: 0,
              cursor: "col-resize",
              backgroundColor: t.borderDefault,
              position: "relative",
              "::before": {
                content: '""',
                position: "absolute",
                top: 0,
                bottom: 0,
                left: "-3px",
                width: "7px",
              },
            })}
          />

          {/* Right: vertical terminal list */}
          <div
            className={css({
              width: `${listWidth}px`,
              flexShrink: 0,
              backgroundColor: t.surfacePrimary,
              display: "flex",
              flexDirection: "column",
              overflowY: "auto",
            })}
          >
            {processTabs.map((tab, tabIndex) => {
              const isActive = activeSessionId === tab.id;
              const isHovered = hoveredTabId === tab.id;
              const isDropTarget = tabDrag !== null && tabDrag.overIdx === tabIndex && tabDrag.fromIdx !== tabIndex;
              const isBeingDragged = tabDrag !== null && tabDrag.fromIdx === tabIndex && didTabDrag.current;
              return (
                <div
                  key={tab.id}
                  data-terminal-idx={tabIndex}
                  onMouseEnter={() => setHoveredTabId(tab.id)}
                  onMouseLeave={() => setHoveredTabId((cur) => (cur === tab.id ? null : cur))}
                  onMouseDown={(e) => {
                    if (e.button !== 0 || editingTabId === tab.id) return;
                    tabDragStartY.current = e.clientY;
                    didTabDrag.current = false;
                    const state = { fromIdx: tabIndex, overIdx: null };
                    tabDragRef.current = state;
                    setTabDrag(state);
                  }}
                  onClick={() => {
                    if (!didTabDrag.current) setActiveTabId(tab.id);
                  }}
                  className={css({
                    display: "flex",
                    alignItems: "center",
                    justifyContent: listWidth < 80 ? "center" : "flex-start",
                    gap: "8px",
                    padding: listWidth < 80 ? "8px 0" : "8px 12px",
                    margin: "2px 4px",
                    borderRadius: "8px",
                    cursor: "pointer",
                    overflow: "hidden",
                    position: "relative",
                    "::before": {
                      content: '""',
                      position: "absolute",
                      top: "-2px",
                      left: 0,
                      right: 0,
                      height: "2px",
                      backgroundColor: isDropTarget ? t.textPrimary : "transparent",
                      transition: "background-color 100ms ease",
                    },
                    backgroundColor: isActive ? t.interactiveHover : "transparent",
                    opacity: isBeingDragged ? 0.4 : 1,
                    color: isActive ? t.textPrimary : t.textTertiary,
                    fontWeight: isActive ? 600 : 400,
                    fontSize: "12px",
                    transition: "all 150ms ease",
                    ":hover": {
                      backgroundColor: t.interactiveHover,
                    },
                  })}
                >
                  <SquareTerminal size={14} style={{ flexShrink: 0 }} />
                  {listWidth >= 80 &&
                    (editingTabId === tab.id ? (
                      <input
                        ref={editInputRef}
                        defaultValue={customTabNames[tab.id] ?? tab.title}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const val = e.currentTarget.value.trim();
                          if (val) {
                            setCustomTabNames((prev) => ({ ...prev, [tab.id]: val }));
                          }
                          setEditingTabId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            setEditingTabId(null);
                          }
                        }}
                        className={css({
                          flex: 1,
                          minWidth: 0,
                          background: "transparent",
                          border: "none",
                          outline: "none",
                          color: "inherit",
                          font: "inherit",
                          fontSize: "12px",
                          padding: 0,
                          margin: 0,
                        })}
                      />
                    ) : (
                      <span
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingTabId(tab.id);
                        }}
                        className={css({ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}
                      >
                        {customTabNames[tab.id] ?? tab.title}
                      </span>
                    ))}
                  {listWidth >= 80 && (
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`Close ${tab.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTerminalTab(tab.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") closeTerminalTab(tab.id);
                      }}
                      className={css({
                        width: "18px",
                        height: "18px",
                        borderRadius: "4px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: t.textMuted,
                        flexShrink: 0,
                        opacity: isHovered ? 1 : 0,
                        pointerEvents: isHovered ? "auto" : "none",
                        transition: "opacity 150ms ease, background 200ms ease, color 200ms ease",
                        ":hover": {
                          backgroundColor: "rgba(255, 255, 255, 0.20)",
                          color: t.textSecondary,
                        },
                      })}
                    >
                      <Trash2 size={11} />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Bottom drop zone for dragging to end of list */}
            <div
              data-terminal-idx={processTabs.length}
              className={css({
                flex: 1,
                minHeight: "8px",
                position: "relative",
                "::before": {
                  content: '""',
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: "2px",
                  backgroundColor:
                    tabDrag !== null && tabDrag.overIdx === processTabs.length && tabDrag.fromIdx !== processTabs.length ? t.textPrimary : "transparent",
                  transition: "background-color 100ms ease",
                },
              })}
            />
          </div>
        </div>
      )}
    </section>
  );
}
