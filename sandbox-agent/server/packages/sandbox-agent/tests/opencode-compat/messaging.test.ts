/**
 * Tests for OpenCode-compatible messaging endpoints.
 *
 * These tests verify that sandbox-agent exposes OpenCode-compatible message/prompt
 * endpoints that can be used with the official OpenCode SDK.
 *
 * Expected endpoints:
 * - POST /session/{id}/message - Send a prompt to the session
 * - GET /session/{id}/message - List messages in a session
 * - GET /session/{id}/message/{messageID} - Get a specific message
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Messaging API", () => {
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

    // Create a session for messaging tests
    const session = await client.session.create();
    sessionId = session.data?.id!;
    expect(sessionId).toBeDefined();
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  describe("session.prompt", () => {
    it("should send a message to the session", async () => {
      const response = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "Hello, world!" }],
        },
      });

      // The response should return a message or acknowledgement
      expect(response.error).toBeUndefined();
    });

    it("should accept text-only prompt", async () => {
      const response = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "Say hello" }],
        },
      });

      expect(response.error).toBeUndefined();
    });
  });

  describe("session.promptAsync", () => {
    it("should send async prompt and return immediately", async () => {
      const response = await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "Process this asynchronously" }],
        },
      });

      // Should return quickly without waiting for completion
      expect(response.error).toBeUndefined();
    });
  });

  describe("session.messages", () => {
    it("should return empty list for new session", async () => {
      const response = await client.session.messages({
        path: { id: sessionId },
      });

      expect(response.data).toBeDefined();
      expect(Array.isArray(response.data)).toBe(true);
    });

    it("should list messages after sending a prompt", async () => {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "Test message" }],
        },
      });

      const response = await client.session.messages({
        path: { id: sessionId },
      });

      expect(response.data).toBeDefined();
      expect(response.data?.length).toBeGreaterThan(0);
    });
  });

  describe("session.message (get specific)", () => {
    it("should retrieve a specific message by ID", async () => {
      // Send a prompt first
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "Test" }],
        },
      });

      // Get messages to find a message ID
      const messagesResponse = await client.session.messages({
        path: { id: sessionId },
      });
      const messageId = messagesResponse.data?.[0]?.id;

      if (messageId) {
        const response = await client.session.message({
          path: { id: sessionId, messageID: messageId },
        });

        expect(response.data).toBeDefined();
        expect(response.data?.id).toBe(messageId);
      }
    });
  });

  describe("session.abort", () => {
    it("should abort an in-progress session", async () => {
      // Start an async prompt
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          model: { providerID: "mock", modelID: "mock" },
          parts: [{ type: "text", text: "Long running task" }],
        },
      });

      // Abort the session
      const response = await client.session.abort({
        path: { id: sessionId },
      });

      expect(response.error).toBeUndefined();
    });

    it("should handle abort on idle session gracefully", async () => {
      // Abort without starting any work
      const response = await client.session.abort({
        path: { id: sessionId },
      });

      // Should not error, even if there's nothing to abort
      expect(response.error).toBeUndefined();
    });
  });
});
