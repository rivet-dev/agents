import { useState, useRef, useEffect, useCallback } from "react";
import { SandboxAgent } from "sandbox-agent";
import type { PermissionEventData, QuestionEventData } from "sandbox-agent";

export function App() {
  const [sandboxName, setSandboxName] = useState("demo");
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "thinking">("idle");
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<SandboxAgent | null>(null);
  const sessionIdRef = useRef<string>(`session-${Date.now()}`);
  const abortRef = useRef<AbortController | null>(null);
  const isThinkingRef = useRef(false);

  const log = useCallback((msg: string) => {
    setOutput((prev) => prev + msg + "\n");
  }, []);

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    setOutput("");

    try {
      // Connect via proxy endpoint (need full URL for SDK)
      const baseUrl = `${window.location.origin}/sandbox/${encodeURIComponent(sandboxName)}/proxy`;
      log(`Connecting to sandbox: ${sandboxName}`);

      const client = await SandboxAgent.connect({ baseUrl });
      clientRef.current = client;

      // Wait for health (this also ensures the container is started)
      log("Waiting for sandbox-agent to be ready...");
      for (let i = 0; i < 30; i++) {
        try {
          await client.getHealth();
          break;
        } catch {
          if (i === 29) throw new Error("Timeout waiting for sandbox-agent");
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // Create session
      await client.createSession(sessionIdRef.current, { agent: "claude" });
      log("Session created. Ready to chat.\n");

      setStatus("ready");

      // Start listening for events
      startEventStream(client);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
    }
  }, [sandboxName, log]);

  const startEventStream = useCallback(
    async (client: SandboxAgent) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const event of client.streamEvents(sessionIdRef.current, undefined, controller.signal)) {
          console.log("Event:", event.type, event.data);

          // Auto-approve permissions
          if (event.type === "permission.requested") {
            const data = event.data as PermissionEventData;
            log(`[Auto-approved] ${data.action}`);
            await client.respondPermission(sessionIdRef.current, data.permission_id, { reply: "once" });
          }

          // Reject questions (don't support interactive input)
          if (event.type === "question.requested") {
            const data = event.data as QuestionEventData;
            log(`[Question rejected] ${data.prompt}`);
            await client.rejectQuestion(sessionIdRef.current, data.question_id);
          }

          // Track when assistant starts thinking
          if (event.type === "item.started") {
            const item = (event.data as any)?.item;
            if (item?.role === "assistant") {
              isThinkingRef.current = true;
            }
          }

          // Show deltas while assistant is thinking
          if (event.type === "item.delta" && isThinkingRef.current) {
            const delta = (event.data as any)?.delta;
            if (delta) {
              const text = typeof delta === "string" ? delta : delta.type === "text" ? delta.text || "" : "";
              if (text) {
                setOutput((prev) => prev + text);
              }
            }
          }

          // Track assistant turn completion
          if (event.type === "item.completed") {
            const item = (event.data as any)?.item;
            if (item?.role === "assistant") {
              isThinkingRef.current = false;
              setOutput((prev) => prev + "\n\n");
              setStatus("ready");
            }
          }

          // Handle errors
          if (event.type === "error") {
            const data = event.data as any;
            log(`Error: ${data?.message || JSON.stringify(data)}`);
          }

          // Handle session end
          if (event.type === "session.ended") {
            const data = event.data as any;
            log(`Session ended: ${data?.reason || "unknown"}`);
            setStatus("idle");
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Event stream error:", err);
      }
    },
    [log],
  );

  const send = useCallback(async () => {
    if (!clientRef.current || !prompt.trim() || status !== "ready") return;

    const message = prompt.trim();
    setPrompt("");
    setOutput((prev) => prev + `user: ${message}\n\nassistant: `);
    setStatus("thinking");

    try {
      await clientRef.current.postMessage(sessionIdRef.current, { message });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("ready");
    }
  }, [prompt, status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Sandbox Agent</h1>

      {status === "idle" && (
        <div style={styles.connectForm}>
          <label style={styles.label}>
            Sandbox name:
            <input style={styles.input} value={sandboxName} onChange={(e) => setSandboxName(e.target.value)} placeholder="demo" />
          </label>
          <button style={styles.button} onClick={connect}>
            Connect
          </button>
        </div>
      )}

      {status === "connecting" && <div style={styles.status}>Connecting to sandbox...</div>}

      {error && <div style={styles.error}>{error}</div>}

      {(status === "ready" || status === "thinking") && (
        <>
          <div style={styles.output}>{output}</div>
          <div style={styles.inputRow}>
            <input
              style={styles.promptInput}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Enter prompt..."
              disabled={status === "thinking"}
            />
            <button style={styles.button} onClick={send} disabled={status === "thinking"}>
              {status === "thinking" ? "..." : "Send"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 800,
    margin: "2rem auto",
    padding: "1rem",
  },
  title: {
    marginBottom: "1rem",
  },
  connectForm: {
    display: "flex",
    gap: "1rem",
    alignItems: "flex-end",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    fontSize: "0.875rem",
    color: "#666",
  },
  input: {
    padding: "0.5rem",
    fontSize: "1rem",
    width: 200,
  },
  button: {
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    cursor: "pointer",
    backgroundColor: "#0066cc",
    color: "white",
    border: "none",
    borderRadius: 4,
  },
  status: {
    color: "#666",
    fontStyle: "italic",
  },
  error: {
    color: "#cc0000",
    padding: "0.5rem",
    backgroundColor: "#fff0f0",
    borderRadius: 4,
    marginBottom: "1rem",
  },
  output: {
    whiteSpace: "pre-wrap",
    background: "#1e1e1e",
    color: "#d4d4d4",
    padding: "1rem",
    minHeight: 300,
    fontFamily: "monospace",
    fontSize: 14,
    overflow: "auto",
    borderRadius: 4,
  },
  inputRow: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
  },
  promptInput: {
    flex: 1,
    padding: "0.5rem",
    fontSize: "1rem",
  },
};
