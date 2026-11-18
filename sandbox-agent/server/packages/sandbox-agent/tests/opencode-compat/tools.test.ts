/**
 * Tests for OpenCode-compatible tool calls and file actions.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Tool + File Actions", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let sessionId: string;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });

    const session = await client.session.create();
    sessionId = session.data?.id!;
    expect(sessionId).toBeDefined();
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  it("should emit tool and file parts plus file.edited events", async () => {
    const eventStream = await client.event.subscribe();
    const tracker = {
      tool: false,
      file: false,
      edited: false,
    };

    const waiter = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for tool events")), 15_000);
      (async () => {
        try {
          for await (const event of (eventStream as any).stream) {
            if (event.type === "message.part.updated") {
              const part = event.properties?.part;
              if (part?.type === "tool") {
                tracker.tool = true;
              }
              if (part?.type === "file") {
                tracker.file = true;
              }
            }
            if (event.type === "file.edited") {
              tracker.edited = true;
            }
            if (tracker.tool && tracker.file && tracker.edited) {
              clearTimeout(timeout);
              resolve();
              break;
            }
          }
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      })();
    });

    await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: "mock", modelID: "mock" },
        parts: [{ type: "text", text: "tool" }],
      },
    });

    await waiter;
    expect(tracker.tool).toBe(true);
    expect(tracker.file).toBe(true);
    expect(tracker.edited).toBe(true);
  });
});
