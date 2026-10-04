import type { AppConfig } from "@sandbox-agent/foundry-shared";
import type { BackendDriver } from "../driver.js";
import type { NotificationService } from "../notifications/index.js";
import type { AppShellServices } from "../services/app-shell-runtime.js";

let runtimeConfig: AppConfig | null = null;
let notificationService: NotificationService | null = null;
let runtimeDriver: BackendDriver | null = null;
let appShellServices: AppShellServices | null = null;

export function initActorRuntimeContext(config: AppConfig, notifications?: NotificationService, driver?: BackendDriver, appShell?: AppShellServices): void {
  runtimeConfig = config;
  notificationService = notifications ?? null;
  runtimeDriver = driver ?? null;
  appShellServices = appShell ?? null;
}

export function getActorRuntimeContext(): {
  config: AppConfig;
  notifications: NotificationService | null;
  driver: BackendDriver;
  appShell: AppShellServices;
} {
  if (!runtimeConfig) {
    throw new Error("Actor runtime context not initialized");
  }

  if (!runtimeDriver) {
    throw new Error("Actor runtime context missing driver");
  }

  if (!appShellServices) {
    throw new Error("Actor runtime context missing app shell services");
  }

  return {
    config: runtimeConfig,
    notifications: notificationService,
    driver: runtimeDriver,
    appShell: appShellServices,
  };
}
