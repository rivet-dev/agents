import { randomUUID } from "node:crypto";
import type { FoundryAppSnapshot, StarSandboxAgentRepoInput, StarSandboxAgentRepoResult } from "@sandbox-agent/foundry-shared";
import { getOrCreateGithubData, getOrCreateOrganization } from "../../handles.js";
import { assertAppOrganization, buildAppSnapshot, getOrganizationState, requireEligibleOrganization, requireSignedInSession } from "../app-shell.js";
import { getBetterAuthService } from "../../../services/better-auth.js";
import { getActorRuntimeContext } from "../../context.js";
import { resolveOrganizationGithubAuth } from "../../../services/github-auth.js";

const SANDBOX_AGENT_REPO = "rivet-dev/sandbox-agent";

export const organizationOnboardingActions = {
  async skipAppStarterRepo(c: any, input: { sessionId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    await getBetterAuthService().upsertUserProfile(session.authUserId, {
      starterRepoStatus: "skipped",
      starterRepoSkippedAt: Date.now(),
      starterRepoStarredAt: null,
    });
    return await buildAppSnapshot(c, input.sessionId);
  },

  async starAppStarterRepo(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const organization = await getOrCreateOrganization(c, input.organizationId);
    await organization.starSandboxAgentRepo({
      organizationId: input.organizationId,
    });
    await getBetterAuthService().upsertUserProfile(session.authUserId, {
      starterRepoStatus: "starred",
      starterRepoStarredAt: Date.now(),
      starterRepoSkippedAt: null,
    });
    return await buildAppSnapshot(c, input.sessionId);
  },

  async selectAppOrganization(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    await getBetterAuthService().setActiveOrganization(input.sessionId, input.organizationId);
    await getOrCreateGithubData(c, input.organizationId);
    return await buildAppSnapshot(c, input.sessionId);
  },

  async beginAppGithubInstall(c: any, input: { sessionId: string; organizationId: string }): Promise<{ url: string }> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);
    if (organizationState.snapshot.kind !== "organization") {
      return {
        url: `${appShell.appUrl}/organizations/${input.organizationId}`,
      };
    }
    return {
      url: await appShell.github.buildInstallationUrl(organizationState.githubLogin, randomUUID()),
    };
  },

  async starSandboxAgentRepo(c: any, input: StarSandboxAgentRepoInput): Promise<StarSandboxAgentRepoResult> {
    const { driver } = getActorRuntimeContext();
    const auth = await resolveOrganizationGithubAuth(c, c.state.organizationId);
    await driver.github.starRepository(SANDBOX_AGENT_REPO, {
      githubToken: auth?.githubToken ?? null,
    });
    return {
      repo: SANDBOX_AGENT_REPO,
      starredAt: Date.now(),
    };
  },
};
