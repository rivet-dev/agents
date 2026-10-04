import { ChevronDown, ChevronRight, Loader2, Play, RefreshCw, Skull, SquareTerminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProcessTerminal } from "@sandbox-agent/react";
import { SandboxAgentError } from "sandbox-agent";
import type { ProcessInfo, SandboxAgent } from "sandbox-agent";

const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof SandboxAgentError && error.problem?.detail) return error.problem.detail;
  if (error instanceof Error) return error.message;
  return fallback;
};

const decodeBase64Utf8 = (value: string): string => {
  try {
    const bytes = Uint8Array.from(window.atob(value), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
};

const formatDateTime = (value: number | null | undefined): string => {
  if (!value) {
    return "Unknown";
  }
  return new Date(value).toLocaleString();
};

const parseArgs = (value: string): string[] =>
  value
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);

const formatCommandSummary = (process: Pick<ProcessInfo, "command" | "args">): string => {
  return [process.command, ...process.args].join(" ").trim();
};

const canOpenTerminal = (process: ProcessInfo | null | undefined): boolean => {
  return Boolean(process && process.status === "running" && process.interactive && process.tty);
};

const ProcessesTab = ({ getClient }: { getClient: () => SandboxAgent }) => {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [cwd, setCwd] = useState("");
  const [interactive, setInteractive] = useState(true);
  const [tty, setTty] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(true);

  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [logsText, setLogsText] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [actingProcessId, setActingProcessId] = useState<string | null>(null);

  const loadProcesses = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (mode === "initial") {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setError(null);
      try {
        const response = await getClient().listProcesses();
        setProcesses(response.processes);
        setSelectedProcessId((current) => {
          if (!current) {
            return response.processes[0]?.id ?? null;
          }
          return response.processes.some((listedProcess) => listedProcess.id === current) ? current : (response.processes[0]?.id ?? null);
        });
      } catch (loadError) {
        setError(extractErrorMessage(loadError, "Unable to load processes."));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [getClient],
  );

  const loadSelectedLogs = useCallback(
    async (process: ProcessInfo | null) => {
      if (!process) {
        setLogsText("");
        setLogsError(null);
        return;
      }
      setLogsLoading(true);
      setLogsError(null);
      try {
        const response = await getClient().getProcessLogs(process.id, {
          stream: process.tty ? "pty" : "combined",
          tail: 200,
        });
        const text = response.entries.map((logEntry) => decodeBase64Utf8(logEntry.data)).join("");
        setLogsText(text);
      } catch (loadError) {
        setLogsError(extractErrorMessage(loadError, "Unable to load process logs."));
        setLogsText("");
      } finally {
        setLogsLoading(false);
      }
    },
    [getClient],
  );

  useEffect(() => {
    void loadProcesses();
  }, [loadProcesses]);

  const selectedProcess = useMemo(() => processes.find((process) => process.id === selectedProcessId) ?? null, [processes, selectedProcessId]);

  useEffect(() => {
    void loadSelectedLogs(selectedProcess);
    if (!canOpenTerminal(selectedProcess)) {
      setTerminalOpen(false);
    }
  }, [loadSelectedLogs, selectedProcess]);

  const handleCreateProcess = async () => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setCreateError("Command is required.");
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const created = await getClient().createProcess({
        command: trimmedCommand,
        args: parseArgs(argsText),
        cwd: cwd.trim() || undefined,
        interactive,
        tty,
      });
      await loadProcesses("refresh");
      setSelectedProcessId(created.id);
      setTerminalOpen(created.interactive && created.tty);
      setCommand("");
      setArgsText("");
      setCwd("");
      setInteractive(true);
      setTty(true);
    } catch (createFailure) {
      setCreateError(extractErrorMessage(createFailure, "Unable to create process."));
    } finally {
      setCreating(false);
    }
  };

  const handleAction = async (processId: string, action: "stop" | "kill" | "delete") => {
    setActingProcessId(`${action}:${processId}`);
    setError(null);
    try {
      const client = getClient();
      if (action === "stop") {
        await client.stopProcess(processId, { waitMs: 2_000 });
      } else if (action === "kill") {
        await client.killProcess(processId, { waitMs: 2_000 });
      } else {
        await client.deleteProcess(processId);
      }
      await loadProcesses("refresh");
    } catch (actionError) {
      setError(extractErrorMessage(actionError, `Unable to ${action} process.`));
    } finally {
      setActingProcessId(null);
    }
  };

  const handleTerminalExit = useCallback(() => {
    void loadProcesses("refresh");
  }, [loadProcesses]);

  return (
    <div className="processes-container">
      {/* Create form */}
      <div className="processes-section">
        <button className="processes-section-toggle" onClick={() => setShowCreateForm((prev) => !prev)} type="button">
          {showCreateForm ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>Create Process</span>
        </button>

        {showCreateForm && (
          <div className="process-create-form">
            <div className="process-run-row">
              <div className="process-run-field process-run-field-grow">
                <label className="label">Command</label>
                <input
                  className="setup-input mono"
                  value={command}
                  onChange={(event) => {
                    setCommand(event.target.value);
                    setCreateError(null);
                  }}
                  placeholder="bash"
                />
              </div>
              <div className="process-run-field process-run-field-grow">
                <label className="label">Working Directory</label>
                <input
                  className="setup-input mono"
                  value={cwd}
                  onChange={(event) => {
                    setCwd(event.target.value);
                    setCreateError(null);
                  }}
                  placeholder="/workspace"
                />
              </div>
            </div>

            <div className="process-run-field">
              <label className="label">Arguments</label>
              <textarea
                className="setup-input mono"
                rows={2}
                value={argsText}
                onChange={(event) => {
                  setArgsText(event.target.value);
                  setCreateError(null);
                }}
                placeholder={"One argument per line"}
              />
            </div>

            <div className="process-checkbox-row">
              <label className="process-checkbox">
                <input
                  type="checkbox"
                  checked={interactive}
                  onChange={(event) => {
                    setInteractive(event.target.checked);
                    if (!event.target.checked) {
                      setTty(false);
                    }
                  }}
                />
                <span>interactive</span>
              </label>
              <label className="process-checkbox">
                <input
                  type="checkbox"
                  checked={tty}
                  onChange={(event) => {
                    setTty(event.target.checked);
                    if (event.target.checked) {
                      setInteractive(true);
                    }
                  }}
                />
                <span>tty</span>
              </label>
            </div>

            {createError ? <div className="banner error">{createError}</div> : null}

            <button className="button primary small" onClick={() => void handleCreateProcess()} disabled={creating} style={{ alignSelf: "flex-start" }}>
              {creating ? <Loader2 className="button-icon spinner-icon" /> : <Play className="button-icon" />}
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        )}
      </div>

      {/* Process list */}
      <div className="processes-section">
        <div className="processes-list-header">
          <span className="processes-section-label">Processes</span>
          <button className="button secondary small" onClick={() => void loadProcesses("refresh")} disabled={loading || refreshing}>
            <RefreshCw className={`button-icon ${loading || refreshing ? "spinner-icon" : ""}`} size={12} />
            Refresh
          </button>
        </div>

        {error ? <div className="banner error">{error}</div> : null}
        {loading ? <div className="card-meta">Loading...</div> : null}
        {!loading && processes.length === 0 ? <div className="card-meta">No processes yet.</div> : null}

        <div className="process-list">
          {processes.map((process) => {
            const isSelected = selectedProcessId === process.id;
            const isStopping = actingProcessId === `stop:${process.id}`;
            const isKilling = actingProcessId === `kill:${process.id}`;
            const isDeleting = actingProcessId === `delete:${process.id}`;
            return (
              <div
                key={process.id}
                className={`process-list-item ${isSelected ? "selected" : ""}`}
                onClick={() => {
                  setSelectedProcessId(process.id);
                  setTerminalOpen(false);
                }}
              >
                <div className="process-list-item-main">
                  <span className={`process-status-dot ${process.status}`} />
                  <span className="process-list-item-cmd mono">{formatCommandSummary(process)}</span>
                  {process.interactive && process.tty && (
                    <span className="pill neutral" style={{ fontSize: 9 }}>
                      tty
                    </span>
                  )}
                </div>
                <div className="process-list-item-meta">
                  <span>PID {process.pid ?? "?"}</span>
                  <span className="process-list-item-id">{process.id.slice(0, 8)}</span>
                </div>
                <div className="process-list-item-actions">
                  {canOpenTerminal(process) ? (
                    <button
                      className="button secondary small"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedProcessId(process.id);
                        setTerminalOpen(true);
                      }}
                    >
                      <SquareTerminal className="button-icon" size={12} />
                      Terminal
                    </button>
                  ) : null}
                  {process.status === "running" ? (
                    <>
                      <button
                        className="button secondary small"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleAction(process.id, "stop");
                        }}
                        disabled={Boolean(actingProcessId)}
                      >
                        {isStopping ? <Loader2 className="button-icon spinner-icon" size={12} /> : null}
                        Stop
                      </button>
                      <button
                        className="button secondary small"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleAction(process.id, "kill");
                        }}
                        disabled={Boolean(actingProcessId)}
                      >
                        {isKilling ? <Loader2 className="button-icon spinner-icon" size={12} /> : <Skull className="button-icon" size={12} />}
                        Kill
                      </button>
                    </>
                  ) : null}
                  {process.status === "exited" ? (
                    <button
                      className="button secondary small"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleAction(process.id, "delete");
                      }}
                      disabled={Boolean(actingProcessId)}
                    >
                      {isDeleting ? <Loader2 className="button-icon spinner-icon" size={12} /> : <Trash2 className="button-icon" size={12} />}
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected process detail */}
      {selectedProcess ? (
        <div className="processes-section">
          <div className="processes-section-label">Detail</div>

          <div className="process-detail">
            <div className="process-detail-header">
              <span className="process-detail-cmd mono">{formatCommandSummary(selectedProcess)}</span>
              <span className={`pill ${selectedProcess.status === "running" ? "success" : "neutral"}`}>{selectedProcess.status}</span>
            </div>

            <div className="process-detail-meta">
              <span>PID: {selectedProcess.pid ?? "?"}</span>
              <span>Created: {formatDateTime(selectedProcess.createdAtMs)}</span>
              {selectedProcess.exitedAtMs ? <span>Exited: {formatDateTime(selectedProcess.exitedAtMs)}</span> : null}
              {selectedProcess.exitCode != null ? <span>Exit code: {selectedProcess.exitCode}</span> : null}
              <span className="mono" style={{ opacity: 0.6 }}>
                {selectedProcess.id}
              </span>
            </div>

            {/* Terminal */}
            {terminalOpen && canOpenTerminal(selectedProcess) ? (
              <ProcessTerminal client={getClient()} processId={selectedProcess.id} style={{ marginTop: 4 }} onExit={handleTerminalExit} />
            ) : canOpenTerminal(selectedProcess) ? (
              <button className="button secondary small" onClick={() => setTerminalOpen(true)} style={{ marginTop: 8 }}>
                <SquareTerminal className="button-icon" size={12} />
                Open Terminal
              </button>
            ) : selectedProcess.interactive && selectedProcess.tty ? (
              <div className="process-terminal-empty">Terminal available while process is running.</div>
            ) : null}

            {/* Logs */}
            <div className="process-detail-logs">
              <div className="process-detail-logs-header">
                <span className="label">Logs</span>
                <button className="button secondary small" onClick={() => void loadSelectedLogs(selectedProcess)} disabled={logsLoading}>
                  {logsLoading ? <Loader2 className="button-icon spinner-icon" size={12} /> : <RefreshCw className="button-icon" size={12} />}
                  Refresh
                </button>
              </div>
              {logsError ? <div className="banner error">{logsError}</div> : null}
              <pre className="process-log-block">{logsText || (logsLoading ? "Loading..." : "(no output)")}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default ProcessesTab;
