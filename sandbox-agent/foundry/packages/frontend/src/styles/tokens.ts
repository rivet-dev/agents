import type { Theme } from "baseui";

/**
 * Semantic design tokens for the Foundry UI.
 *
 * These map visual intent to concrete color values and flip automatically
 * when the BaseUI theme switches between dark and light.
 */
export interface FoundryTokens {
  // ── Surfaces ──────────────────────────────────────────────────────────
  surfacePrimary: string;
  surfaceSecondary: string;
  surfaceTertiary: string;
  surfaceElevated: string;

  // ── Interactive overlays ──────────────────────────────────────────────
  interactiveHover: string;
  interactiveActive: string;
  interactiveSubtle: string;

  // ── Borders ───────────────────────────────────────────────────────────
  borderSubtle: string;
  borderDefault: string;
  borderMedium: string;
  borderFocus: string;

  // ── Text ──────────────────────────────────────────────────────────────
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textMuted: string;
  textOnAccent: string;
  textOnPrimary: string;

  // ── Accent ────────────────────────────────────────────────────────────
  accent: string;
  accentSubtle: string;

  // ── Status ────────────────────────────────────────────────────────────
  statusSuccess: string;
  statusError: string;
  statusWarning: string;

  // ── Misc ──────────────────────────────────────────────────────────────
  shadow: string;
}

const darkTokens: FoundryTokens = {
  surfacePrimary: "#09090b",
  surfaceSecondary: "#0f0f11",
  surfaceTertiary: "#0c0c0e",
  surfaceElevated: "#1a1a1d",

  interactiveHover: "rgba(255, 255, 255, 0.06)",
  interactiveActive: "rgba(255, 255, 255, 0.10)",
  interactiveSubtle: "rgba(255, 255, 255, 0.03)",

  borderSubtle: "rgba(255, 255, 255, 0.06)",
  borderDefault: "rgba(255, 255, 255, 0.10)",
  borderMedium: "rgba(255, 255, 255, 0.14)",
  borderFocus: "rgba(255, 255, 255, 0.30)",

  textPrimary: "#ffffff",
  textSecondary: "#a1a1aa",
  textTertiary: "#71717a",
  textMuted: "rgba(255, 255, 255, 0.40)",
  textOnAccent: "#ffffff",
  textOnPrimary: "#09090b",

  accent: "#ff4f00",
  accentSubtle: "rgba(255, 79, 0, 0.10)",

  statusSuccess: "#7ee787",
  statusError: "#ffa198",
  statusWarning: "#fbbf24",

  shadow: "0 4px 24px rgba(0, 0, 0, 0.5)",
};

const lightTokens: FoundryTokens = {
  surfacePrimary: "#ffffff",
  surfaceSecondary: "#f4f4f5",
  surfaceTertiary: "#fafafa",
  surfaceElevated: "#ffffff",

  interactiveHover: "rgba(0, 0, 0, 0.04)",
  interactiveActive: "rgba(0, 0, 0, 0.08)",
  interactiveSubtle: "rgba(0, 0, 0, 0.02)",

  borderSubtle: "rgba(0, 0, 0, 0.06)",
  borderDefault: "rgba(0, 0, 0, 0.10)",
  borderMedium: "rgba(0, 0, 0, 0.14)",
  borderFocus: "rgba(0, 0, 0, 0.25)",

  textPrimary: "#09090b",
  textSecondary: "#52525b",
  textTertiary: "#a1a1aa",
  textMuted: "rgba(0, 0, 0, 0.40)",
  textOnAccent: "#ffffff",
  textOnPrimary: "#ffffff",

  accent: "#ff4f00",
  accentSubtle: "rgba(255, 79, 0, 0.08)",

  statusSuccess: "#16a34a",
  statusError: "#dc2626",
  statusWarning: "#ca8a04",

  shadow: "0 4px 24px rgba(0, 0, 0, 0.08)",
};

/**
 * Resolve tokens from the active BaseUI theme.
 * Works inside `styled()` callbacks where `$theme` is available.
 */
export function getFoundryTokens(theme: Theme): FoundryTokens {
  // BaseUI dark themes have backgroundPrimary near black
  const isDark = (theme.colors.backgroundPrimary ?? "#09090b").startsWith("#0");
  return isDark ? darkTokens : lightTokens;
}

/**
 * Inject CSS custom properties onto :root so styles.css can reference tokens.
 */
export function applyCssTokens(tokens: FoundryTokens) {
  const root = document.documentElement;
  root.style.setProperty("--f-surface-primary", tokens.surfacePrimary);
  root.style.setProperty("--f-surface-secondary", tokens.surfaceSecondary);
  root.style.setProperty("--f-surface-tertiary", tokens.surfaceTertiary);
  root.style.setProperty("--f-text-primary", tokens.textPrimary);
  root.style.setProperty("--f-text-secondary", tokens.textSecondary);
  root.style.setProperty("--f-text-tertiary", tokens.textTertiary);
  root.style.setProperty("--f-text-muted", tokens.textMuted);
  root.style.setProperty("--f-border-subtle", tokens.borderSubtle);
  root.style.setProperty("--f-border-default", tokens.borderDefault);
  root.style.setProperty("--f-accent", tokens.accent);
  root.style.setProperty("--f-accent-subtle", tokens.accentSubtle);
  root.style.setProperty("--f-status-success", tokens.statusSuccess);
  root.style.setProperty("--f-status-error", tokens.statusError);
  root.style.setProperty("--f-interactive-hover", tokens.interactiveHover);
}
