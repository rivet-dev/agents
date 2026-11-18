import { describe, expect, it } from "vitest";
import type { SandboxSessionRecord } from "@sandbox-agent/foundry-client";
import { buildTranscript, extractEventText, resolveSessionSelection } from "./model";

describe("extractEventText", () => {
  it("extracts prompt text arrays", () => {
    expect(extractEventText({ params: { prompt: [{ type: "text", text: "hello" }] } })).toBe("hello");
  });

  it("falls back to method name", () => {
    expect(extractEventText({ method: "session/started" })).toBe("session/started");
  });

  it("extracts agent result text when present", () => {
    expect(
      extractEventText({
        result: {
          text: "agent output",
        },
      }),
    ).toBe("agent output");
  });

  it("extracts text from chunked session updates", () => {
    expect(
      extractEventText({
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "chunk",
            },
          },
        },
      }),
    ).toBe("chunk");
  });
});

describe("buildTranscript", () => {
  it("maps sender/text/timestamp for UI transcript rendering", () => {
    const rows = buildTranscript([
      {
        id: "evt-1",
        eventIndex: 1,
        sessionId: "sess-1",
        createdAt: 1000,
        connectionId: "conn-1",
        sender: "client",
        payload: { params: { prompt: [{ type: "text", text: "hello" }] } },
      },
      {
        id: "evt-2",
        eventIndex: 2,
        sessionId: "sess-1",
        createdAt: 2000,
        connectionId: "conn-1",
        sender: "agent",
        payload: { params: { text: "world" } },
      },
    ]);

    expect(rows).toEqual([
      {
        id: "evt-1",
        sender: "client",
        text: "hello",
        createdAt: 1000,
      },
      {
        id: "evt-2",
        sender: "agent",
        text: "world",
        createdAt: 2000,
      },
    ]);
  });
});

describe("resolveSessionSelection", () => {
  const session = (id: string, status: "running" | "idle" | "error" = "running"): SandboxSessionRecord =>
    ({
      id,
      agentSessionId: `agent-${id}`,
      lastConnectionId: `conn-${id}`,
      createdAt: 1,
      status,
    }) as SandboxSessionRecord;

  it("prefers explicit selection when present in session list", () => {
    const resolved = resolveSessionSelection({
      explicitSessionId: "session-2",
      taskSessionId: "session-1",
      sessions: [session("session-1"), session("session-2")],
    });

    expect(resolved).toEqual({
      sessionId: "session-2",
      staleSessionId: null,
    });
  });

  it("falls back to task session when explicit selection is missing", () => {
    const resolved = resolveSessionSelection({
      explicitSessionId: null,
      taskSessionId: "session-1",
      sessions: [session("session-1")],
    });

    expect(resolved).toEqual({
      sessionId: "session-1",
      staleSessionId: null,
    });
  });

  it("falls back to the newest available session when configured session IDs are stale", () => {
    const resolved = resolveSessionSelection({
      explicitSessionId: null,
      taskSessionId: "session-stale",
      sessions: [session("session-fresh")],
    });

    expect(resolved).toEqual({
      sessionId: "session-fresh",
      staleSessionId: null,
    });
  });

  it("marks stale session when no sessions are available", () => {
    const resolved = resolveSessionSelection({
      explicitSessionId: null,
      taskSessionId: "session-stale",
      sessions: [],
    });

    expect(resolved).toEqual({
      sessionId: null,
      staleSessionId: "session-stale",
    });
  });
});
