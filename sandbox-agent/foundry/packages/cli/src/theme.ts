import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cwd } from "node:process";
import * as toml from "@iarna/toml";
import type { AppConfig } from "@sandbox-agent/foundry-shared";
import opencodeThemePackJson from "./themes/opencode-pack.json" with { type: "json" };

export type ThemeMode = "dark" | "light";

export interface TuiTheme {
  background: string;
  text: string;
  muted: string;
  header: string;
  status: string;
  highlightBg: string;
  highlightFg: string;
  selectionBorder: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  diffAdd: string;
  diffDel: string;
  diffSep: string;
  agentRunning: string;
  agentIdle: string;
  agentNone: string;
  agentError: string;
  prUnpushed: string;
  author: string;
  ciRunning: string;
  ciPass: string;
  ciFail: string;
  ciNone: string;
  reviewApproved: string;
  reviewChanges: string;
  reviewPending: string;
  reviewNone: string;
}

export interface TuiThemeResolution {
  theme: TuiTheme;
  name: string;
  source: string;
  mode: ThemeMode;
}

interface ThemeCandidate {
  theme: TuiTheme;
  name: string;
}

type JsonObject = Record<string, unknown>;

type ConfigLike = AppConfig & { theme?: string };

const DEFAULT_THEME: TuiTheme = {
  background: "#282828",
  text: "#ffffff",
  muted: "#6b7280",
  header: "#6b7280",
  status: "#6b7280",
  highlightBg: "#282828",
  highlightFg: "#ffffff",
  selectionBorder: "#d946ef",
  success: "#22c55e",
  warning: "#eab308",
  error: "#ef4444",
  info: "#22d3ee",
  diffAdd: "#22c55e",
  diffDel: "#ef4444",
  diffSep: "#6b7280",
  agentRunning: "#22c55e",
  agentIdle: "#eab308",
  agentNone: "#6b7280",
  agentError: "#ef4444",
  prUnpushed: "#eab308",
  author: "#22d3ee",
  ciRunning: "#eab308",
  ciPass: "#22c55e",
  ciFail: "#ef4444",
  ciNone: "#6b7280",
  reviewApproved: "#22c55e",
  reviewChanges: "#ef4444",
  reviewPending: "#eab308",
  reviewNone: "#6b7280",
};

const OPENCODE_THEME_PACK = opencodeThemePackJson as Record<string, unknown>;

export function resolveTuiTheme(config: AppConfig, baseDir = cwd()): TuiThemeResolution {
  const mode = opencodeStateThemeMode() ?? "dark";
  const configWithTheme = config as ConfigLike;
  const override = typeof configWithTheme.theme === "string" ? configWithTheme.theme.trim() : "";

  if (override) {
    const candidate = loadFromSpec(override, [], mode, baseDir);
    if (candidate) {
      return {
        theme: candidate.theme,
        name: candidate.name,
        source: "foundry config",
        mode,
      };
    }
  }

  const fromConfig = loadOpencodeThemeFromConfig(mode, baseDir);
  if (fromConfig) {
    return fromConfig;
  }

  const fromState = loadOpencodeThemeFromState(mode, baseDir);
  if (fromState) {
    return fromState;
  }

  return {
    theme: DEFAULT_THEME,
    name: "opencode-default",
    source: "default",
    mode,
  };
}

function loadOpencodeThemeFromConfig(mode: ThemeMode, baseDir: string): TuiThemeResolution | null {
  for (const path of opencodeConfigPaths(baseDir)) {
    if (!existsSync(path)) {
      continue;
    }

    const value = readJsonWithComments(path);
    if (!value) {
      continue;
    }

    const themeValue = findOpencodeThemeValue(value);
    if (themeValue === undefined) {
      continue;
    }

    const candidate = themeFromOpencodeValue(themeValue, opencodeThemeDirs(dirname(path), baseDir), mode, baseDir);
    if (!candidate) {
      continue;
    }

    return {
      theme: candidate.theme,
      name: candidate.name,
      source: `opencode config (${path})`,
      mode,
    };
  }

  return null;
}

function loadOpencodeThemeFromState(mode: ThemeMode, baseDir: string): TuiThemeResolution | null {
  const path = opencodeStatePath();
  if (!path || !existsSync(path)) {
    return null;
  }

  const value = readJsonWithComments(path);
  if (!isObject(value)) {
    return null;
  }

  const spec = value.theme;
  if (typeof spec !== "string" || !spec.trim()) {
    return null;
  }

  const candidate = loadFromSpec(spec.trim(), opencodeThemeDirs(undefined, baseDir), mode, baseDir);
  if (!candidate) {
    return null;
  }

  return {
    theme: candidate.theme,
    name: candidate.name,
    source: `opencode state (${path})`,
    mode,
  };
}

function loadFromSpec(spec: string, searchDirs: string[], mode: ThemeMode, baseDir: string): ThemeCandidate | null {
  if (isDefaultThemeName(spec)) {
    return {
      theme: DEFAULT_THEME,
      name: "opencode-default",
    };
  }

  if (isPathLike(spec)) {
    const resolved = resolvePath(spec, baseDir);
    if (existsSync(resolved)) {
      const candidate = loadThemeFromPath(resolved, mode);
      if (candidate) {
        return candidate;
      }
    }
  }

  for (const dir of searchDirs) {
    for (const ext of ["json", "toml"]) {
      const path = join(dir, `${spec}.${ext}`);
      if (!existsSync(path)) {
        continue;
      }

      const candidate = loadThemeFromPath(path, mode);
      if (candidate) {
        return candidate;
      }
    }
  }

  const builtIn = OPENCODE_THEME_PACK[spec];
  if (builtIn !== undefined) {
    const theme = themeFromOpencodeJson(builtIn, mode);
    if (theme) {
      return {
        theme,
        name: spec,
      };
    }
  }

  return null;
}

function loadThemeFromPath(path: string, mode: ThemeMode): ThemeCandidate | null {
  const content = safeReadText(path);
  if (!content) {
    return null;
  }

  const lower = path.toLowerCase();
  if (lower.endsWith(".toml")) {
    try {
      const parsed = toml.parse(content);
      const theme = themeFromAny(parsed);
      if (!theme) {
        return null;
      }
      return {
        theme,
        name: themeNameFromPath(path),
      };
    } catch {
      return null;
    }
  }

  const value = parseJsonWithComments(content);
  if (!value) {
    return null;
  }

  const opencodeTheme = themeFromOpencodeJson(value, mode);
  if (opencodeTheme) {
    return {
      theme: opencodeTheme,
      name: themeNameFromPath(path),
    };
  }

  const paletteTheme = themeFromAny(value);
  if (!paletteTheme) {
    return null;
  }

  return {
    theme: paletteTheme,
    name: themeNameFromPath(path),
  };
}

function themeNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  if (base.endsWith(".json") || base.endsWith(".toml")) {
    return base.replace(/\.(json|toml)$/i, "");
  }
  return base;
}

function themeFromOpencodeValue(value: unknown, searchDirs: string[], mode: ThemeMode, baseDir: string): ThemeCandidate | null {
  if (typeof value === "string") {
    return loadFromSpec(value, searchDirs, mode, baseDir);
  }

  if (!isObject(value)) {
    return null;
  }

  if (value.theme !== undefined) {
    const theme = themeFromOpencodeJson(value, mode);
    if (theme) {
      return {
        theme,
        name: typeof value.name === "string" ? value.name : "inline",
      };
    }
  }

  const paletteTheme = themeFromAny(value.colors ?? value.palette ?? value);
  if (paletteTheme) {
    return {
      theme: paletteTheme,
      name: typeof value.name === "string" ? value.name : "inline",
    };
  }

  if (typeof value.name === "string") {
    const named = loadFromSpec(value.name, searchDirs, mode, baseDir);
    if (named) {
      return named;
    }
  }

  const pathLike = value.path ?? value.file;
  if (typeof pathLike === "string") {
    const resolved = resolvePath(pathLike, baseDir);
    const candidate = loadThemeFromPath(resolved, mode);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function themeFromOpencodeJson(value: unknown, mode: ThemeMode): TuiTheme | null {
  if (!isObject(value)) {
    return null;
  }

  const themeMap = value.theme;
  if (!isObject(themeMap)) {
    return null;
  }

  const defs = isObject(value.defs) ? value.defs : {};

  const background =
    opencodeColor(themeMap, defs, mode, "background") ??
    opencodeColor(themeMap, defs, mode, "backgroundPanel") ??
    opencodeColor(themeMap, defs, mode, "backgroundElement") ??
    DEFAULT_THEME.background;

  const text = opencodeColor(themeMap, defs, mode, "text") ?? DEFAULT_THEME.text;
  const muted = opencodeColor(themeMap, defs, mode, "textMuted") ?? DEFAULT_THEME.muted;
  const highlightBg = opencodeColor(themeMap, defs, mode, "text") ?? text;
  const highlightFg =
    opencodeColor(themeMap, defs, mode, "backgroundElement") ??
    opencodeColor(themeMap, defs, mode, "backgroundPanel") ??
    opencodeColor(themeMap, defs, mode, "background") ??
    DEFAULT_THEME.highlightFg;

  const selectionBorder =
    opencodeColor(themeMap, defs, mode, "secondary") ??
    opencodeColor(themeMap, defs, mode, "accent") ??
    opencodeColor(themeMap, defs, mode, "primary") ??
    DEFAULT_THEME.selectionBorder;

  const success = opencodeColor(themeMap, defs, mode, "success") ?? DEFAULT_THEME.success;
  const warning = opencodeColor(themeMap, defs, mode, "warning") ?? DEFAULT_THEME.warning;
  const error = opencodeColor(themeMap, defs, mode, "error") ?? DEFAULT_THEME.error;
  const info = opencodeColor(themeMap, defs, mode, "info") ?? DEFAULT_THEME.info;
  const diffAdd = opencodeColor(themeMap, defs, mode, "diffAdded") ?? success;
  const diffDel = opencodeColor(themeMap, defs, mode, "diffRemoved") ?? error;
  const diffSep = opencodeColor(themeMap, defs, mode, "diffContext") ?? opencodeColor(themeMap, defs, mode, "diffHunkHeader") ?? muted;

  return {
    background,
    text,
    muted,
    header: muted,
    status: muted,
    highlightBg,
    highlightFg,
    selectionBorder,
    success,
    warning,
    error,
    info,
    diffAdd,
    diffDel,
    diffSep,
    agentRunning: success,
    agentIdle: warning,
    agentNone: muted,
    agentError: error,
    prUnpushed: warning,
    author: info,
    ciRunning: warning,
    ciPass: success,
    ciFail: error,
    ciNone: muted,
    reviewApproved: success,
    reviewChanges: error,
    reviewPending: warning,
    reviewNone: muted,
  };
}

function opencodeColor(themeMap: JsonObject, defs: JsonObject, mode: ThemeMode, key: string): string | null {
  const raw = themeMap[key];
  if (raw === undefined) {
    return null;
  }
  return resolveOpencodeColor(raw, themeMap, defs, mode, 0);
}

function resolveOpencodeColor(value: unknown, themeMap: JsonObject, defs: JsonObject, mode: ThemeMode, depth: number): string | null {
  if (depth > 12) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "transparent" || trimmed.toLowerCase() === "none") {
      return null;
    }

    const fromDefs = defs[trimmed];
    if (fromDefs !== undefined) {
      return resolveOpencodeColor(fromDefs, themeMap, defs, mode, depth + 1);
    }

    const fromTheme = themeMap[trimmed];
    if (fromTheme !== undefined) {
      return resolveOpencodeColor(fromTheme, themeMap, defs, mode, depth + 1);
    }

    if (isColorLike(trimmed)) {
      return trimmed;
    }

    return null;
  }

  if (isObject(value)) {
    const nested = value[mode];
    if (nested !== undefined) {
      return resolveOpencodeColor(nested, themeMap, defs, mode, depth + 1);
    }
  }

  return null;
}

function themeFromAny(value: unknown): TuiTheme | null {
  const palette = extractPalette(value);
  if (!palette) {
    return null;
  }

  const pick = (keys: string[], fallback: string): string => {
    for (const key of keys) {
      const v = palette[normalizeKey(key)];
      if (v && isColorLike(v)) {
        return v;
      }
    }
    return fallback;
  };

  const background = pick(["background", "bg", "base", "background_color"], DEFAULT_THEME.background);
  const text = pick(["text", "foreground", "fg", "primary"], DEFAULT_THEME.text);
  const muted = pick(["muted", "subtle", "secondary", "dim"], DEFAULT_THEME.muted);
  const header = pick(["header", "header_text"], muted);
  const status = pick(["status", "status_text"], muted);
  const highlightBg = pick(["highlight_bg", "selection", "highlight", "accent_bg"], DEFAULT_THEME.highlightBg);
  const highlightFg = pick(["highlight_fg", "selection_fg", "accent_fg"], text);
  const selectionBorder = pick(["selection_border", "highlight_border", "accent", "secondary"], DEFAULT_THEME.selectionBorder);
  const success = pick(["success", "green"], DEFAULT_THEME.success);
  const warning = pick(["warning", "yellow"], DEFAULT_THEME.warning);
  const error = pick(["error", "red"], DEFAULT_THEME.error);
  const info = pick(["info", "cyan", "blue"], DEFAULT_THEME.info);
  const diffAdd = pick(["diff_add", "diff_addition", "add"], success);
  const diffDel = pick(["diff_del", "diff_deletion", "delete"], error);
  const diffSep = pick(["diff_sep", "diff_separator", "separator"], muted);

  return {
    background,
    text,
    muted,
    header,
    status,
    highlightBg,
    highlightFg,
    selectionBorder,
    success,
    warning,
    error,
    info,
    diffAdd,
    diffDel,
    diffSep,
    agentRunning: pick(["agent_running", "running"], success),
    agentIdle: pick(["agent_idle", "idle"], warning),
    agentNone: pick(["agent_none", "none"], muted),
    agentError: pick(["agent_error", "agent_failed"], error),
    prUnpushed: pick(["pr_unpushed", "unpushed"], warning),
    author: pick(["author"], info),
    ciRunning: pick(["ci_running"], warning),
    ciPass: pick(["ci_pass", "ci_success"], success),
    ciFail: pick(["ci_fail", "ci_error"], error),
    ciNone: pick(["ci_none", "ci_unknown"], muted),
    reviewApproved: pick(["review_approved", "approved"], success),
    reviewChanges: pick(["review_changes", "changes"], error),
    reviewPending: pick(["review_pending", "pending"], warning),
    reviewNone: pick(["review_none", "review_unknown"], muted),
  };
}

function extractPalette(value: unknown): Record<string, string> | null {
  if (!isObject(value)) {
    return null;
  }

  const colors = isObject(value.colors) ? value.colors : undefined;
  const palette = isObject(value.palette) ? value.palette : undefined;
  const source = colors ?? palette ?? value;
  if (!isObject(source)) {
    return null;
  }

  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw !== "string") {
      continue;
    }
    out[normalizeKey(key)] = raw;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\-\s.]/g, "_");
}

function isColorLike(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) {
    return false;
  }

  if (/^#[0-9a-f]{3}$/.test(lower) || /^#[0-9a-f]{6}$/.test(lower) || /^#[0-9a-f]{8}$/.test(lower)) {
    return true;
  }

  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(\s*,\s*[\d.]+)?\s*\)$/.test(lower)) {
    return true;
  }

  return /^[a-z_\-]+$/.test(lower);
}

function findOpencodeThemeValue(value: unknown): unknown {
  if (!isObject(value)) {
    return undefined;
  }

  if (value.theme !== undefined) {
    return value.theme;
  }

  return pointer(value, ["ui", "theme"]) ?? pointer(value, ["tui", "theme"]) ?? pointer(value, ["options", "theme"]);
}

function pointer(obj: JsonObject, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function opencodeConfigPaths(baseDir: string): string[] {
  const paths: string[] = [];

  const rootish = opencodeRepositoryConfigPaths(baseDir);
  paths.push(...rootish);

  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const opencodeDir = join(configDir, "opencode");
  paths.push(join(opencodeDir, "opencode.json"));
  paths.push(join(opencodeDir, "opencode.jsonc"));
  paths.push(join(opencodeDir, "config.json"));

  return paths;
}

function opencodeThemeDirs(configDir: string | undefined, baseDir: string): string[] {
  const dirs: string[] = [];

  if (configDir) {
    dirs.push(join(configDir, "themes"));
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  dirs.push(join(xdgConfig, "opencode", "themes"));
  dirs.push(join(homedir(), ".opencode", "themes"));

  dirs.push(...opencodeRepositoryThemeDirs(baseDir));

  return dirs;
}

function opencodeRepositoryConfigPaths(baseDir: string): string[] {
  const dirs = ancestorDirs(baseDir);
  const out: string[] = [];
  for (const dir of dirs) {
    out.push(join(dir, "opencode.json"));
    out.push(join(dir, "opencode.jsonc"));
    out.push(join(dir, ".opencode", "opencode.json"));
    out.push(join(dir, ".opencode", "opencode.jsonc"));
  }
  return out;
}

function opencodeRepositoryThemeDirs(baseDir: string): string[] {
  const dirs = ancestorDirs(baseDir);
  const out: string[] = [];
  for (const dir of dirs) {
    out.push(join(dir, ".opencode", "themes"));
  }
  return out;
}

function ancestorDirs(start: string): string[] {
  const out: string[] = [];
  let current = resolve(start);

  while (true) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return out;
}

function opencodeStatePath(): string | null {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "opencode", "kv.json");
}

function opencodeStateThemeMode(): ThemeMode | null {
  const path = opencodeStatePath();
  if (!path || !existsSync(path)) {
    return null;
  }

  const value = readJsonWithComments(path);
  if (!isObject(value)) {
    return null;
  }

  const mode = value.theme_mode;
  if (typeof mode !== "string") {
    return null;
  }

  const lower = mode.toLowerCase();
  if (lower === "dark" || lower === "light") {
    return lower;
  }

  return null;
}

function parseJsonWithComments(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Fall through.
  }

  try {
    return JSON.parse(stripJsoncComments(content));
  } catch {
    return null;
  }
}

function readJsonWithComments(path: string): unknown {
  const content = safeReadText(path);
  if (!content) {
    return null;
  }
  return parseJsonWithComments(content);
}

function stripJsoncComments(input: string): string {
  let output = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      output += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length) {
        if (input[i] === "*" && input[i + 1] === "/") {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }

    output += ch;
    i += 1;
  }

  return output;
}

function safeReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function resolvePath(path: string, baseDir: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) {
    return path;
  }
  return resolve(baseDir, path);
}

function isPathLike(spec: string): boolean {
  return spec.includes("/") || spec.includes("\\") || spec.endsWith(".json") || spec.endsWith(".toml");
}

function isDefaultThemeName(spec: string): boolean {
  const lower = spec.toLowerCase();
  return lower === "default" || lower === "opencode" || lower === "opencode-default" || lower === "system";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
