/**
 * Integration test for real agent prompts via the OpenCode compatibility layer.
 *
 * Skipped unless TEST_AGENT_MODEL is set.  Example:
 *
 *   TEST_AGENT_MODEL=gpt-5.2-codex npx vitest run server/packages/sandbox-agent/tests/opencode-compat/real-agent.test.ts
 *
 * The env var value is a model ID.  Provider is inferred:
 *   - gpt-*      → codex
 *   - claude-*   → claude
 *   - amp-*      → amp
 *   - foo/bar    → opencode  (slash means opencode provider passthrough)
 *   - otherwise  → mock
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

const MODEL = process.env.TEST_AGENT_MODEL;

function inferProvider(model: string): string {
  if (model.startsWith("gpt-")) return "codex";
  if (model.startsWith("claude-")) return "claude";
  if (model.startsWith("amp-")) return "amp";
  if (model.includes("/")) return "opencode";
  return "mock";
}

describe.skipIf(!MODEL)("Real agent round-trip", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;

  const modelId = MODEL ?? "mock";
  const providerId = process.env.TEST_AGENT_PROVIDER ?? inferProvider(modelId);

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({
      opencodeCompat: true,
      timeoutMs: 60_000,
    });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  /**
   * Helper: wait for the next session.idle on the event stream, collecting text.
   * Uses a manual iterator to avoid closing the stream (for-await-of calls
   * iterator.return() on early exit, which would close the SSE connection).
   */
  function collectUntilIdle(iter: AsyncIterator<any>, timeoutMs = 30_000): Promise<{ events: any[]; text: string }> {
    const events: any[] = [];
    let text = "";
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms. Events: ${JSON.stringify(events.map((e) => e.type))}`)), timeoutMs);
      (async () => {
        try {
          while (true) {
            const { value: event, done } = await iter.next();
            if (done) {
              clearTimeout(timeout);
              reject(new Error("Stream ended before session.idle"));
              return;
            }
            events.push(event);
            if (event.type === "message.part.updated" && event.properties?.part?.type === "text") {
              // Prefer the delta (chunk) if present; otherwise use the full
              // accumulated part.text (for non-streaming single-shot events).
              text += event.properties.delta ?? event.properties.part.text ?? "";
            }
            if (event.type === "session.idle") {
              clearTimeout(timeout);
              resolve({ events, text });
              return;
            }
            if (event.type === "session.error") {
              clearTimeout(timeout);
              reject(new Error(`session.error: ${JSON.stringify(event.properties?.error)}`));
              return;
            }
          }
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      })();
    });
  }

  it(`should get a response from ${MODEL}`, async () => {
    const session = await client.session.create();
    const sessionId = session.data?.id!;
    expect(sessionId).toBeDefined();

    const eventStream = await client.event.subscribe();
    const stream = (eventStream as any).stream as AsyncIterable<any>;
    const iter = stream[Symbol.asyncIterator]();

    // Start collecting BEFORE sending prompt so no events are lost
    const turn1Promise = collectUntilIdle(iter);

    const prompt = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: providerId, modelID: modelId },
        parts: [{ type: "text", text: "Reply with exactly: hello world" }],
      },
    });
    expect(prompt.error).toBeUndefined();

    const turn1 = await turn1Promise;
    console.log(`Turn 1 — events: ${turn1.events.length}, text: ${turn1.text.slice(0, 200)}`);
    expect(turn1.text.length).toBeGreaterThan(0);
  }, 60_000);

  it(`should have correct message ordering and info`, async () => {
    const session = await client.session.create();
    const sessionId = session.data?.id!;
    expect(sessionId).toBeDefined();

    const eventStream = await client.event.subscribe();
    const stream = (eventStream as any).stream as AsyncIterable<any>;
    const iter = stream[Symbol.asyncIterator]();

    const turnPromise = collectUntilIdle(iter);
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: providerId, modelID: modelId },
        parts: [{ type: "text", text: "Reply with exactly: test" }],
      },
    });
    const turn = await turnPromise;

    // ── Verify SSE event ordering ──
    const msgUpdates = turn.events.filter((e: any) => e.type === "message.updated");
    console.log("SSE message.updated events in order:");
    for (const e of msgUpdates) {
      const info = e.properties?.info ?? {};
      console.log(`  role=${info.role ?? "?"} id=${info.id ?? "?"} parentID=${info.parentID ?? "none"} time=${JSON.stringify(info.time)}`);
    }
    // user message.updated must come before assistant message.updated in the event stream
    const userUpdateIdx = msgUpdates.findIndex((e: any) => e.properties?.info?.role === "user");
    const assistantUpdateIdx = msgUpdates.findIndex((e: any) => e.properties?.info?.role === "assistant");
    expect(userUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(assistantUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(userUpdateIdx).toBeLessThan(assistantUpdateIdx);

    // ── Verify persisted messages via HTTP ──
    const res = await fetch(`${handle.baseUrl}/opencode/session/${sessionId}/message`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    const messages: any[] = await res.json();
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const user = messages.find((m: any) => m.info?.role === "user");
    const assistant = messages.find((m: any) => m.info?.role === "assistant");
    expect(user).toBeDefined();
    expect(assistant).toBeDefined();

    // Assistant must reference user via parentID
    expect(assistant.info.parentID).toBe(user.info.id);
    expect(assistant.info.role).toBe("assistant");
    expect(assistant.info.id).toBeDefined();
    expect(assistant.info.id).not.toBe("");

    // User must appear before assistant in the persisted array
    const userIdx = messages.indexOf(user);
    const assistantIdx = messages.indexOf(assistant);
    expect(userIdx).toBeLessThan(assistantIdx);

    console.log(`Persisted: user=${user.info.id}, assistant=${assistant.info.id}, parentID=${assistant.info.parentID}`);
  }, 60_000);

  it(`should handle multi-turn conversation with ${MODEL}`, async () => {
    const session = await client.session.create();
    const sessionId = session.data?.id!;
    expect(sessionId).toBeDefined();

    const eventStream = await client.event.subscribe();
    const stream = (eventStream as any).stream as AsyncIterable<any>;
    const iter = stream[Symbol.asyncIterator]();

    // Turn 1 — start collecting BEFORE prompt
    const turn1Promise = collectUntilIdle(iter);
    const p1 = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: providerId, modelID: modelId },
        parts: [{ type: "text", text: "Remember the number 42. Reply with just: ok" }],
      },
    });
    expect(p1.error).toBeUndefined();
    const turn1 = await turn1Promise;
    console.log(`Turn 1 — events: ${turn1.events.length}, text: ${turn1.text.slice(0, 200)}`);
    expect(turn1.text.length).toBeGreaterThan(0);

    // Turn 2 — start collecting BEFORE prompt
    const turn2Promise = collectUntilIdle(iter);
    const p2 = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: "What number did I ask you to remember? Reply with just the number." }],
      },
    });
    expect(p2.error).toBeUndefined();
    const turn2 = await turn2Promise;
    console.log(`Turn 2 — events: ${turn2.events.length}, text: ${turn2.text.slice(0, 200)}`);
    expect(turn2.text.length).toBeGreaterThan(0);
    expect(turn2.text).toContain("42");
  }, 90_000);
});
