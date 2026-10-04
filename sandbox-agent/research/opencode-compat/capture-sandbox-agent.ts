/**
 * Capture sandbox-agent OpenCode compatibility API output for comparison.
 *
 * Usage:
 *   npx tsx capture-sandbox-agent.ts
 *
 * Starts sandbox-agent with mock agent, creates a session via /opencode API,
 * sends 2 messages (text + tool call), and captures all events/messages.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

const OUTPUT_DIR = new URL("./snapshots/sandbox-agent", import.meta.url).pathname;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl: string, token: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Timed out waiting for sandbox-agent health");
}

function saveJson(name: string, data: unknown) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = `${OUTPUT_DIR}/${name}.json`;
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`  [saved] ${path}`);
}

async function main() {
  const port = await getFreePort();
  const host = "127.0.0.1";
  const baseUrl = `http://${host}:${port}`;
  const opencodeUrl = `${baseUrl}/opencode`;
  const token = randomBytes(24).toString("hex");

  console.log(`Starting sandbox-agent on port ${port}...`);

  // Use the locally built binary, not the installed one
  const binaryPath = new URL("../../target/release/sandbox-agent", import.meta.url).pathname;
  const child: ChildProcess = spawn(binaryPath, ["server", "--host", host, "--port", String(port), "--token", token], {
    stdio: "pipe",
    env: {
      ...process.env,
      SANDBOX_AGENT_SKIP_INSPECTOR: "1",
    },
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const allEvents: any[] = [];
  let sseAbort: AbortController | null = null;

  try {
    await waitForHealth(baseUrl, token);
    console.log("sandbox-agent is healthy!");

    // 1. Capture initial metadata via /opencode routes
    const headers = { Authorization: `Bearer ${token}` };
    const [agentRes, configRes] = await Promise.all([
      fetch(`${opencodeUrl}/agent`, { headers }).then((r) => r.json()),
      fetch(`${opencodeUrl}/config`, { headers }).then((r) => r.json()),
    ]);
    saveJson("metadata-agent", agentRes);
    saveJson("metadata-config", configRes);

    // 2. Start SSE event collection
    sseAbort = new AbortController();
    const ssePromise = (async () => {
      try {
        const res = await fetch(`${opencodeUrl}/event`, {
          signal: sseAbort!.signal,
          headers: { ...headers, Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          console.error("SSE connection failed:", res.status, await res.text());
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(line.slice(6));
                allEvents.push(parsed);
              } catch {}
            }
          }
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          // ignore
        }
      }
    })();

    // Give SSE time to connect
    await new Promise((r) => setTimeout(r, 500));

    // 3. Create a session
    console.log("Creating session...");
    const sessionRes = await fetch(`${opencodeUrl}/session`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const session = await sessionRes.json();
    saveJson("session-create", session);
    const sessionId = session.id;
    console.log(`  Session ID: ${sessionId}`);

    // 4. Send first message (simple text response) using mock agent's "echo" command
    console.log("Sending message 1 (simple text - echo)...");
    const msg1Res = await fetch(`${opencodeUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "sandbox-agent", modelID: "mock" },
        parts: [{ type: "text", text: "echo Hello from sandbox-agent" }],
      }),
    });
    console.log(`  prompt_async status: ${msg1Res.status}`);

    // Wait for idle
    console.log("  Waiting for message 1 to complete...");
    await waitForIdle(opencodeUrl, sessionId, headers, 30_000);
    await new Promise((r) => setTimeout(r, 1000));

    // 5. Get messages after first request
    const messagesAfter1 = await fetch(`${opencodeUrl}/session/${sessionId}/message`, { headers }).then((r) => r.json());
    saveJson("messages-after-1", messagesAfter1);
    console.log(`  Got ${messagesAfter1.length} messages after msg 1`);

    // 6. Send second message (trigger tool calls) using mock agent's "tool" command
    console.log("Sending message 2 (tool calls)...");
    const msg2Res = await fetch(`${opencodeUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "sandbox-agent", modelID: "mock" },
        parts: [{ type: "text", text: "tool" }],
      }),
    });
    console.log(`  prompt_async status: ${msg2Res.status}`);

    // Wait for completion
    console.log("  Waiting for message 2 to complete...");
    await waitForIdle(opencodeUrl, sessionId, headers, 30_000);
    await new Promise((r) => setTimeout(r, 1000));

    // 7. Get messages after second request
    const messagesAfter2 = await fetch(`${opencodeUrl}/session/${sessionId}/message`, { headers }).then((r) => r.json());
    saveJson("messages-after-2", messagesAfter2);
    console.log(`  Got ${messagesAfter2.length} messages after msg 2`);

    // 8. Get session details
    const sessionDetails = await fetch(`${opencodeUrl}/session/${sessionId}`, { headers }).then((r) => r.json());
    saveJson("session-details", sessionDetails);

    // 9. Get session status
    const sessionStatus = await fetch(`${opencodeUrl}/session/status`, { headers }).then((r) => r.json());
    saveJson("session-status", sessionStatus);

    // 10. Stop SSE and save events
    sseAbort.abort();
    await new Promise((r) => setTimeout(r, 500));
    saveJson("all-events", allEvents);

    // Filter session events
    const sessionEvents = allEvents.filter(
      (e) => e.properties?.sessionID === sessionId || (e.type === "session.created" && e.properties?.info?.id === sessionId),
    );
    saveJson("session-events", sessionEvents);

    console.log(`\nCapture complete! ${allEvents.length} total events, ${sessionEvents.length} session events.`);
    console.log(`Output saved to: ${OUTPUT_DIR}/`);
  } finally {
    if (sseAbort) sseAbort.abort();
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function waitForIdle(opencodeUrl: string, sessionId: string, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 500));
  while (Date.now() - start < timeoutMs) {
    try {
      const statusRes = await fetch(`${opencodeUrl}/session/status`, { headers });
      const statuses = await statusRes.json();
      const sessionStatus = statuses?.[sessionId];
      if (sessionStatus?.type === "idle" || sessionStatus === undefined) {
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Timed out waiting for session to become idle");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
