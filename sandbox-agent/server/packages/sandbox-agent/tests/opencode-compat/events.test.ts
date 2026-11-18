/**
 * Tests for OpenCode-compatible event streaming endpoints.
 *
 * These tests verify that sandbox-agent exposes OpenCode-compatible SSE event
 * endpoints that can be used with the official OpenCode SDK.
 *
 * Expected endpoints:
 * - GET /event - Subscribe to all events (SSE)
 * - GET /global/event - Subscribe to global events (SSE)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Event Streaming", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;

  function uniqueSessionId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function initSessionViaHttp(sessionId: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${handle.baseUrl}/opencode/session/${sessionId}/init`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
  }

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  describe("event.subscribe", () => {
    it("should connect to SSE endpoint", async () => {
      // The event.subscribe returns an SSE stream
      const response = await client.event.subscribe();

      expect(response).toBeDefined();
      expect((response as any).stream).toBeDefined();
    });

    it("should receive session.created event when session is created", async () => {
      const events: any[] = [];

      // Start listening for events
      const eventStream = await client.event.subscribe();

      // Set up event collection with timeout
      const collectEvents = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              events.push(event);
              if (event.type === "session.created") {
                clearTimeout(timeout);
                resolve();
                break;
              }
            }
          } catch {
            // Stream ended or errored
          }
        })();
      });

      // Create a session
      await client.session.create({ body: { title: "Event Test" } });

      await collectEvents;

      // Should have received at least one session.created event
      const sessionCreatedEvent = events.find((e) => e.type === "session.created");
      expect(sessionCreatedEvent).toBeDefined();
    });

    it("should receive message.part.updated events during prompt", async () => {
      const events: any[] = [];

      // Create a session first
      const session = await client.session.create();
      const sessionId = session.data?.id!;

      // Start listening for events
      const eventStream = await client.event.subscribe();

      const collectEvents = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 10000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              events.push(event);
              // Look for message part updates or completion
              if (event.type === "message.part.updated" || event.type === "session.idle") {
                if (events.length >= 3) {
                  clearTimeout(timeout);
                  resolve();
                  break;
                }
              }
            }
          } catch {
            // Stream ended
          }
        })();
      });

      // Send a prompt
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "Say hello" }],
        },
      });

      await collectEvents;

      // Should have received some events
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe("global.event", () => {
    it("should connect to global SSE endpoint", async () => {
      const response = await client.global.event();

      expect(response).toBeDefined();
    });
  });

  describe("session.status", () => {
    it("should return session status", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;

      const response = await client.session.status();

      expect(response.data).toBeDefined();
    });

    it("should be idle before first prompt and return to idle after prompt completion", async () => {
      const sessionId = uniqueSessionId("status-idle");
      await initSessionViaHttp(sessionId, { providerID: "mock", modelID: "mock" });

      const initial = await client.session.status();
      expect(initial.data?.[sessionId]?.type).toBe("idle");

      const eventStream = await client.event.subscribe();
      const statuses: string[] = [];

      const collectIdle = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for session.idle")), 15_000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              if (event?.properties?.sessionID !== sessionId) continue;
              if (event.type === "session.status") {
                const statusType = event?.properties?.status?.type;
                if (typeof statusType === "string") statuses.push(statusType);
              }
              if (event.type === "session.idle") {
                clearTimeout(timeout);
                resolve();
                break;
              }
            }
          } catch {
            // Stream ended
          }
        })();
      });

      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "Say hello" }],
        },
      });

      await collectIdle;

      expect(statuses).toContain("busy");
      expect(statuses.filter((status) => status === "busy")).toHaveLength(1);
      const finalStatus = await client.session.status();
      expect(finalStatus.data?.[sessionId]?.type).toBe("idle");
    });

    it("should report busy via /session/status while turn is in flight", async () => {
      const sessionId = uniqueSessionId("status-busy-inflight");
      await initSessionViaHttp(sessionId, { providerID: "mock", modelID: "mock" });

      const eventStream = await client.event.subscribe();
      let busySnapshot: string | undefined;

      const waitForIdle = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for busy status snapshot + session.idle")), 15_000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              if (event?.properties?.sessionID !== sessionId) continue;

              if (event.type === "session.status" && event?.properties?.status?.type === "busy" && !busySnapshot) {
                for (let attempt = 0; attempt < 5; attempt += 1) {
                  const status = await client.session.status();
                  busySnapshot = status.data?.[sessionId]?.type;
                  if (busySnapshot === "busy") {
                    break;
                  }
                  await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 20));
                }
              }

              if (event.type === "session.idle") {
                clearTimeout(timeout);
                resolve();
                break;
              }
            }
          } catch {
            // Stream ended
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

      await waitForIdle;
      expect(busySnapshot).toBe("busy");
    });

    it("should emit session.error and return idle for failed turns", async () => {
      const sessionId = uniqueSessionId("status-error");
      await initSessionViaHttp(sessionId, { providerID: "mock", modelID: "mock" });

      const eventStream = await client.event.subscribe();
      const errors: any[] = [];
      const idles: any[] = [];

      const collectErrorAndIdle = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for session.error + session.idle")), 15_000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              if (event?.properties?.sessionID !== sessionId) continue;
              if (event.type === "session.error") {
                errors.push(event);
              }
              if (event.type === "session.idle") {
                idles.push(event);
              }
              if (errors.length > 0 && idles.length > 0) {
                clearTimeout(timeout);
                resolve();
                break;
              }
            }
          } catch {
            // Stream ended
          }
        })();
      });

      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "error" }],
        },
      });

      await collectErrorAndIdle;

      expect(errors.length).toBeGreaterThan(0);
      const finalStatus = await client.session.status();
      expect(finalStatus.data?.[sessionId]?.type).toBe("idle");
    });

    it("should report idle for newly initialized sessions across connected providers", async () => {
      const providersResponse = await fetch(`${handle.baseUrl}/opencode/provider`, {
        headers: { Authorization: `Bearer ${handle.token}` },
      });
      expect(providersResponse.ok).toBe(true);
      const providersData = await providersResponse.json();

      const connected: string[] = providersData.connected ?? [];
      const defaults: Record<string, string> = providersData.default ?? {};

      for (const providerID of connected) {
        const modelID = defaults[providerID];
        if (!modelID) continue;

        const sessionId = uniqueSessionId(`status-${providerID.replace(/[^a-zA-Z0-9_-]/g, "_")}`);

        await initSessionViaHttp(sessionId, { providerID, modelID });

        const status = await client.session.status();
        expect(status.data?.[sessionId]?.type).toBe("idle");
      }
    });
  });

  describe("session.idle count", () => {
    it("should emit exactly one session.idle for echo flow", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;

      const eventStream = await client.event.subscribe();
      const idleEvents: any[] = [];

      // Wait for first idle, then linger 1s for duplicates
      const collectIdle = new Promise<void>((resolve, reject) => {
        let lingerTimer: ReturnType<typeof setTimeout> | null = null;
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for session.idle")), 15_000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              if (event.type === "session.idle") {
                idleEvents.push(event);
                if (!lingerTimer) {
                  lingerTimer = setTimeout(() => {
                    clearTimeout(timeout);
                    resolve();
                  }, 1000);
                }
              }
            }
          } catch {
            // Stream ended
          }
        })();
      });

      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "echo hello" }],
        },
      });

      await collectIdle;
      expect(idleEvents.length).toBe(1);
    });

    it("should emit exactly one session.idle for tool flow", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;

      const eventStream = await client.event.subscribe();
      const allEvents: any[] = [];
      const idleEvents: any[] = [];

      const collectIdle = new Promise<void>((resolve, reject) => {
        let lingerTimer: ReturnType<typeof setTimeout> | null = null;
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for session.idle")), 15_000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              allEvents.push(event);
              if (event.type === "session.idle") {
                idleEvents.push(event);
                if (!lingerTimer) {
                  lingerTimer = setTimeout(() => {
                    clearTimeout(timeout);
                    resolve();
                  }, 1000);
                }
              }
            }
          } catch {
            // Stream ended
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

      await collectIdle;

      expect(idleEvents.length).toBe(1);

      // All tool parts should have been emitted before idle
      const toolParts = allEvents.filter((e) => e.type === "message.part.updated" && e.properties?.part?.type === "tool");
      expect(toolParts.length).toBeGreaterThan(0);
    });

    it("should preserve part order based on first stream appearance", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;

      const eventStream = await client.event.subscribe();
      const seenPartIds: string[] = [];
      let targetMessageId: string | null = null;

      const collectIdle = new Promise<void>((resolve, reject) => {
        let lingerTimer: ReturnType<typeof setTimeout> | null = null;
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for session.idle")), 15_000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              if (event?.properties?.sessionID !== sessionId) {
                continue;
              }

              if (event.type === "message.part.updated") {
                const messageId = event.properties?.messageID;
                const partId = event.properties?.part?.id;
                const partType = event.properties?.part?.type;
                if (!targetMessageId && partType === "tool" && typeof messageId === "string") {
                  targetMessageId = messageId;
                }
                if (targetMessageId && messageId === targetMessageId && typeof partId === "string" && !seenPartIds.includes(partId)) {
                  seenPartIds.push(partId);
                }
              }

              if (event.type === "session.idle") {
                if (!lingerTimer) {
                  lingerTimer = setTimeout(() => {
                    clearTimeout(timeout);
                    resolve();
                  }, 500);
                }
              }
            }
          } catch {
            // Stream ended
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

      await collectIdle;

      expect(targetMessageId).toBeTruthy();
      expect(seenPartIds.length).toBeGreaterThan(0);

      const response = await fetch(`${handle.baseUrl}/opencode/session/${sessionId}/message/${targetMessageId}`, {
        headers: { Authorization: `Bearer ${handle.token}` },
      });
      expect(response.ok).toBe(true);
      const message = (await response.json()) as any;
      const returnedPartIds = (message?.parts ?? []).map((part: any) => part?.id).filter((id: any) => typeof id === "string");

      const expectedSet = new Set(seenPartIds);
      const returnedFiltered = returnedPartIds.filter((id: string) => expectedSet.has(id));
      expect(returnedFiltered).toEqual(seenPartIds);
    });
  });
});
