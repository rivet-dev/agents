import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BaseProvider } from "baseui";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Client as Styletron } from "styletron-engine-atomic";
import { Provider as StyletronProvider } from "styletron-react";
import { router } from "./app/router";
import { ColorModeCtx, darkTheme, getStoredColorMode, lightTheme, storeColorMode, type ColorMode } from "./app/theme";
import { applyCssTokens, getFoundryTokens } from "./styles/tokens";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const styletronEngine = new Styletron();

function App() {
  const [colorMode, setColorModeState] = useState<ColorMode>(getStoredColorMode);

  const colorModeCtx = useMemo(
    () => ({
      colorMode,
      setColorMode: (mode: ColorMode) => {
        storeColorMode(mode);
        setColorModeState(mode);
      },
    }),
    [colorMode],
  );

  const theme = colorMode === "dark" ? darkTheme : lightTheme;
  const tokens = getFoundryTokens(theme);

  // Sync CSS custom properties and root element styles with color mode
  useEffect(() => {
    applyCssTokens(tokens);
    document.documentElement.style.colorScheme = colorMode;
    document.documentElement.style.background = tokens.surfacePrimary;
    document.documentElement.style.color = tokens.textPrimary;
    document.body.style.background = tokens.surfacePrimary;
    document.body.style.color = tokens.textPrimary;
  }, [colorMode, tokens]);

  return (
    <ColorModeCtx.Provider value={colorModeCtx}>
      <StyletronProvider value={styletronEngine}>
        <BaseProvider theme={theme}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </BaseProvider>
      </StyletronProvider>
    </ColorModeCtx.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
