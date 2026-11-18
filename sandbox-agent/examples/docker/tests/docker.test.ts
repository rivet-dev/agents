import { describe, it, expect } from "vitest";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";

/**
 * Docker integration test.
 *
 * Set SANDBOX_AGENT_DOCKER_IMAGE to the image tag to test (e.g. a locally-built
 * full image). The test starts a container from that image, waits for
 * sandbox-agent to become healthy, and validates the /v1/health endpoint.
 */
const image = process.env.SANDBOX_AGENT_DOCKER_IMAGE;
const shouldRun = Boolean(image);
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("docker example", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const { baseUrl, cleanup } = await startDockerSandbox({
        port: 2468,
        image: image!,
      });
      try {
        // Wait for health check
        let healthy = false;
        for (let i = 0; i < 60; i++) {
          try {
            const res = await fetch(`${baseUrl}/v1/health`);
            if (res.ok) {
              const data = await res.json();
              if (data.status === "ok") {
                healthy = true;
                break;
              }
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 1000));
        }
        expect(healthy).toBe(true);

        const response = await fetch(`${baseUrl}/v1/health`);
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
