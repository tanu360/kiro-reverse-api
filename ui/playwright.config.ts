import { defineConfig, devices } from "@playwright/test";

// A dedicated port, and never an already running server: a dev server left on the default
// port by another checkout would otherwise answer the tests with that checkout's code.
const PORT = Number(process.env.E2E_PORT ?? 6391);
const origin = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  use: {
    baseURL: `${origin}/admin/`,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm dev:mock --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `${origin}/admin/`,
    reuseExistingServer: false,
  },
});
