import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");

/**
 * Cloudflare Workers integration test.
 *
 * Set RUN_CLOUDFLARE_EXAMPLES=1 to enable. Requires wrangler and Docker.
 *
 * This starts `wrangler dev` which:
 *  1. Builds the Dockerfile (cloudflare/sandbox base + sandbox-agent)
 *  2. Starts a local Workers runtime with Durable Objects and containers
 *  3. Exposes the app on a local port
 *
 * We then test through the proxy endpoint which forwards to sandbox-agent
 * running inside the container.
 */
const shouldRun = process.env.RUN_CLOUDFLARE_EXAMPLES === "1";
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 600_000;

const testFn = shouldRun ? it : it.skip;

interface WranglerDev {
  baseUrl: string;
  cleanup: () => void;
}

async function startWranglerDev(): Promise<WranglerDev> {
  // Build frontend assets first (wrangler expects dist/ to exist)
  execSync("npx vite build", { cwd: PROJECT_DIR, stdio: "pipe" });

  return new Promise<WranglerDev>((resolve, reject) => {
    const child: ChildProcess = spawn("npx", ["wrangler", "dev", "--port", "0"], {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        // Ensure wrangler picks up API keys to pass to the container
        NODE_ENV: "development",
      },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const cleanup = () => {
      if (child.pid) {
        // Kill process group to ensure wrangler and its children are cleaned up
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
      }
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`wrangler dev did not start within 120s.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    }, 120_000);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;

      // wrangler dev prints "Ready on http://localhost:XXXX" when ready
      const match = stdout.match(/Ready on (https?:\/\/[^\s]+)/i) ?? stdout.match(/(https?:\/\/(?:localhost|127\.0\.0\.1):\d+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ baseUrl: match[1], cleanup });
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Some wrangler versions print ready message to stderr
      const match = text.match(/Ready on (https?:\/\/[^\s]+)/i) ?? text.match(/(https?:\/\/(?:localhost|127\.0\.0\.1):\d+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ baseUrl: match[1], cleanup });
      }
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`wrangler dev failed to start: ${err.message}`));
      }
    });

    child.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`wrangler dev exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

describe("cloudflare example", () => {
  testFn(
    "starts wrangler dev and sandbox-agent responds via proxy",
    async () => {
      const { baseUrl, cleanup } = await startWranglerDev();
      try {
        // The Cloudflare example proxies requests through /sandbox/:name/proxy/*
        // Wait for the container inside the Durable Object to start sandbox-agent
        const healthUrl = `${baseUrl}/sandbox/test/proxy/v1/health`;

        let healthy = false;
        for (let i = 0; i < 120; i++) {
          try {
            const res = await fetch(healthUrl);
            if (res.ok) {
              const data = await res.json();
              // The proxied health endpoint returns {name: "Sandbox Agent", ...}
              if (data.status === "ok" || data.name === "Sandbox Agent") {
                healthy = true;
                break;
              }
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 2000));
        }
        expect(healthy).toBe(true);

        // Confirm a second request also works
        const response = await fetch(healthUrl);
        expect(response.ok).toBe(true);
      } finally {
        cleanup();
      }
    },
    timeoutMs,
  );
});
