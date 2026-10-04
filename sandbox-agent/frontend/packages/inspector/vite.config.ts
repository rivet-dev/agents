import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/ui/" : "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: process.env.SANDBOX_AGENT_URL || "http://localhost:2468",
        changeOrigin: true,
        ws: true,
      },
    },
  },
}));
