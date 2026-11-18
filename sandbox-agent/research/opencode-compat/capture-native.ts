/**
 * Capture native OpenCode server API output for comparison.
 *
 * Usage:
 *   npx tsx capture-native.ts
 *
 * Starts a native OpenCode headless server, creates a Claude session,
 * sends 2 messages (one that triggers tool calls), and captures all
 * session events and message snapshots.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";

const OUTPUT_DIR = new URL("./snapshots/native", import.meta.url).pathname;

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

async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/global/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Timed out waiting for native opencode health");
}

function saveJson(name: string, data: unknown) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = `${OUTPUT_DIR}/${name}.json`;
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`  [saved] ${path}`);
}

async function waitForIdle(baseUrl: string, sessionId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // Give a small initial delay for the status to change to busy
  await new Promise((r) => setTimeout(r, 500));
  while (Date.now() - start < timeoutMs) {
    try {
      const statusRes = await fetch(`${baseUrl}/session/status`);
      const statuses = await statusRes.json();
      const sessionStatus = statuses?.[sessionId];
      if (sessionStatus?.type === "idle" || sessionStatus === undefined) {
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for session to become idle");
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Starting native OpenCode server on port ${port}...`);

  const child: ChildProcess = spawn("opencode", ["serve", "--port", String(port)], {
    stdio: "pipe",
    env: { ...process.env },
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.includes("listening")) console.log(`  [opencode] ${text.trim()}`);
  });

  // Track all SSE events in a separate array
  const allEvents: any[] = [];
  let sseAbort: AbortController | null = null;
  let currentBaseUrl = "";

  try {
    await waitForHealth(baseUrl);
    currentBaseUrl = baseUrl;
    console.log("Native OpenCode server is healthy!");

    // 1. Capture initial metadata
    const [agentRes, configRes] = await Promise.all([fetch(`${baseUrl}/agent`).then((r) => r.json()), fetch(`${baseUrl}/config`).then((r) => r.json())]);
    saveJson("metadata-agent", agentRes);
    saveJson("metadata-config", configRes);

    // 2. Start SSE event collection
    sseAbort = new AbortController();
    const ssePromise = (async () => {
      try {
        const res = await fetch(`${baseUrl}/event`, {
          signal: sseAbort!.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          console.error("SSE connection failed:", res.status);
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
                // Auto-approve permissions
                if (parsed.type === "permission.asked" && parsed.properties?.id) {
                  const permId = parsed.properties.id;
                  console.log(`  [auto-approving permission ${permId}]`);
                  fetch(`${currentBaseUrl}/permission/${permId}/reply`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ allow: true }),
                  }).catch(() => {});
                }
              } catch {}
            }
          }
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          // Ignore - expected when server closes
        }
      }
    })();

    // Give SSE time to connect
    await new Promise((r) => setTimeout(r, 500));

    // 3. Create a session
    console.log("Creating session...");
    const sessionRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const session = await sessionRes.json();
    saveJson("session-create", session);
    const sessionId = session.id;
    console.log(`  Session ID: ${sessionId}`);

    // Use anthropic provider with a cheap model for testing
    const model = { providerID: "anthropic", modelID: "claude-haiku-4-5" };

    // 4. Send first message (simple text response) - use prompt_async + wait
    console.log("Sending message 1 (simple text)...");
    await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        parts: [{ type: "text", text: "Respond with exactly: 'Hello from OpenCode'. Nothing else." }],
      }),
    });

    // Wait for the response to be fully processed
    console.log("  Waiting for message 1 to complete...");
    await waitForIdle(baseUrl, sessionId, 60_000);
    await new Promise((r) => setTimeout(r, 1000));

    // 5. Get messages after first request
    const messagesAfter1 = await fetch(`${baseUrl}/session/${sessionId}/message`).then((r) => r.json());
    saveJson("messages-after-1", messagesAfter1);
    console.log(`  Got ${messagesAfter1.length} messages after msg 1`);

    // 6. Send second message (ask for a tool call - file write) - use prompt_async
    console.log("Sending message 2 (should trigger tool calls)...");
    await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        parts: [
          {
            type: "text",
            text: "List the files in the current directory. Use the list/ls tool. Only list the top-level contents, do not recurse.",
          },
        ],
      }),
    });

    // Wait for completion (longer timeout for tool calls + permissions)
    console.log("  Waiting for message 2 to complete...");
    try {
      await waitForIdle(baseUrl, sessionId, 120_000);
    } catch (e) {
      console.log("  Warning: timed out waiting for idle, capturing what we have...");
    }
    await new Promise((r) => setTimeout(r, 2000));

    // 7. Get messages after second request
    const messagesAfter2 = await fetch(`${baseUrl}/session/${sessionId}/message`).then((r) => r.json());
    saveJson("messages-after-2", messagesAfter2);
    console.log(`  Got ${messagesAfter2.length} messages after msg 2`);

    // 8. Get session details
    const sessionDetails = await fetch(`${baseUrl}/session/${sessionId}`).then((r) => r.json());
    saveJson("session-details", sessionDetails);

    // 9. Get session status
    const sessionStatus = await fetch(`${baseUrl}/session/status`).then((r) => r.json());
    saveJson("session-status", sessionStatus);

    // 10. Stop SSE and save events
    sseAbort.abort();
    await new Promise((r) => setTimeout(r, 500));
    saveJson("all-events", allEvents);

    // Filter events for this session
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
