// @ts-nocheck
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { setupTest } from "rivetkit/test";
import { organizationKey } from "../src/actors/keys.js";
import { registry } from "../src/actors/index.js";
import { organizationWorkflowQueueName } from "../src/actors/organization/queues.js";
import { repoIdFromRemote } from "../src/services/repo.js";
import { createTestDriver } from "./helpers/test-driver.js";
import { createTestRuntimeContext } from "./helpers/test-context.js";

const runActorIntegration = process.env.HF_ENABLE_ACTOR_INTEGRATION_TESTS === "1";

function createRepo(): { repoPath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), "hf-isolation-repo-"));
  execFileSync("git", ["init"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "Foundry Test"], { cwd: repoPath });
  writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath });
  return { repoPath };
}

async function waitForOrganizationRows(ws: any, organizationId: string, expectedCount: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await ws.listTasks({ organizationId });
    if (rows.length >= expectedCount) {
      return rows;
    }
    await delay(50);
  }
  return ws.listTasks({ organizationId });
}

describe("organization isolation", () => {
  it.skipIf(!runActorIntegration)("keeps task lists isolated by organization", async (t) => {
    const testDriver = createTestDriver();
    createTestRuntimeContext(testDriver);

    const { client } = await setupTest(t, registry);
    const wsA = await client.organization.getOrCreate(organizationKey("alpha"), {
      createWithInput: "alpha",
    });
    const wsB = await client.organization.getOrCreate(organizationKey("beta"), {
      createWithInput: "beta",
    });

    const { repoPath } = createRepo();
    const repoId = repoIdFromRemote(repoPath);
    await wsA.send(organizationWorkflowQueueName("organization.command.github.repository_projection.apply"), { repoId, remoteUrl: repoPath }, { wait: true });
    await wsB.send(organizationWorkflowQueueName("organization.command.github.repository_projection.apply"), { repoId, remoteUrl: repoPath }, { wait: true });

    await wsA.createTask({
      organizationId: "alpha",
      repoId,
      task: "task A",
      sandboxProviderId: "local",
      explicitBranchName: "feature/a",
      explicitTitle: "A",
    });

    await wsB.createTask({
      organizationId: "beta",
      repoId,
      task: "task B",
      sandboxProviderId: "local",
      explicitBranchName: "feature/b",
      explicitTitle: "B",
    });

    const aRows = await waitForOrganizationRows(wsA, "alpha", 1);
    const bRows = await waitForOrganizationRows(wsB, "beta", 1);

    expect(aRows.length).toBe(1);
    expect(bRows.length).toBe(1);
    expect(aRows[0]?.organizationId).toBe("alpha");
    expect(bRows[0]?.organizationId).toBe("beta");
    expect(aRows[0]?.taskId).not.toBe(bRows[0]?.taskId);
  });
});
