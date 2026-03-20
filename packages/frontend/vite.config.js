import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function isNodeModule(id, packageName) {
  return id.includes(`/node_modules/${packageName}/`);
}
export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (!normalizedId.includes("/node_modules/")) {
            return;
          }
          if (
            isNodeModule(normalizedId, "react") ||
            isNodeModule(normalizedId, "react-dom") ||
            isNodeModule(normalizedId, "scheduler")
          ) {
            return "vendor-react";
          }
          if (
            isNodeModule(normalizedId, "react-router") ||
            isNodeModule(normalizedId, "react-router-dom")
          ) {
            return "vendor-router";
          }
          if (
            isNodeModule(normalizedId, "@reduxjs/toolkit") ||
            isNodeModule(normalizedId, "react-redux") ||
            isNodeModule(normalizedId, "redux") ||
            isNodeModule(normalizedId, "reselect") ||
            isNodeModule(normalizedId, "immer")
          ) {
            return "vendor-state";
          }
          if (
            isNodeModule(normalizedId, "@tanstack/react-query") ||
            isNodeModule(normalizedId, "@tanstack/query-core") ||
            isNodeModule(normalizedId, "@tanstack/react-virtual") ||
            isNodeModule(normalizedId, "@tanstack/virtual-core")
          ) {
            return "vendor-tanstack";
          }
          if (
            isNodeModule(normalizedId, "react-markdown") ||
            isNodeModule(normalizedId, "remark-gfm") ||
            isNodeModule(normalizedId, "remark-parse") ||
            isNodeModule(normalizedId, "remark-rehype") ||
            isNodeModule(normalizedId, "unified") ||
            isNodeModule(normalizedId, "marked") ||
            isNodeModule(normalizedId, "turndown") ||
            normalizedId.includes("/node_modules/remark-") ||
            normalizedId.includes("/node_modules/rehype-") ||
            normalizedId.includes("/node_modules/micromark") ||
            normalizedId.includes("/node_modules/mdast-") ||
            normalizedId.includes("/node_modules/hast-") ||
            normalizedId.includes("/node_modules/unist-") ||
            normalizedId.includes("/node_modules/vfile") ||
            normalizedId.includes("/node_modules/property-information/") ||
            normalizedId.includes("/node_modules/space-separated-tokens/") ||
            normalizedId.includes("/node_modules/comma-separated-tokens/") ||
            normalizedId.includes("/node_modules/decode-named-character-reference/") ||
            normalizedId.includes("/node_modules/character-entities") ||
            normalizedId.includes("/node_modules/markdown-table/") ||
            normalizedId.includes("/node_modules/trim-lines/") ||
            normalizedId.includes("/node_modules/ccount/") ||
            normalizedId.includes("/node_modules/devlop/")
          ) {
            return "vendor-markdown";
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@opensprint/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3100",
        ws: true,
      },
    },
  },
});
