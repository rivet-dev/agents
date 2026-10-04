import { getOrCreateOrganization } from "../actors/handles.js";
import { APP_SHELL_ORGANIZATION_ID } from "../actors/organization/constants.js";

export interface ResolvedGithubAuth {
  githubToken: string;
  scopes: string[];
}

export async function resolveOrganizationGithubAuth(c: any, organizationId: string): Promise<ResolvedGithubAuth | null> {
  if (!organizationId || organizationId === APP_SHELL_ORGANIZATION_ID) {
    return null;
  }

  try {
    const appOrganization = await getOrCreateOrganization(c, APP_SHELL_ORGANIZATION_ID);
    const resolved = await appOrganization.resolveAppGithubToken({
      organizationId: organizationId,
      requireRepoScope: true,
    });
    if (!resolved?.accessToken) {
      return null;
    }
    return {
      githubToken: resolved.accessToken,
      scopes: Array.isArray(resolved.scopes) ? resolved.scopes : [],
    };
  } catch {
    return null;
  }
}
