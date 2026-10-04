import { execSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFoundryLogger } from "@sandbox-agent/foundry-shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const sidecarDir = resolve(desktopRoot, "src-tauri/sidecars");
const logger = createFoundryLogger({
  service: "foundry-desktop-build",
  bindings: {
    script: "build-sidecar",
  },
});

const isDev = process.argv.includes("--dev");

// Detect current architecture
function currentTarget(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${arch}-apple-darwin`;
}

// Target triples to build
const targets: Array<{ bunTarget: string; tripleTarget: string }> = isDev
  ? [
      {
        bunTarget: process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64",
        tripleTarget: currentTarget(),
      },
    ]
  : [
      {
        bunTarget: "bun-darwin-arm64",
        tripleTarget: "aarch64-apple-darwin",
      },
      {
        bunTarget: "bun-darwin-x64",
        tripleTarget: "x86_64-apple-darwin",
      },
    ];

function run(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  logger.info({ command: cmd, cwd: opts?.cwd ?? desktopRoot }, "run_command");
  execSync(cmd, {
    stdio: "inherit",
    cwd: opts?.cwd ?? desktopRoot,
    env: { ...process.env, ...opts?.env },
  });
}

// Step 1: Build the backend with tsup
logger.info("building_backend");
run("pnpm --filter @sandbox-agent/foundry-backend build", {
  cwd: resolve(desktopRoot, "../../.."),
});

// Step 2: Compile standalone binaries with bun
mkdirSync(sidecarDir, { recursive: true });

const backendEntry = resolve(desktopRoot, "../backend/dist/index.js");

if (!existsSync(backendEntry)) {
  logger.error({ backendEntry }, "backend_build_output_not_found");
  process.exit(1);
}

for (const { bunTarget, tripleTarget } of targets) {
  const outfile = resolve(sidecarDir, `foundry-backend-${tripleTarget}`);
  logger.info({ bunTarget, tripleTarget, outfile }, "compiling_sidecar");
  run(`bun build --compile --target ${bunTarget} ${backendEntry} --outfile ${outfile}`);
}

logger.info({ targets: targets.map((target) => target.tripleTarget) }, "sidecar_build_complete");
