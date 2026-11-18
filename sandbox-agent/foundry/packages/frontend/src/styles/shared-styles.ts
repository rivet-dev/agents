import type { CSSProperties } from "react";
import type { FoundryTokens } from "./tokens";

const fontFamily = "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif";

export function appSurfaceStyle(t: FoundryTokens): CSSProperties {
  return {
    minHeight: "100dvh",
    display: "flex",
    flexDirection: "column",
    background: t.surfacePrimary,
    color: t.textPrimary,
    fontFamily,
  };
}

export function primaryButtonStyle(t: FoundryTokens): CSSProperties {
  return {
    border: 0,
    borderRadius: "6px",
    padding: "6px 12px",
    background: t.textPrimary,
    color: t.textOnPrimary,
    fontWeight: 500,
    fontSize: "12px",
    cursor: "pointer",
    fontFamily,
    lineHeight: 1.4,
  };
}

export function secondaryButtonStyle(t: FoundryTokens): CSSProperties {
  return {
    border: `1px solid ${t.borderDefault}`,
    borderRadius: "6px",
    padding: "5px 11px",
    background: t.interactiveSubtle,
    color: t.textSecondary,
    fontWeight: 500,
    fontSize: "12px",
    cursor: "pointer",
    fontFamily,
    lineHeight: 1.4,
  };
}

export function subtleButtonStyle(t: FoundryTokens): CSSProperties {
  return {
    border: 0,
    borderRadius: "6px",
    padding: "6px 10px",
    background: t.interactiveHover,
    color: t.textSecondary,
    fontWeight: 500,
    fontSize: "12px",
    cursor: "pointer",
    fontFamily,
    lineHeight: 1.4,
  };
}

export function cardStyle(t: FoundryTokens): CSSProperties {
  return {
    background: t.surfaceSecondary,
    border: `1px solid ${t.borderSubtle}`,
    borderRadius: "8px",
  };
}

export function badgeStyle(_t: FoundryTokens, background: string, color?: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 6px",
    borderRadius: "4px",
    background,
    color: color ?? _t.textSecondary,
    fontSize: "10px",
    fontWeight: 500,
  };
}

export function inputStyle(t: FoundryTokens): CSSProperties {
  return {
    width: "100%",
    borderRadius: "6px",
    border: `1px solid ${t.borderDefault}`,
    background: t.interactiveSubtle,
    color: t.textPrimary,
    padding: "6px 10px",
    fontSize: "12px",
    fontFamily,
    outline: "none",
    lineHeight: 1.5,
  };
}

export function settingsLabelStyle(t: FoundryTokens): CSSProperties {
  return {
    fontSize: "11px",
    fontWeight: 500,
    color: t.textTertiary,
  };
}
