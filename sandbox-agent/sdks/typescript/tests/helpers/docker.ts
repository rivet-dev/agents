import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const CONTAINER_PORT = 3000;
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_IMAGE_TAG = "sandbox-agent-test:dev";
const STANDARD_PATHS = new Set(["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]);

let cachedImage: string | undefined;
let containerCounter = 0;

export type DockerSandboxAgentHandle = {
  baseUrl: string;
  token: string;
  dispose: () => Promise<void>;
};

export type DockerSandboxAgentOptions = {
  env?: Record<string, string>;
  pathMode?: "merge" | "replace";
  timeoutMs?: number;
};

type TestLayout = {
  rootDir: string;
  homeDir: string;
  xdgDataHome: string;
  xdgStateHome: string;
  appDataDir: string;
  localAppDataDir: string;
  installDir: string;
};

export function createDockerTestLayout(): TestLayout {
  const tempRoot = join(REPO_ROOT, ".context", "docker-test-");
  mkdirSync(resolve(REPO_ROOT, ".context"), { recursive: true });
  const rootDir = mkdtempSync(tempRoot);
  const homeDir = join(rootDir, "home");
  const xdgDataHome = join(rootDir, "xdg-data");
  const xdgStateHome = join(rootDir, "xdg-state");
  const appDataDir = join(rootDir, "appdata", "Roaming");
  const localAppDataDir = join(rootDir, "appdata", "Local");
  const installDir = join(xdgDataHome, "sandbox-agent", "bin");

  for (const dir of [homeDir, xdgDataHome, xdgStateHome, appDataDir, localAppDataDir, installDir]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    rootDir,
    homeDir,
    xdgDataHome,
    xdgStateHome,
    appDataDir,
    localAppDataDir,
    installDir,
  };
}

export function disposeDockerTestLayout(layout: TestLayout): void {
  try {
    rmSync(layout.rootDir, { recursive: true, force: true });
  } catch (error) {
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      try {
        execFileSync(
          "docker",
          [
            "run",
            "--rm",
            "--user",
            "0:0",
            "--entrypoint",
            "sh",
            "-v",
            `${layout.rootDir}:${layout.rootDir}`,
            ensureImage(),
            "-c",
            `chown -R ${process.getuid()}:${process.getgid()} '${layout.rootDir}'`,
          ],
          { stdio: "pipe" },
        );
        rmSync(layout.rootDir, { recursive: true, force: true });
        return;
      } catch {}
    }
    throw error;
  }
}

export async function startDockerSandboxAgent(layout: TestLayout, options: DockerSandboxAgentOptions = {}): Promise<DockerSandboxAgentHandle> {
  const image = ensureImage();
  const containerId = uniqueContainerId();
  const env = buildEnv(layout, options.env ?? {}, options.pathMode ?? "merge");
  const mounts = buildMounts(layout.rootDir, env);

  const args = ["run", "-d", "--rm", "--name", containerId, "-p", `127.0.0.1::${CONTAINER_PORT}`];

  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }

  if (process.platform === "linux") {
    args.push("--add-host", "host.docker.internal:host-gateway");
  }

  for (const mount of mounts) {
    args.push("-v", `${mount}:${mount}`);
  }

  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(image, "server", "--host", "0.0.0.0", "--port", String(CONTAINER_PORT), "--no-token");

  execFileSync("docker", args, { stdio: "pipe" });

  try {
    const mapping = execFileSync("docker", ["port", containerId, `${CONTAINER_PORT}/tcp`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const mappingParts = mapping.split(":");
    const hostPort = mappingParts[mappingParts.length - 1]?.trim();
    if (!hostPort) {
      throw new Error(`missing mapped host port in ${mapping}`);
    }
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    await waitForHealth(baseUrl, options.timeoutMs ?? 30_000);

    return {
      baseUrl,
      token: "",
      dispose: async () => {
        try {
          execFileSync("docker", ["rm", "-f", containerId], { stdio: "pipe" });
        } catch {}
      },
    };
  } catch (error) {
    try {
      execFileSync("docker", ["rm", "-f", containerId], { stdio: "pipe" });
    } catch {}
    throw error;
  }
}

function ensureImage(): string {
  if (cachedImage) {
    return cachedImage;
  }

  cachedImage = process.env.SANDBOX_AGENT_TEST_IMAGE ?? DEFAULT_IMAGE_TAG;
  execFileSync("docker", ["build", "--tag", cachedImage, "--file", resolve(REPO_ROOT, "docker/test-agent/Dockerfile"), REPO_ROOT], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return cachedImage;
}

function buildEnv(layout: TestLayout, extraEnv: Record<string, string>, pathMode: "merge" | "replace"): Record<string, string> {
  const env: Record<string, string> = {
    HOME: layout.homeDir,
    USERPROFILE: layout.homeDir,
    XDG_DATA_HOME: layout.xdgDataHome,
    XDG_STATE_HOME: layout.xdgStateHome,
    APPDATA: layout.appDataDir,
    LOCALAPPDATA: layout.localAppDataDir,
    PATH: DEFAULT_PATH,
  };

  const customPathEntries = new Set<string>();
  for (const entry of (extraEnv.PATH ?? "").split(":")) {
    if (!entry || entry === DEFAULT_PATH || !entry.startsWith("/")) continue;
    if (entry.startsWith(layout.rootDir)) {
      customPathEntries.add(entry);
    }
  }
  if (pathMode === "replace") {
    env.PATH = extraEnv.PATH ?? "";
  } else if (customPathEntries.size > 0) {
    env.PATH = `${Array.from(customPathEntries).join(":")}:${DEFAULT_PATH}`;
  }

  for (const [key, value] of Object.entries(extraEnv)) {
    if (key === "PATH") {
      continue;
    }
    env[key] = rewriteLocalhostUrl(key, value);
  }

  return env;
}

function buildMounts(rootDir: string, env: Record<string, string>): string[] {
  const mounts = new Set<string>([rootDir]);

  for (const key of ["HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA", "SANDBOX_AGENT_DESKTOP_FAKE_STATE_DIR"]) {
    const value = env[key];
    if (value?.startsWith("/")) {
      mounts.add(value);
    }
  }

  for (const entry of (env.PATH ?? "").split(":")) {
    if (entry.startsWith("/") && !STANDARD_PATHS.has(entry)) {
      mounts.add(entry);
    }
  }

  return Array.from(mounts);
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`timed out waiting for sandbox-agent health at ${baseUrl}`);
}

function uniqueContainerId(): string {
  containerCounter += 1;
  return `sandbox-agent-ts-${process.pid}-${Date.now().toString(36)}-${containerCounter.toString(36)}`;
}

function rewriteLocalhostUrl(key: string, value: string): string {
  if (key.endsWith("_URL") || key.endsWith("_URI")) {
    return value.replace("http://127.0.0.1", "http://host.docker.internal").replace("http://localhost", "http://host.docker.internal");
  }
  return value;
}
