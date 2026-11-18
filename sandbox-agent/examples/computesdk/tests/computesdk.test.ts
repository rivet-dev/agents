import { describe, it, expect } from "vitest";
import { SandboxAgent } from "sandbox-agent";
import { computesdk } from "sandbox-agent/computesdk";

const hasModal = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
const hasVercel = Boolean(process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN);
const hasProviderKey = Boolean(
  process.env.BLAXEL_API_KEY || process.env.CSB_API_KEY || process.env.DAYTONA_API_KEY || process.env.E2B_API_KEY || hasModal || hasVercel,
);

const shouldRun = Boolean(process.env.COMPUTESDK_API_KEY) && hasProviderKey;
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("computesdk provider", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const envs: Record<string, string> = {};
      if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

      const sdk = await SandboxAgent.start({
        sandbox: computesdk({ create: { envs } }),
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
