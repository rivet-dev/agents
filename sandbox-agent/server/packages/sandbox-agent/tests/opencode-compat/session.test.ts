/**
 * Tests for OpenCode-compatible session management endpoints.
 *
 * These tests verify that sandbox-agent exposes OpenCode-compatible API endpoints
 * that can be used with the official OpenCode SDK.
 *
 * Expected endpoints:
 * - POST /session - Create a new session
 * - GET /session - List all sessions
 * - GET /session/{id} - Get session details
 * - PATCH /session/{id} - Update session properties
 * - DELETE /session/{id} - Delete a session
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("OpenCode-compatible Session API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;

  async function createSessionViaHttp(body: Record<string, unknown>) {
    const response = await fetch(`${handle.baseUrl}/opencode/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return response.json();
  }

  async function getBackingSessionPermissionMode(sessionId: string) {
    const response = await fetch(`${handle.baseUrl}/opencode/session`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(response.ok).toBe(true);
    const sessions = await response.json();
    const session = (sessions ?? []).find((item: any) => item.id === sessionId);
    return session?.permissionMode;
  }

  async function getBackingSession(sessionId: string) {
    const response = await fetch(`${handle.baseUrl}/opencode/session`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(response.ok).toBe(true);
    const sessions = await response.json();
    return (sessions ?? []).find((item: any) => item.id === sessionId);
  }

  async function initSessionViaHttp(sessionId: string, body: Record<string, unknown> = {}): Promise<{ response: Response; data: any }> {
    const response = await fetch(`${handle.baseUrl}/opencode/session/${sessionId}/init`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return { response, data };
  }

  async function listMessagesViaHttp(sessionId: string): Promise<any[]> {
    const response = await fetch(`${handle.baseUrl}/opencode/session/${sessionId}/message`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(response.ok).toBe(true);
    return response.json();
  }

  async function getProvidersViaHttp(): Promise<{
    connected: string[];
    default: Record<string, string>;
  }> {
    const response = await fetch(`${handle.baseUrl}/opencode/provider`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(response.ok).toBe(true);
    const data = await response.json();
    return {
      connected: data.connected ?? [],
      default: data.default ?? {},
    };
  }

  async function waitForAssistantMessage(sessionId: string, timeoutMs = 10_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const messages = await listMessagesViaHttp(sessionId);
      const assistant = messages.find((message) => message?.info?.role === "assistant");
      if (assistant) {
        return assistant;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for assistant message");
  }

  beforeAll(async () => {
    // Build the binary if needed
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    // Spawn a fresh sandbox-agent instance for each test
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  describe("session.create", () => {
    it("should create a new session", async () => {
      const response = await client.session.create();

      expect(response.data).toBeDefined();
      expect(response.data?.id).toBeDefined();
      expect(typeof response.data?.id).toBe("string");
      expect(response.data?.id.length).toBeGreaterThan(0);
    });

    it("should create session with custom title", async () => {
      const response = await client.session.create({
        body: { title: "Test Session" },
      });

      expect(response.data).toBeDefined();
      expect(response.data?.title).toBe("Test Session");
    });

    it("should assign unique IDs to each session", async () => {
      const session1 = await client.session.create();
      const session2 = await client.session.create();

      expect(session1.data?.id).not.toBe(session2.data?.id);
    });

    it("should pass permissionMode bypass to backing session", async () => {
      const session = await createSessionViaHttp({ permissionMode: "bypass" });
      const sessionId = session.id as string;
      expect(sessionId).toBeDefined();

      const prompt = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "hello" }],
        },
      });
      expect(prompt.error).toBeUndefined();

      const permissionMode = await getBackingSessionPermissionMode(sessionId);
      expect(permissionMode).toBe("bypass");
    });

    it("should accept permission_mode alias and pass bypass to backing session", async () => {
      const session = await createSessionViaHttp({ permission_mode: "bypass" });
      const sessionId = session.id as string;
      expect(sessionId).toBeDefined();

      const prompt = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "hello" }],
        },
      });
      expect(prompt.error).toBeUndefined();

      const permissionMode = await getBackingSessionPermissionMode(sessionId);
      expect(permissionMode).toBe("bypass");
    });
  });

  describe("session.list", () => {
    it("should return empty list when no sessions exist", async () => {
      const response = await client.session.list();

      expect(response.data).toBeDefined();
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data?.length).toBe(0);
    });

    it("should list created sessions", async () => {
      // Create some sessions
      await client.session.create({ body: { title: "Session 1" } });
      await client.session.create({ body: { title: "Session 2" } });

      const response = await client.session.list();

      expect(response.data).toBeDefined();
      expect(response.data?.length).toBe(2);
    });
  });

  describe("session.init", () => {
    it("should accept empty init body and keep message flow working", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;
      expect(sessionId).toBeDefined();

      const initialized = await initSessionViaHttp(sessionId, {});
      expect(initialized.response.ok).toBe(true);
      expect(initialized.data).toBe(true);

      const prompt = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: "hello after init" }],
        } as any,
      });
      expect(prompt.error).toBeUndefined();

      const assistant = await waitForAssistantMessage(sessionId);
      expect(assistant?.info?.role).toBe("assistant");
    });

    it("should apply explicit init model selection to the backing session", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;
      expect(sessionId).toBeDefined();

      const initialized = await initSessionViaHttp(sessionId, {
        providerID: "codex",
        modelID: "gpt-5",
        messageID: "msg_init",
      });
      expect(initialized.response.ok).toBe(true);
      expect(initialized.data).toBe(true);

      const backingSession = await getBackingSession(sessionId);
      expect(backingSession?.agent).toBe("codex");
      expect(backingSession?.model).toBe("gpt-5");
    });

    it("should accept first prompt after codex init without session-not-found", async () => {
      const providers = await getProvidersViaHttp();
      if (!providers.connected.includes("codex")) {
        return;
      }
      const codexDefaultModel = providers.default?.codex;
      if (!codexDefaultModel) {
        return;
      }

      const session = await client.session.create();
      const sessionId = session.data?.id!;
      expect(sessionId).toBeDefined();

      const initialized = await initSessionViaHttp(sessionId, {
        providerID: "codex",
        modelID: codexDefaultModel,
      });
      expect(initialized.response.ok).toBe(true);
      expect(initialized.data).toBe(true);

      const prompt = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "codex", modelID: codexDefaultModel },
          parts: [{ type: "text", text: "hello after codex init" }],
        },
      });
      expect(prompt.error).toBeUndefined();
    });

    it("should reject init model changes after the first prompt", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;
      expect(sessionId).toBeDefined();

      const firstPrompt = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "first" }],
        },
      });
      expect(firstPrompt.error).toBeUndefined();

      const changed = await initSessionViaHttp(sessionId, {
        providerID: "codex",
        modelID: "gpt-5",
      });
      expect(changed.response.status).toBe(400);
      expect(changed.data?.errors?.[0]?.message).toBe(
        "OpenCode compatibility currently does not support changing the model after creating a session. Export with /export and load in to a new session.",
      );
    });

    it("should map agent-only first prompt selection to provider/model defaults", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;
      expect(sessionId).toBeDefined();

      const prompt = await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: "codex",
          parts: [{ type: "text", text: "hello with agent only" }],
        } as any,
      });
      expect(prompt.error).toBeUndefined();
      expect(prompt.data?.info?.providerID).toBe("codex");
      expect(prompt.data?.info?.modelID).toBe("gpt-5");
    });
  });

  describe("session.get", () => {
    it("should retrieve session by ID", async () => {
      const created = await client.session.create({ body: { title: "Test" } });
      const sessionId = created.data?.id;
      expect(sessionId).toBeDefined();

      const response = await client.session.get({ path: { id: sessionId! } });

      expect(response.data).toBeDefined();
      expect(response.data?.id).toBe(sessionId);
      expect(response.data?.title).toBe("Test");
    });

    it("should keep session.get available during first prompt after /new-style creation", async () => {
      const providers = await getProvidersViaHttp();
      const providerId = providers.connected.find((provider) => provider !== "mock" && typeof providers.default?.[provider] === "string");
      if (!providerId) {
        return;
      }
      const modelId = providers.default?.[providerId];
      if (!modelId) {
        return;
      }

      const created = await client.session.create({ body: { title: "Race Repro" } });
      const sessionId = created.data?.id!;
      expect(sessionId).toBeDefined();

      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: providerId, modelID: modelId },
          parts: [{ type: "text", text: "hello after /new" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));

      const getDuringPrompt = await client.session.get({ path: { id: sessionId } });
      expect(getDuringPrompt.error).toBeUndefined();
      expect(getDuringPrompt.data?.id).toBe(sessionId);

      // Best-effort settle; this assertion focuses on availability during the in-flight turn.
      await promptPromise;
    });

    it("should return error for non-existent session", async () => {
      const response = await client.session.get({
        path: { id: "non-existent-session-id" },
      });

      expect(response.error).toBeDefined();
    });

    it("should restore persisted sessions after server restart and continue prompting", async () => {
      await handle.dispose();

      const tempStateDir = mkdtempSync(join(tmpdir(), "sandbox-agent-opencode-restore-"));
      const sqlitePath = join(tempStateDir, "opencode-sessions.db");

      try {
        handle = await spawnSandboxAgent({
          opencodeCompat: true,
          env: { OPENCODE_COMPAT_DB_PATH: sqlitePath },
        });
        client = createOpencodeClient({
          baseUrl: `${handle.baseUrl}/opencode`,
          headers: { Authorization: `Bearer ${handle.token}` },
        });

        const created = await client.session.create({ body: { title: "Persisted Session" } });
        const sessionId = created.data?.id!;
        expect(sessionId).toBeDefined();

        const firstPrompt = await client.session.prompt({
          path: { id: sessionId },
          body: {
            model: { providerID: "mock", modelID: "mock" },
            parts: [{ type: "text", text: "before restart" }],
          },
        });
        expect(firstPrompt.error).toBeUndefined();

        await waitForAssistantMessage(sessionId);
        await handle.dispose();

        handle = await spawnSandboxAgent({
          opencodeCompat: true,
          env: { OPENCODE_COMPAT_DB_PATH: sqlitePath },
        });
        client = createOpencodeClient({
          baseUrl: `${handle.baseUrl}/opencode`,
          headers: { Authorization: `Bearer ${handle.token}` },
        });

        const restored = await client.session.get({ path: { id: sessionId } });
        expect(restored.error).toBeUndefined();
        expect(restored.data?.id).toBe(sessionId);
        expect(restored.data?.title).toBe("Persisted Session");

        const secondPrompt = await client.session.prompt({
          path: { id: sessionId },
          body: {
            model: { providerID: "mock", modelID: "mock" },
            parts: [{ type: "text", text: "after restart" }],
          },
        });
        expect(secondPrompt.error).toBeUndefined();

        const messages = await listMessagesViaHttp(sessionId);
        expect(messages.length).toBeGreaterThan(2);
      } finally {
        rmSync(tempStateDir, { recursive: true, force: true });
      }
    });
  });

  describe("session.update", () => {
    it("should update session title", async () => {
      const created = await client.session.create({ body: { title: "Original" } });
      const sessionId = created.data?.id!;

      await client.session.update({
        path: { id: sessionId },
        body: { title: "Updated" },
      });

      const response = await client.session.get({ path: { id: sessionId } });
      expect(response.data?.title).toBe("Updated");
    });

    it("should reject model changes after session creation", async () => {
      const created = await client.session.create({ body: { title: "Original" } });
      const sessionId = created.data?.id!;

      const payloads = [
        { providerID: "codex", modelID: "gpt-5" },
        { provider_id: "codex", model_id: "gpt-5" },
        { providerId: "codex", modelId: "gpt-5" },
      ];

      for (const payload of payloads) {
        const response = await fetch(`${handle.baseUrl}/opencode/session/${sessionId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${handle.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data?.errors?.[0]?.message).toBe(
          "OpenCode compatibility currently does not support changing the model after creating a session. Export with /export and load in to a new session.",
        );
      }
    });

    it("should reject prompt model changes after the first prompt", async () => {
      const created = await client.session.create({ body: { title: "Model Lock" } });
      const sessionId = created.data?.id!;

      const firstPrompt = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "first" }],
        },
      });
      expect(firstPrompt.error).toBeUndefined();

      const response = await fetch(`${handle.baseUrl}/opencode/session/${sessionId}/message`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: { providerID: "codex", modelID: "gpt-5" },
          parts: [{ type: "text", text: "second" }],
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data?.errors?.[0]?.message).toBe(
        "OpenCode compatibility currently does not support changing the model after creating a session. Export with /export and load in to a new session.",
      );
    });
  });

  describe("session.delete", () => {
    it("should delete a session", async () => {
      const created = await client.session.create();
      const sessionId = created.data?.id!;

      await client.session.delete({ path: { id: sessionId } });

      const response = await client.session.get({ path: { id: sessionId } });
      expect(response.error).toBeDefined();
    });

    it("should not affect other sessions when one is deleted", async () => {
      const session1 = await client.session.create({ body: { title: "Keep" } });
      const session2 = await client.session.create({ body: { title: "Delete" } });

      await client.session.delete({ path: { id: session2.data?.id! } });

      const response = await client.session.get({ path: { id: session1.data?.id! } });
      expect(response.data).toBeDefined();
      expect(response.data?.title).toBe("Keep");
    });
  });
});
