/// <reference types="vitest/config" />
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

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

// Old /admin/... page URLs (bookmarks from before the UI moved to the root) land on the same page
// at the root, as the Go server does (redirectLegacyAdminPath in proxy/admin_ui.go). The admin API
// keeps /admin/api/. A 302, not the server's 301, so a browser never caches a dev redirect.
function redirectLegacyAdminPages(): Plugin {
  return {
    name: "kiro:redirect-legacy-admin-pages",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const queryAt = url.indexOf("?");
        const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
        const legacy =
          pathname === "/admin" ||
          (pathname.startsWith("/admin/") && !pathname.startsWith("/admin/api/"));
        if (!legacy || (req.method !== "GET" && req.method !== "HEAD")) {
          next();
          return;
        }
        // Leading slashes and backslashes go, so the target never points at another host.
        const rest = pathname.slice("/admin".length).replace(/^[/\\]+/, "");
        res.statusCode = 302;
        res.setHeader("Location", `/${rest}${queryAt === -1 ? "" : url.slice(queryAt)}`);
        res.end();
      });
    },
  };
}

// Mock mode registers MSW's service worker at the root scope. Serve the worker straight
// from node_modules in dev so it is never copied into public/ or shipped in dist/.
function serveMockWorker(): Plugin {
  const workerPath = path.resolve(rootDir, "node_modules/msw/lib/mockServiceWorker.js");
  return {
    name: "kiro:serve-mock-worker",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        // A missing/restarting MSW client must never send mock tokens to the real backend.
        if (pathname.startsWith("/admin/api/")) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          // The page re-announces itself to a restarted worker on this (src/lib/mocks/worker-recovery.ts).
          res.setHeader("X-Kiro-Mock-Unhandled", "1");
          res.end(
            JSON.stringify({
              error: "Mock worker is not handling this request. Reload the preview.",
            }),
          );
          return;
        }
        if (req.method !== "GET" || pathname !== "/mockServiceWorker.js") {
          next();
          return;
        }
        try {
          const body = await readFile(workerPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Service-Worker-Allowed", "/");
          res.setHeader("Cache-Control", "no-store");
          res.end(body);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const isMock = loadEnv(mode, rootDir, "VITE_").VITE_MOCK === "1";
  return {
    // Simultaneous mock/live servers must not overwrite each other's optimized dependencies.
    cacheDir: path.resolve(rootDir, `node_modules/.vite-${isMock ? "mock" : "live"}`),
    base: "/",
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
      redirectLegacyAdminPages(),
      ...(isMock ? [serveMockWorker()] : []),
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
      proxy: isMock
        ? undefined
        : {
            // Regex key: only the admin API under /admin/api/, never a page path.
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
  };
});
