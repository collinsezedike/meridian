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
