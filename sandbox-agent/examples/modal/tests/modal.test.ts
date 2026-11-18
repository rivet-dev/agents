import { describe, it, expect } from "vitest";
import { SandboxAgent } from "sandbox-agent";
import { modal } from "sandbox-agent/modal";

const shouldRun = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("modal provider", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const secrets: Record<string, string> = {};
      if (process.env.ANTHROPIC_API_KEY) secrets.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (process.env.OPENAI_API_KEY) secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

      const sdk = await SandboxAgent.start({
        sandbox: modal({ create: { secrets } }),
      });

      try {
        const health = await sdk.getHealth();
        expect(health.status).toBe("ok");
      } finally {
        await sdk.destroySandbox();
      }
    },
    timeoutMs,
  );
});
