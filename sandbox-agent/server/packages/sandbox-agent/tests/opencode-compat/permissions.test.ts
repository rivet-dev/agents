/**
 * Tests for OpenCode-compatible permission endpoints.
 *
 * These tests verify that sandbox-agent exposes OpenCode-compatible permission
 * handling endpoints that can be used with the official OpenCode SDK.
 *
 * Expected endpoints:
 * - POST /session/{id}/permissions/{permissionID} - Respond to a permission request
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Permission API", () => {
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

    // Create a session
    const session = await client.session.create();
    sessionId = session.data?.id!;
    expect(sessionId).toBeDefined();
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  const permissionPrompt = "permission";

  async function waitForPermissionRequest(timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const list = await client.permission.list();
      const request = list.data?.[0];
      if (request) {
        return request;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Timed out waiting for permission request");
  }

  async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await check()) {
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error("Timed out waiting for condition");
  }

  async function waitForValue<T>(getValue: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = await getValue();
      if (value !== undefined) {
        return value;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error("Timed out waiting for value");
  }

  describe("permission.reply (global)", () => {
    it("should receive permission.asked and reply via global endpoint", async () => {
      await client.session.prompt({
        sessionID: sessionId,
        model: { providerID: "mock", modelID: "mock" },
        parts: [{ type: "text", text: permissionPrompt }],
      });

      const asked = await waitForPermissionRequest();
      const requestId = asked?.id;
      expect(requestId).toBeDefined();

      const response = await client.permission.reply({
        requestID: requestId,
        reply: "once",
      });
      expect(response.error).toBeUndefined();
    });

    it("should emit permission.replied with always when reply is always", async () => {
      const eventStream = await client.event.subscribe();
      const repliedEventPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for permission.replied")), 15_000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              if (event.type === "permission.replied") {
                clearTimeout(timeout);
                resolve(event);
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
        sessionID: sessionId,
        model: { providerID: "mock", modelID: "mock" },
        parts: [{ type: "text", text: permissionPrompt }],
      });

      const asked = await waitForPermissionRequest();
      const requestId = asked?.id;
      expect(requestId).toBeDefined();

      const response = await client.permission.reply({
        requestID: requestId,
        reply: "always",
      });
      expect(response.error).toBeUndefined();

      const replied = await repliedEventPromise;
      expect(replied?.properties?.requestID).toBe(requestId);
      expect(replied?.properties?.reply).toBe("always");
    });

    it("should auto-reply subsequent matching permissions after always", async () => {
      const eventStream = await client.event.subscribe();
      const repliedEvents: any[] = [];
      (async () => {
        try {
          for await (const event of (eventStream as any).stream) {
            if (event.type === "permission.replied") {
              repliedEvents.push(event);
            }
          }
        } catch {
          // Stream can end during test teardown.
        }
      })();

      await client.session.prompt({
        sessionID: sessionId,
        model: { providerID: "mock", modelID: "mock" },
        parts: [{ type: "text", text: permissionPrompt }],
      });

      const firstAsked = await waitForPermissionRequest();
      const firstRequestId = firstAsked?.id;
      expect(firstRequestId).toBeDefined();

      const firstReply = await client.permission.reply({
        requestID: firstRequestId,
        reply: "always",
      });
      expect(firstReply.error).toBeUndefined();

      await waitForCondition(() => repliedEvents.some((event) => event?.properties?.requestID === firstRequestId && event?.properties?.reply === "always"));

      await client.session.prompt({
        sessionID: sessionId,
        model: { providerID: "mock", modelID: "mock" },
        parts: [{ type: "text", text: permissionPrompt }],
      });

      const autoReplyEvent = await waitForValue(() =>
        repliedEvents.find((event) => event?.properties?.requestID !== firstRequestId && event?.properties?.reply === "always"),
      );
      const autoRequestId = autoReplyEvent?.properties?.requestID;
      expect(autoRequestId).toBeDefined();

      await waitForCondition(async () => {
        const list = await client.permission.list();
        return !(list.data ?? []).some((item) => item?.id === autoRequestId);
      });
    });
  });

  describe("postSessionIdPermissionsPermissionId (session)", () => {
    it("should accept permission response for a session", async () => {
      await client.session.prompt({
        sessionID: sessionId,
        model: { providerID: "mock", modelID: "mock" },
        parts: [{ type: "text", text: permissionPrompt }],
      });

      const asked = await waitForPermissionRequest();
      const requestId = asked?.id;
      expect(requestId).toBeDefined();

      const response = await client.permission.respond({
        sessionID: sessionId,
        permissionID: requestId,
        response: "allow",
      });

      expect(response.error).toBeUndefined();
    });
  });
});
