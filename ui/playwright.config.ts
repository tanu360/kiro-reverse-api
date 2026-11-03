import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:5173/admin/",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev:mock",
    url: "http://127.0.0.1:5173/admin/",
    reuseExistingServer: true,
  },
});
