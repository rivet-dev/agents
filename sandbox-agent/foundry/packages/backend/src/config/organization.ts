import type { AppConfig } from "@sandbox-agent/foundry-shared";

export function defaultOrganization(config: AppConfig): string {
  const organizationId = config.organization.default.trim();
  return organizationId.length > 0 ? organizationId : "default";
}

export function resolveOrganization(flagOrganization: string | undefined, config: AppConfig): string {
  if (flagOrganization && flagOrganization.trim().length > 0) {
    return flagOrganization.trim();
  }
  return defaultOrganization(config);
}
