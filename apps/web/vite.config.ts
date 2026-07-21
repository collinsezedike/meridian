import { readFileSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serveLanding = {
  name: "serve-landing",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/" || req.url === "") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(readFileSync(resolve(__dirname, "../landing/index.html")));
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), serveLanding],
  base: "/app/",
  // packages/shared's dist/constants.ts reads process.env.STELLAR_NETWORK for
  // its Node-side (API) consumers. Vite's dev server serves that pre-built
  // file to the browser as-is (via @fs/) rather than replacing process.env
  // references the way a production `vite build` does, so `process` is
  // genuinely undefined at runtime and the app fails to boot. Defining it as
  // an empty object matches Node's own `undefined` lookup behavior for unset
  // vars (constants.ts already falls back to "testnet" in that case).
  define: {
    "process.env": "{}",
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/docs": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3000,
  },
});
