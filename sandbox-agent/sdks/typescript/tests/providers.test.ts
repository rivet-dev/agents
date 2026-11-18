import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const _require = createRequire(import.meta.url);
import { InMemorySessionPersistDriver, SandboxAgent, type SandboxProvider } from "../src/index.ts";
import { local } from "../src/providers/local.ts";
import { docker } from "../src/providers/docker.ts";
import { e2b } from "../src/providers/e2b.ts";
import { daytona } from "../src/providers/daytona.ts";
import { agentcomputer } from "../src/providers/agentcomputer.ts";
import { vercel } from "../src/providers/vercel.ts";
import { modal } from "../src/providers/modal.ts";
import { computesdk } from "../src/providers/computesdk.ts";
import { sprites } from "../src/providers/sprites.ts";
import { prepareMockAgentDataHome } from "./helpers/mock-agent.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findBinary(): string | null {
  if (process.env.SANDBOX_AGENT_BIN) {
    return process.env.SANDBOX_AGENT_BIN;
  }

  const cargoPaths = [resolve(__dirname, "../../../target/debug/sandbox-agent"), resolve(__dirname, "../../../target/release/sandbox-agent")];
  for (const candidate of cargoPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const BINARY_PATH = findBinary();
// if (!BINARY_PATH) {
//   throw new Error("sandbox-agent binary not found. Build it (cargo build -p sandbox-agent) or set SANDBOX_AGENT_BIN.");
// }
if (!process.env.SANDBOX_AGENT_BIN && BINARY_PATH) {
  process.env.SANDBOX_AGENT_BIN = BINARY_PATH;
}

function isModuleAvailable(name: string): boolean {
  try {
    _require.resolve(name);
    return true;
  } catch {
    return existsSync(resolve(__dirname, "../node_modules", ...name.split("/"), "package.json"));
  }
}

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provider registry — each entry defines how to create a provider and
// what preconditions are required for it to run.
// ---------------------------------------------------------------------------

interface ProviderEntry {
  name: string;
  /** Human-readable reasons this provider can't run, or empty if ready. */
  skipReasons: string[];
  /** Human-readable reasons session tests can't run, or empty if ready. */
  sessionSkipReasons?: string[];
  /** Return a fresh provider instance for a single test. */
  createProvider: () => SandboxProvider;
  /** Optional per-provider setup (e.g. create temp dirs). Returns cleanup fn. */
  setup?: () => { cleanup: () => void };
  /** Agent to use for session tests. */
  agent: string;
  /** Timeout for start() — remote providers need longer. */
  startTimeoutMs?: number;
  /** Some providers (e.g. local) can verify the sandbox is gone after destroy. */
  canVerifyDestroyedSandbox?: boolean;
  /** Working directory to use for createSession/prompt tests. */
  sessionCwd?: string;
  /**
   * Whether session tests (createSession, prompt) should run.
   * The mock agent only works with local provider (requires mock-acp process binary).
   * Remote providers need a real agent (claude) which requires compatible server version + API keys.
   */
  sessionTestsEnabled: boolean;
}

function missingEnvVars(...vars: string[]): string[] {
  const missing = vars.filter((v) => !process.env[v]);
  return missing.length > 0 ? [`missing env: ${missing.join(", ")}`] : [];
}

function missingAnyEnvVars(...vars: string[]): string[] {
  return vars.some((v) => Boolean(process.env[v])) ? [] : [`missing env: one of ${vars.join(", ")}`];
}

function missingModules(...modules: string[]): string[] {
  const missing = modules.filter((m) => !isModuleAvailable(m));
  return missing.length > 0 ? [`missing npm packages: ${missing.join(", ")}`] : [];
}

function collectApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) keys.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) keys.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return keys;
}

function buildProviders(): ProviderEntry[] {
  const entries: ProviderEntry[] = [];

  // --- local ---
  // Uses the mock-acp process binary created by prepareMockAgentDataHome.
  {
    let dataHome: string | undefined;
    entries.push({
      name: "local",
      skipReasons: [],
      agent: "mock",
      canVerifyDestroyedSandbox: true,
      sessionCwd: process.cwd(),
      sessionTestsEnabled: true,
      setup() {
        dataHome = mkdtempSync(join(tmpdir(), "sdk-provider-local-"));
        return {
          cleanup: () => {
            if (dataHome) rmSync(dataHome, { recursive: true, force: true });
          },
        };
      },
      createProvider() {
        return local({
          log: "silent",
          env: prepareMockAgentDataHome(dataHome!),
        });
      },
    });
  }

  // --- docker ---
  // Requires SANDBOX_AGENT_DOCKER_IMAGE (e.g. "sandbox-agent-dev:local").
  // Session tests disabled: released server images use a different ACP protocol
  // version than the current SDK branch, causing "Query closed before response
  // received" errors on session creation.
  {
    entries.push({
      name: "docker",
      skipReasons: [
        ...missingEnvVars("SANDBOX_AGENT_DOCKER_IMAGE"),
        ...missingModules("dockerode", "get-port"),
        ...(isDockerAvailable() ? [] : ["Docker daemon not available"]),
      ],
      agent: "claude",
      startTimeoutMs: 180_000,
      canVerifyDestroyedSandbox: false,
      sessionTestsEnabled: false,
      createProvider() {
        const apiKeys = [
          process.env.ANTHROPIC_API_KEY ? `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}` : "",
          process.env.OPENAI_API_KEY ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}` : "",
        ].filter(Boolean);
        return docker({
          image: process.env.SANDBOX_AGENT_DOCKER_IMAGE,
          env: apiKeys,
        });
      },
    });
  }

  // --- e2b ---
  {
    entries.push({
      name: "e2b",
      skipReasons: [...missingEnvVars("E2B_API_KEY"), ...missingModules("@e2b/code-interpreter")],
      agent: "claude",
      startTimeoutMs: 300_000,
      canVerifyDestroyedSandbox: false,
      sessionSkipReasons: missingEnvVars("ANTHROPIC_API_KEY"),
      sessionCwd: "/home/user",
      sessionTestsEnabled: true,
      createProvider() {
        return e2b({
          create: { envs: collectApiKeys() },
        });
      },
    });
  }

  // --- daytona ---
  {
    entries.push({
      name: "daytona",
      skipReasons: [...missingEnvVars("DAYTONA_API_KEY"), ...missingModules("@daytonaio/sdk")],
      agent: "claude",
      startTimeoutMs: 300_000,
      canVerifyDestroyedSandbox: false,
      sessionSkipReasons: missingEnvVars("ANTHROPIC_API_KEY"),
      sessionCwd: "/home/sandbox",
      sessionTestsEnabled: true,
      createProvider() {
        return daytona({
          create: { envVars: collectApiKeys() },
        });
      },
    });
  }

  // --- agentcomputer ---
  {
    entries.push({
      name: "agentcomputer",
      skipReasons: missingAnyEnvVars("COMPUTER_API_KEY", "AGENTCOMPUTER_API_KEY"),
      agent: "claude",
      startTimeoutMs: 300_000,
      canVerifyDestroyedSandbox: false,
      sessionTestsEnabled: false,
      createProvider() {
        return agentcomputer();
      },
    });
  }

  // --- vercel ---
  {
    entries.push({
      name: "vercel",
      skipReasons: [...missingEnvVars("VERCEL_ACCESS_TOKEN"), ...missingModules("@vercel/sandbox")],
      agent: "claude",
      startTimeoutMs: 300_000,
      canVerifyDestroyedSandbox: false,
      sessionTestsEnabled: false,
      createProvider() {
        return vercel({
          create: { env: collectApiKeys() },
        });
      },
    });
  }

  // --- modal ---
  {
    entries.push({
      name: "modal",
      skipReasons: [...missingEnvVars("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"), ...missingModules("modal")],
      agent: "claude",
      startTimeoutMs: 300_000,
      canVerifyDestroyedSandbox: false,
      sessionSkipReasons: missingEnvVars("ANTHROPIC_API_KEY"),
      sessionCwd: "/root",
      sessionTestsEnabled: true,
      createProvider() {
        return modal({
          image: process.env.SANDBOX_AGENT_MODAL_IMAGE,
          create: { secrets: collectApiKeys() },
        });
      },
    });
  }

  // --- computesdk ---
  {
    entries.push({
      name: "computesdk",
      skipReasons: [...missingEnvVars("COMPUTESDK_API_KEY"), ...missingModules("computesdk")],
      agent: "claude",
      startTimeoutMs: 300_000,
      canVerifyDestroyedSandbox: false,
      sessionTestsEnabled: false,
      createProvider() {
        return computesdk({
          create: { envs: collectApiKeys() },
        });
      },
    });
  }

  // --- sprites ---
  {
    entries.push({
      name: "sprites",
      skipReasons: [...missingAnyEnvVars("SPRITES_API_KEY", "SPRITE_TOKEN", "SPRITES_TOKEN"), ...missingModules("@fly/sprites")],
      agent: "claude",
      startTimeoutMs: 300_000,
      canVerifyDestroyedSandbox: false,
      sessionSkipReasons: missingEnvVars("ANTHROPIC_API_KEY"),
      sessionCwd: "/home/sprite",
      sessionTestsEnabled: true,
      createProvider() {
        return sprites({
          token: process.env.SPRITES_API_KEY ?? process.env.SPRITE_TOKEN ?? process.env.SPRITES_TOKEN,
          env: collectApiKeys(),
          installAgents: ["claude"],
          serviceStartDuration: "10m",
        });
      },
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Shared test suite — runs the same assertions against every provider.
//
// Provider lifecycle tests (start, sandboxId, reconnect, destroy) use only
// listAgents() and never create sessions — these work regardless of which
// agents are installed or whether API keys are present.
//
// Session tests (createSession, prompt) are only enabled for providers where
// the agent is known to work. For local, the mock-acp process binary is
// created by test setup. For remote providers, a real agent (claude) is used
// which requires ANTHROPIC_API_KEY and a compatible server version.
// ---------------------------------------------------------------------------

function providerSuite(entry: ProviderEntry) {
  const skip = entry.skipReasons.length > 0;

  const descFn = skip ? describe.skip : describe;

  descFn(`SandboxProvider: ${entry.name}`, () => {
    let sdk: SandboxAgent | undefined;
    let cleanupFn: (() => void) | undefined;

    if (skip) {
      it.skip(`skipped — ${entry.skipReasons.join("; ")}`, () => {});
      return;
    }

    beforeAll(() => {
      const result = entry.setup?.();
      cleanupFn = result?.cleanup;
    });

    afterEach(async () => {
      if (!sdk) return;
      await sdk.killSandbox().catch(async () => {
        await sdk?.dispose().catch(() => {});
      });
      sdk = undefined;
    }, 30_000);

    afterAll(() => {
      cleanupFn?.();
    });

    // -- lifecycle tests (no session creation) --

    it(
      "starts with a prefixed sandboxId and passes health",
      async () => {
        sdk = await SandboxAgent.start({ sandbox: entry.createProvider() });
        expect(sdk.sandboxId).toMatch(new RegExp(`^${entry.name}/`));

        // listAgents() awaits the internal health gate, confirming the server is ready.
        const agents = await sdk.listAgents();
        expect(agents.agents.length).toBeGreaterThan(0);
      },
      entry.startTimeoutMs,
    );

    it("rejects mismatched sandboxId prefixes", async () => {
      await expect(
        SandboxAgent.start({
          sandbox: entry.createProvider(),
          sandboxId: "wrong-provider/example",
        }),
      ).rejects.toThrow(/provider/i);
    });

    it(
      "reconnects after dispose without destroying the sandbox",
      async () => {
        sdk = await SandboxAgent.start({ sandbox: entry.createProvider() });
        const sandboxId = sdk.sandboxId;
        expect(sandboxId).toBeTruthy();

        await sdk.dispose();

        const reconnected = await SandboxAgent.start({
          sandbox: entry.createProvider(),
          sandboxId,
        });

        const agents = await reconnected.listAgents();
        expect(agents.agents.length).toBeGreaterThan(0);
        sdk = reconnected;
      },
      entry.startTimeoutMs ? entry.startTimeoutMs * 2 : undefined,
    );

    it(
      "destroySandbox tears the sandbox down",
      async () => {
        sdk = await SandboxAgent.start({ sandbox: entry.createProvider() });
        const sandboxId = sdk.sandboxId;
        expect(sandboxId).toBeTruthy();

        await sdk.destroySandbox();
        sdk = undefined;

        if (entry.canVerifyDestroyedSandbox) {
          const reconnected = await SandboxAgent.start({
            sandbox: entry.createProvider(),
            sandboxId,
            skipHealthCheck: true,
          });
          await expect(reconnected.listAgents()).rejects.toThrow();
        }

        if (entry.name === "e2b") {
          const rawSandboxId = sandboxId?.slice(sandboxId.indexOf("/") + 1);
          await entry.createProvider().kill?.(rawSandboxId!);
        }
      },
      entry.startTimeoutMs,
    );

    // -- session tests (require working agent) --

    const sessionIt = entry.sessionTestsEnabled && (entry.sessionSkipReasons?.length ?? 0) === 0 ? it : it.skip;

    sessionIt(
      "creates sessions with persisted sandboxId",
      async () => {
        const persist = new InMemorySessionPersistDriver();
        sdk = await SandboxAgent.start({ sandbox: entry.createProvider(), persist });

        const session = await sdk.createSession({ agent: entry.agent, cwd: entry.sessionCwd });
        const record = await persist.getSession(session.id);

        expect(record?.sandboxId).toBe(sdk.sandboxId);
      },
      entry.startTimeoutMs,
    );

    sessionIt(
      "sends a prompt and receives a response",
      async () => {
        sdk = await SandboxAgent.start({ sandbox: entry.createProvider() });

        const session = await sdk.createSession({ agent: entry.agent, cwd: entry.sessionCwd });
        const events: unknown[] = [];
        const off = session.onEvent((event) => {
          events.push(event);
        });

        const result = await session.prompt([{ type: "text", text: "Say hello in one word." }]);
        off();

        expect(result.stopReason).toBe("end_turn");
        expect(events.length).toBeGreaterThan(0);
      },
      entry.startTimeoutMs ? entry.startTimeoutMs * 2 : 30_000,
    );
  });
}

// ---------------------------------------------------------------------------
// Register all providers
// ---------------------------------------------------------------------------

for (const entry of buildProviders()) {
  providerSuite(entry);
}
