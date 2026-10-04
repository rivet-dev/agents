import { describe, it, expect } from "vitest";
import { SandboxAgent } from "sandbox-agent";
import { agentcomputer } from "sandbox-agent/agentcomputer";

const shouldRun = Boolean(process.env.COMPUTER_API_KEY || process.env.AGENTCOMPUTER_API_KEY);
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("agentcomputer provider", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const sdk = await SandboxAgent.start({
        sandbox: agentcomputer(),
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
