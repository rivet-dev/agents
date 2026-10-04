/**
 * Tests for OpenCode-compatible question endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Question API", () => {
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

  const questionPrompt = "question";

  async function waitForQuestionRequest(timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const list = await client.question.list();
      const request = list.data?.[0];
      if (request) {
        return request;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Timed out waiting for question request");
  }

  it("should ask a question and accept a reply", async () => {
    await client.session.prompt({
      sessionID: sessionId,
      model: { providerID: "mock", modelID: "mock" },
      parts: [{ type: "text", text: questionPrompt }],
    });

    const asked = await waitForQuestionRequest();
    const requestId = asked?.id;
    expect(requestId).toBeDefined();

    const replyResponse = await client.question.reply({
      requestID: requestId,
      answers: [["Yes"]],
    });
    expect(replyResponse.error).toBeUndefined();
  });

  it("should allow rejecting a question", async () => {
    await client.session.prompt({
      sessionID: sessionId,
      model: { providerID: "mock", modelID: "mock" },
      parts: [{ type: "text", text: questionPrompt }],
    });

    const asked = await waitForQuestionRequest();
    const requestId = asked?.id;
    expect(requestId).toBeDefined();

    const rejectResponse = await client.question.reject({
      requestID: requestId,
    });
    expect(rejectResponse.error).toBeUndefined();
  });
});
