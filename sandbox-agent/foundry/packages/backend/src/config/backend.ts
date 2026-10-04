import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import * as toml from "@iarna/toml";
import { ConfigSchema, type AppConfig } from "@sandbox-agent/foundry-shared";

export const CONFIG_PATH = `${homedir()}/.config/foundry/config.toml`;

export function loadConfig(path = CONFIG_PATH): AppConfig {
  if (!existsSync(path)) {
    return ConfigSchema.parse({});
  }

  const raw = readFileSync(path, "utf8");
  const parsed = toml.parse(raw) as unknown;
  return ConfigSchema.parse(parsed);
}

export function saveConfig(config: AppConfig, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toml.stringify(config), "utf8");
}
