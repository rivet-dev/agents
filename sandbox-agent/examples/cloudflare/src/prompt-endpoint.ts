import type { Sandbox } from "@cloudflare/sandbox";
import { SandboxAgent } from "sandbox-agent";

export type PromptRequest = {
  agent?: string;
  prompt?: string;
};

export async function runPromptEndpointStream(
  sandbox: Sandbox,
  request: PromptRequest,
  port: number,
  emit: (event: { type: string; [key: string]: unknown }) => Promise<void> | void,
): Promise<void> {
  const client = await SandboxAgent.connect({
    fetch: (req, init) =>
      sandbox.containerFetch(
        req,
        {
          ...(init ?? {}),
          // Cloudflare containerFetch may drop long-lived update streams when
          // a forwarded AbortSignal is cancelled; clear it for this path.
          signal: undefined,
        },
        port,
      ),
  });

  let unsubscribe: (() => void) | undefined;
  try {
    const session = await client.createSession({
      agent: request.agent ?? "codex",
    });

    const promptText = request.prompt?.trim() || "Reply with a short confirmation.";
    await emit({
      type: "session.created",
      sessionId: session.id,
      agent: session.agent,
      prompt: promptText,
    });

    let pendingWrites: Promise<void> = Promise.resolve();
    unsubscribe = session.onEvent((event) => {
      pendingWrites = pendingWrites
        .then(async () => {
          await emit({ type: "session.event", event });
        })
        .catch(() => {});
    });

    const response = await session.prompt([{ type: "text", text: promptText }]);
    await pendingWrites;
    await emit({ type: "prompt.response", response });
    await emit({ type: "prompt.completed" });
  } finally {
    if (unsubscribe) {
      unsubscribe();
    }
    await Promise.race([client.dispose(), new Promise((resolve) => setTimeout(resolve, 250))]);
  }
}
