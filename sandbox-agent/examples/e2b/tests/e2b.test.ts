import { describe, it, expect } from "vitest";
import { buildHeaders } from "@sandbox-agent/example-shared";
import { setupE2BSandboxAgent } from "../src/e2b.ts";

const shouldRun = Boolean(process.env.E2B_API_KEY);
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("e2b example", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const { baseUrl, token, cleanup } = await setupE2BSandboxAgent();
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
