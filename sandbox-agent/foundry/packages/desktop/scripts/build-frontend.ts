import { execSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFoundryLogger } from "@sandbox-agent/foundry-shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../../..");
const frontendDist = resolve(desktopRoot, "../frontend/dist");
const destDir = resolve(desktopRoot, "frontend-dist");
const logger = createFoundryLogger({
  service: "foundry-desktop-build",
  bindings: {
    script: "build-frontend",
  },
});

function run(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  logger.info({ command: cmd, cwd: opts?.cwd ?? repoRoot }, "run_command");
  execSync(cmd, {
    stdio: "inherit",
    cwd: opts?.cwd ?? repoRoot,
    env: { ...process.env, ...opts?.env },
  });
}

// Step 1: Build the frontend with the desktop-specific backend endpoint
logger.info("building_frontend");
run("pnpm --filter @sandbox-agent/foundry-frontend build", {
  env: {
    VITE_HF_BACKEND_ENDPOINT: "http://127.0.0.1:7741/v1/rivet",
  },
});

// Step 2: Copy dist to frontend-dist/
logger.info({ frontendDist, destDir }, "copying_frontend_dist");
if (existsSync(destDir)) {
  rmSync(destDir, { recursive: true });
}
cpSync(frontendDist, destDir, { recursive: true });

// Step 3: Strip react-scan script from index.html (it loads unconditionally)
const indexPath = resolve(destDir, "index.html");
let html = readFileSync(indexPath, "utf-8");
html = html.replace(/<script\s+src="https:\/\/unpkg\.com\/react-scan\/dist\/auto\.global\.js"[^>]*><\/script>\s*/g, "");
writeFileSync(indexPath, html);

logger.info({ indexPath }, "frontend_build_complete");
