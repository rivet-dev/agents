import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxAgent } from "sandbox-agent";
import { PostgresSessionPersistDriver } from "./persist.ts";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";
import { detectAgent } from "@sandbox-agent/example-shared";

// --- Postgres setup (Docker or DATABASE_URL) ---

let containerId: string | undefined;
let connectionString: string;

if (process.env.DATABASE_URL) {
  connectionString = process.env.DATABASE_URL;
} else {
  const name = `persist-example-${randomUUID().slice(0, 8)}`;
  containerId = execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=sandbox",
      "-p",
      "127.0.0.1::5432",
      "postgres:16-alpine",
    ],
    { encoding: "utf8" },
  ).trim();
  const port = execFileSync("docker", ["port", containerId, "5432/tcp"], { encoding: "utf8" })
    .trim()
    .split("\n")[0]
    ?.match(/:(\d+)$/)?.[1];
  connectionString = `postgres://postgres:postgres@127.0.0.1:${port}/sandbox`;
  console.log(`Postgres on port ${port}`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const c = new Client({ connectionString });
    try {
      await c.connect();
      await c.query("SELECT 1");
      await c.end();
      break;
    } catch {
      try {
        await c.end();
      } catch {}
      await delay(250);
    }
  }
}

try {
  const persist = new PostgresSessionPersistDriver({ connectionString });

  console.log("Starting sandbox...");
  const sandbox = await startDockerSandbox({
    port: 3000,
  });

  const sdk = await SandboxAgent.connect({ baseUrl: sandbox.baseUrl, persist });

  const session = await sdk.createSession({ agent: detectAgent() });
  console.log(`Created session ${session.id}`);

  await session.prompt([{ type: "text", text: "Say hello in one sentence." }]);
  console.log("Prompt complete.");

  const sessions = await sdk.listSessions();
  console.log(`\nSessions (${sessions.items.length}):`);
  for (const s of sessions.items) {
    console.log(`  ${s.id}  agent=${s.agent}`);
  }

  const events = await sdk.getEvents({ sessionId: session.id });
  console.log(`\nSession history (${events.items.length} events):`);
  for (const e of events.items) {
    console.log(`  [${e.eventIndex}] ${e.sender}: ${JSON.stringify(e.payload).slice(0, 120)}`);
  }

  await persist.close();
  await sdk.dispose();
  await sandbox.cleanup();
} finally {
  if (containerId) {
    try {
      execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
    } catch {}
  }
}
