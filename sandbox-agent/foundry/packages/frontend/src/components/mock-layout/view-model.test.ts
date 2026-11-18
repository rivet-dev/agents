import { describe, expect, it } from "vitest";
import type { WorkspaceSession } from "@sandbox-agent/foundry-shared";
import { buildDisplayMessages } from "./view-model";

function makeSession(transcript: WorkspaceSession["transcript"]): WorkspaceSession {
  return {
    id: "session-1",
    sessionId: "session-1",
    sessionName: "Session 1",
    agent: "Codex",
    model: "gpt-5.3-codex",
    status: "idle",
    thinkingSinceMs: null,
    unread: false,
    created: true,
    draft: {
      text: "",
      attachments: [],
      updatedAtMs: null,
    },
    transcript,
  };
}

describe("buildDisplayMessages", () => {
  it("collapses chunked agent output into a single display message", () => {
    const messages = buildDisplayMessages(
      makeSession([
        {
          id: "evt-setup",
          eventIndex: 0,
          sessionId: "session-1",
          createdAt: 0,
          connectionId: "conn-1",
          sender: "client",
          payload: {
            method: "session/new",
            params: {
              cwd: "/repo",
            },
          },
        },
        {
          id: "evt-client",
          eventIndex: 1,
          sessionId: "session-1",
          createdAt: 1,
          connectionId: "conn-1",
          sender: "client",
          payload: {
            method: "session/prompt",
            params: {
              prompt: [{ type: "text", text: "hello" }],
            },
          },
        },
        {
          id: "evt-config",
          eventIndex: 1,
          sessionId: "session-1",
          createdAt: 1,
          connectionId: "conn-1",
          sender: "agent",
          payload: {
            result: {
              configOptions: [],
            },
          },
        },
        {
          id: "evt-chunk-1",
          eventIndex: 2,
          sessionId: "session-1",
          createdAt: 2,
          connectionId: "conn-1",
          sender: "agent",
          payload: {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "hel",
                },
              },
            },
          },
        },
        {
          id: "evt-chunk-2",
          eventIndex: 3,
          sessionId: "session-1",
          createdAt: 3,
          connectionId: "conn-1",
          sender: "agent",
          payload: {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "lo",
                },
              },
            },
          },
        },
        {
          id: "evt-stop",
          eventIndex: 4,
          sessionId: "session-1",
          createdAt: 4,
          connectionId: "conn-1",
          sender: "agent",
          payload: {
            result: {
              stopReason: "end_turn",
            },
          },
        },
      ]),
    );

    expect(messages).toEqual([
      expect.objectContaining({
        id: "evt-client",
        sender: "client",
        text: "hello",
      }),
      expect.objectContaining({
        id: "evt-chunk-1",
        sender: "agent",
        text: "hello",
      }),
    ]);
  });

  it("hides non-message session update envelopes", () => {
    const messages = buildDisplayMessages(
      makeSession([
        {
          id: "evt-client",
          eventIndex: 1,
          sessionId: "session-1",
          createdAt: 1,
          connectionId: "conn-1",
          sender: "client",
          payload: {
            method: "session/prompt",
            params: {
              prompt: [{ type: "text", text: "hello" }],
            },
          },
        },
        {
          id: "evt-update",
          eventIndex: 2,
          sessionId: "session-1",
          createdAt: 2,
          connectionId: "conn-1",
          sender: "agent",
          payload: {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "agent_thought",
                content: {
                  type: "text",
                  text: "thinking",
                },
              },
            },
          },
        },
        {
          id: "evt-result",
          eventIndex: 3,
          sessionId: "session-1",
          createdAt: 3,
          connectionId: "conn-1",
          sender: "agent",
          payload: {
            result: {
              text: "done",
            },
          },
        },
      ]),
    );

    expect(messages).toEqual([
      expect.objectContaining({
        id: "evt-client",
        sender: "client",
        text: "hello",
      }),
      expect.objectContaining({
        id: "evt-result",
        sender: "agent",
        text: "done",
      }),
    ]);
  });
});
