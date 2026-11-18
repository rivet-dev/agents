import { describe, it, expect } from "vitest";
import { SandboxAgent } from "sandbox-agent";
import { sprites } from "sandbox-agent/sprites";

const shouldRun = Boolean(process.env.SPRITES_API_KEY || process.env.SPRITE_TOKEN || process.env.SPRITES_TOKEN);
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("sprites provider", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const env: Record<string, string> = {};
      if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

      const sdk = await SandboxAgent.start({
        sandbox: sprites({
          token: process.env.SPRITES_API_KEY ?? process.env.SPRITE_TOKEN ?? process.env.SPRITES_TOKEN,
          env,
        }),
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
