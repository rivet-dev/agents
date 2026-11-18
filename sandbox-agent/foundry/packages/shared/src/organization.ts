import type { AppConfig } from "./config.js";

export function resolveOrganizationId(flagOrganization: string | undefined, config: AppConfig): string {
  if (flagOrganization && flagOrganization.trim().length > 0) {
    return flagOrganization.trim();
  }

  if (config.organization.default.trim().length > 0) {
    return config.organization.default.trim();
  }

  return "default";
}
