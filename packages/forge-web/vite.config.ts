import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://127.0.0.1:4177";

const proxyPaths = ["/session", "/teams", "/invites", "/projects", "/health", "/home"] as const;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    strictPort: true,
    proxy: Object.fromEntries(
      proxyPaths.map((path) => [
        path,
        {
          target,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
          configure: (proxy) => {
            proxy.on("proxyRes", (proxyRes, req, res) => {
              if ((req.url ?? "").includes("/events")) {
                proxyRes.headers["cache-control"] = "no-cache";
                proxyRes.headers["x-accel-buffering"] = "no";
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("X-Accel-Buffering", "no");
              }
            });
          },
        },
      ])
    ),
  },
});
