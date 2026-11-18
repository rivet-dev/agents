import { createContext, useContext } from "react";
import { createDarkTheme, createLightTheme, type Theme } from "baseui";
import { useStyletron } from "baseui";
import { getFoundryTokens, type FoundryTokens } from "../styles/tokens";

const STORAGE_KEY = "sandbox-agent-foundry:color-mode";

export type ColorMode = "dark" | "light";

export const darkTheme: Theme = createDarkTheme({
  colors: {
    primary: "#e4e4e7", // zinc-200
    accent: "#ff4f00", // orange accent (inspector)
    backgroundPrimary: "#09090b", // darkest — chat center panel
    backgroundSecondary: "#0f0f11", // slightly lighter — sidebars
    backgroundTertiary: "#0c0c0e", // center + right panel headers
    backgroundInversePrimary: "#fafafa",
    contentPrimary: "#ffffff", // white (inspector --text)
    contentSecondary: "#a1a1aa", // zinc-400 (inspector --muted)
    contentTertiary: "#71717a", // zinc-500
    contentInversePrimary: "#000000",
    borderOpaque: "rgba(255, 255, 255, 0.10)", // inspector --border
    borderTransparent: "rgba(255, 255, 255, 0.07)", // inspector --border-2
  },
});

export const lightTheme: Theme = createLightTheme({
  colors: {
    primary: "#27272a", // zinc-800
    accent: "#ff4f00", // orange accent (inspector)
    backgroundPrimary: "#ffffff",
    backgroundSecondary: "#f4f4f5", // zinc-100
    backgroundTertiary: "#fafafa", // zinc-50
    backgroundInversePrimary: "#18181b",
    contentPrimary: "#09090b", // zinc-950
    contentSecondary: "#52525b", // zinc-600
    contentTertiary: "#a1a1aa", // zinc-400
    contentInversePrimary: "#ffffff",
    borderOpaque: "rgba(0, 0, 0, 0.10)",
    borderTransparent: "rgba(0, 0, 0, 0.06)",
  },
});

/** Kept for backwards compat — defaults to dark */
export const appTheme = darkTheme;

export interface ColorModeContext {
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
}

export const ColorModeCtx = createContext<ColorModeContext>({
  colorMode: "dark",
  setColorMode: () => {},
});

export function useColorMode() {
  return useContext(ColorModeCtx);
}

export function useFoundryTokens(): FoundryTokens {
  const [, theme] = useStyletron();
  return getFoundryTokens(theme);
}

export function getStoredColorMode(): ColorMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // ignore
  }
  return "dark";
}

export function storeColorMode(mode: ColorMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}
