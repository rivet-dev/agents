import { describe, it, expect } from "vitest";
import { buildHeaders } from "@sandbox-agent/example-shared";
import { setupVercelSandboxAgent } from "../src/vercel.ts";

const shouldRun = Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_ACCESS_TOKEN);
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("vercel example", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const { baseUrl, token, cleanup } = await setupVercelSandboxAgent();
      try {
        const response = await fetch(`${baseUrl}/v1/health`, {
          headers: buildHeaders({ token }),
        });
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.status).toBe("ok");
      } finally {
        await cleanup();
      }
    },
    timeoutMs,
  );
});
