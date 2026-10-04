import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

const backendProxyTarget = process.env.HF_BACKEND_HTTP?.trim() || "http://127.0.0.1:7741";
const cacheDir = process.env.HF_VITE_CACHE_DIR?.trim() || undefined;
export default defineConfig({
  define: {
    "import.meta.env.FOUNDRY_FRONTEND_CLIENT_MODE": JSON.stringify(process.env.FOUNDRY_FRONTEND_CLIENT_MODE?.trim() || "remote"),
  },
  plugins: [react()],
  cacheDir,
  resolve: {
    alias: {
      "@sandbox-agent/react": resolve(__dirname, "../../../sdks/react/dist/index.js"),
    },
  },
  server: {
    port: 4173,
    proxy: {
      "/v1": {
        target: backendProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
});
