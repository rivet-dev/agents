import type { SandboxSessionEventRecord } from "@sandbox-agent/foundry-client";
import type { SandboxSessionRecord } from "@sandbox-agent/foundry-client";

function fromPromptArray(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function fromSessionUpdate(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const update = value as {
    content?: unknown;
    sessionUpdate?: unknown;
  };
  if (update.sessionUpdate !== "agent_message_chunk") {
    return null;
  }

  const content = update.content;
  if (!content || typeof content !== "object") {
    return null;
  }

  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

export function extractEventText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return String(payload ?? "");
  }

  const envelope = payload as {
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };

  const params = envelope.params;
  if (params && typeof params === "object") {
    const updateText = fromSessionUpdate((params as { update?: unknown }).update);
    if (typeof updateText === "string") {
      return updateText;
    }

    const text = (params as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }

    const prompt = fromPromptArray((params as { prompt?: unknown }).prompt);
    if (prompt) {
      return prompt;
    }
  }

  const result = envelope.result;
  if (result && typeof result === "object") {
    const text = (result as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
  }

  if (envelope.error) {
    return JSON.stringify(envelope.error, null, 2);
  }

  if (typeof envelope.method === "string") {
    return envelope.method;
  }

  return JSON.stringify(payload, null, 2);
}

export function buildTranscript(events: SandboxSessionEventRecord[]): Array<{
  id: string;
  sender: "client" | "agent";
  text: string;
  createdAt: number;
}> {
  return events.map((event) => ({
    id: event.id,
    sender: event.sender,
    text: extractEventText(event.payload),
    createdAt: event.createdAt,
  }));
}

export function resolveSessionSelection(input: { explicitSessionId: string | null; taskSessionId: string | null; sessions: SandboxSessionRecord[] }): {
  sessionId: string | null;
  staleSessionId: string | null;
} {
  const sessionIds = new Set(input.sessions.map((session) => session.id));
  const hasSession = (id: string | null): id is string => Boolean(id && sessionIds.has(id));

  if (hasSession(input.explicitSessionId)) {
    return { sessionId: input.explicitSessionId, staleSessionId: null };
  }

  if (hasSession(input.taskSessionId)) {
    return { sessionId: input.taskSessionId, staleSessionId: null };
  }

  const fallbackSessionId = input.sessions[0]?.id ?? null;
  if (fallbackSessionId) {
    return { sessionId: fallbackSessionId, staleSessionId: null };
  }

  if (input.explicitSessionId) {
    return { sessionId: null, staleSessionId: input.explicitSessionId };
  }

  if (input.taskSessionId) {
    return { sessionId: null, staleSessionId: input.taskSessionId };
  }

  return { sessionId: null, staleSessionId: null };
}
