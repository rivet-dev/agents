import type { FoundryAppSnapshot, UpdateFoundryOrganizationProfileInput, WorkspaceModelId } from "@sandbox-agent/foundry-shared";
import { getBetterAuthService } from "../../../services/better-auth.js";
import { getOrCreateOrganization } from "../../handles.js";
import {
  assertAppOrganization,
  assertOrganizationShell,
  buildAppSnapshot,
  buildOrganizationState,
  buildOrganizationStateIfInitialized,
  requireEligibleOrganization,
  requireSignedInSession,
} from "../app-shell.js";

export const organizationShellActions = {
  async getAppSnapshot(c: any, input: { sessionId: string }): Promise<FoundryAppSnapshot> {
    return await buildAppSnapshot(c, input.sessionId);
  },

  async setAppDefaultModel(c: any, input: { sessionId: string; defaultModel: WorkspaceModelId }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    await getBetterAuthService().upsertUserProfile(session.authUserId, {
      defaultModel: input.defaultModel,
    });
    return await buildAppSnapshot(c, input.sessionId);
  },

  async updateAppOrganizationProfile(
    c: any,
    input: { sessionId: string; organizationId: string } & UpdateFoundryOrganizationProfileInput,
  ): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const organization = await getOrCreateOrganization(c, input.organizationId);
    await organization.updateShellProfile({
      displayName: input.displayName,
      slug: input.slug,
      primaryDomain: input.primaryDomain,
    });
    return await buildAppSnapshot(c, input.sessionId);
  },

  async getOrganizationShellState(c: any): Promise<any> {
    assertOrganizationShell(c);
    return await buildOrganizationState(c);
  },

  async getOrganizationShellStateIfInitialized(c: any): Promise<any | null> {
    assertOrganizationShell(c);
    return await buildOrganizationStateIfInitialized(c);
  },
};
