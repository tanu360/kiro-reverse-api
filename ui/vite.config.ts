/// <reference types="vitest/config" />
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const goTarget = "http://127.0.0.1:8080";

// The Go binary embeds ui/dist and needs a committed placeholder file to build before the UI
// exists. `emptyOutDir` wipes it on every build, so write it back once the bundle is closed.
function keepDistPlaceholder(): Plugin {
  return {
    name: "kiro:keep-dist-placeholder",
    apply: "build",
    async closeBundle() {
      const outDir = path.resolve(rootDir, "dist");
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, ".keep"), "");
    },
  };
}

// Mock mode registers MSW's service worker under the /admin/ scope. Serve the worker straight
// from node_modules in dev so it is never copied into public/ or shipped in dist/.
function serveMockWorker(): Plugin {
  const workerPath = path.resolve(rootDir, "node_modules/msw/lib/mockServiceWorker.js");
  return {
    name: "kiro:serve-mock-worker",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (req.method !== "GET" || pathname !== "/admin/mockServiceWorker.js") {
          next();
          return;
        }
        try {
          const body = await readFile(workerPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Service-Worker-Allowed", "/admin/");
          res.setHeader("Cache-Control", "no-store");
          res.end(body);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  base: "/admin/",
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "src/routes",
      generatedRouteTree: "src/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
    keepDistPlaceholder(),
    serveMockWorker(),
  ],
  resolve: {
    alias: { "@": path.resolve(rootDir, "src") },
  },
  optimizeDeps: {
    // Route chunks load lazily, so the dependency scan from index.html misses what only a page
    // imports (dnd-kit in Settings, for example). Vite would find those on first visit and
    // reload the page, which drops toasts and breaks e2e runs on a cold cache.
    entries: ["index.html", "src/{features,components,routes}/**/*.tsx", "!src/**/*.test.tsx"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Regex key: a plain '/admin/api' string would prefix-match the SPA page /admin/api.
      // Timeouts are off so the SSE stream at /admin/api/events is never cut or buffered.
      "^/admin/api/": { target: goTarget, proxyTimeout: 0, timeout: 0 },
      "/v1": { target: goTarget },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
