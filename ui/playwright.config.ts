import { defineConfig, devices } from "@playwright/test";

// A dedicated port, and never an already running server: a dev server left on the default
// port by another checkout would otherwise answer the tests with that checkout's code.
const PORT = Number(process.env.E2E_PORT ?? 6391);
const origin = `http://127.0.0.1:${PORT}`;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  // In CI, a stray test.only fails the run instead of skipping the rest of the suite, and the
  // github reporter annotates failures on the pull request.
  forbidOnly: CI,
  reporter: CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `${origin}/`,
    // The browser mock draws a random 8-digit first-run password, as the server does
    // (src/lib/mocks/db.ts); the specs pin the known one through the key it reads. They also pin
    // the small dataset (src/lib/mocks/scenario.ts): the dev server defaults to the full one.
    storageState: {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [
            { name: "kiro_mock_password", value: "12345678" },
            { name: "kiro_mock_scenario", value: "small" },
          ],
        },
      ],
    },
    // Kept only for failed tests; CI uploads test-results/ when the job fails.
    trace: "retain-on-failure",
    // Chrome for Testing 156 and 157 (headless, software compositing) crash their renderer
    // (SIGSEGV at 0, "Target crashed") when a sheet or menu closes while the Overview charts,
    // live tiles and status cards animate. The more of them run, the likelier it is; reduced
    // motion stops those animations (0 crashes in 24 repeats of the shell specs, against about
    // 1 in 4 without it).
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm dev:mock --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `${origin}/`,
    reuseExistingServer: false,
    // An empty value beats a VITE_MOCK_PASSWORD pinned in a local .env.mock.local, so the specs'
    // password above is the one the mock uses.
    env: { VITE_MOCK_PASSWORD: "" },
  },
});
