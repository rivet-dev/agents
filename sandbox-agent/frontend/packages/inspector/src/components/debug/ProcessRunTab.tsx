import { ChevronDown, ChevronRight, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { SandboxAgentError } from "sandbox-agent";
import type { ProcessRunResponse, SandboxAgent } from "sandbox-agent";

const parseArgs = (value: string): string[] =>
  value
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);

const ProcessRunTab = ({ getClient }: { getClient: () => SandboxAgent }) => {
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [cwd, setCwd] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("30000");
  const [maxOutputBytes, setMaxOutputBytes] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessRunResponse | null>(null);

  const handleRun = async () => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setError("Command is required.");
      return;
    }

    setRunning(true);
    setError(null);
    try {
      const response = await getClient().runProcess({
        command: trimmedCommand,
        args: parseArgs(argsText),
        cwd: cwd.trim() || undefined,
        timeoutMs: timeoutMs.trim() ? Number(timeoutMs) : undefined,
        maxOutputBytes: maxOutputBytes.trim() ? Number(maxOutputBytes) : undefined,
      });
      setResult(response);
    } catch (runError) {
      const detail = runError instanceof SandboxAgentError ? runError.problem?.detail : undefined;
      setError(detail || (runError instanceof Error ? runError.message : "Unable to run process."));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="process-run-container">
      <div className="process-run-form">
        <div className="process-run-row">
          <div className="process-run-field process-run-field-grow">
            <label className="label">Command</label>
            <input
              className="setup-input mono"
              value={command}
              onChange={(event) => {
                setCommand(event.target.value);
                setError(null);
              }}
              placeholder="ls"
            />
          </div>
          <div className="process-run-field process-run-field-grow">
            <label className="label">Working Directory</label>
            <input
              className="setup-input mono"
              value={cwd}
              onChange={(event) => {
                setCwd(event.target.value);
                setError(null);
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
              setError(null);
            }}
            placeholder={"One argument per line, e.g.\n-lc"}
          />
        </div>

        <button className="process-advanced-toggle" onClick={() => setShowAdvanced((prev) => !prev)} type="button">
          {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Advanced
        </button>

        {showAdvanced && (
          <div className="process-run-row">
            <div className="process-run-field process-run-field-grow">
              <label className="label">Timeout (ms)</label>
              <input
                className="setup-input mono"
                value={timeoutMs}
                onChange={(event) => {
                  setTimeoutMs(event.target.value);
                  setError(null);
                }}
                placeholder="30000"
              />
            </div>
            <div className="process-run-field process-run-field-grow">
              <label className="label">Max Output Bytes</label>
              <input
                className="setup-input mono"
                value={maxOutputBytes}
                onChange={(event) => {
                  setMaxOutputBytes(event.target.value);
                  setError(null);
                }}
                placeholder="Default"
              />
            </div>
          </div>
        )}

        {error ? <div className="banner error">{error}</div> : null}

        <button className="button primary small" onClick={() => void handleRun()} disabled={running} style={{ alignSelf: "flex-start" }}>
          {running ? <Loader2 className="button-icon spinner-icon" /> : <Play className="button-icon" />}
          {running ? "Running..." : "Run"}
        </button>
      </div>

      {result ? (
        <div className="process-run-result">
          <div className="process-run-result-header">
            <span className={`pill ${result.timedOut ? "warning" : result.exitCode === 0 ? "success" : "danger"}`}>
              {result.timedOut ? "Timed Out" : `exit ${result.exitCode ?? "?"}`}
            </span>
            <span className="card-meta">{result.durationMs}ms</span>
          </div>

          <div className="process-run-output">
            <div className="process-run-output-section">
              <div className="process-run-output-label">stdout{result.stdoutTruncated ? " (truncated)" : ""}</div>
              <pre className="process-log-block">{result.stdout || "(empty)"}</pre>
            </div>
            <div className="process-run-output-section">
              <div className="process-run-output-label">stderr{result.stderrTruncated ? " (truncated)" : ""}</div>
              <pre className="process-log-block">{result.stderr || "(empty)"}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default ProcessRunTab;
