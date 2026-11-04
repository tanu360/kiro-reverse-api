import { setupWorker } from "msw/browser";
import { mockDb, resetMockDb } from "./db";
import { allHandlers } from "./handlers";
import { resolveMockScenario } from "./scenario";

/**
 * Starts the MSW service worker in mock mode. Only main.tsx loads this, through a dynamic
 * import behind VITE_MOCK, so MSW never reaches the production bundle.
 */
export async function startMockWorker(): Promise<void> {
  // The browser serves the large dataset unless ?mock= or storage picks another (scenario.ts).
  const scenario = resolveMockScenario();
  const started = performance.now();
  resetMockDb(scenario);
  const ms = Math.round(performance.now() - started);
  console.info(
    `[mock] ${scenario} dataset in ${ms} ms: ${mockDb.accounts.length} accounts, ` +
      `${mockDb.requests.length} requests, ${mockDb.apiKeys.length} API keys, ` +
      `${mockDb.backups.length} backups. Switch with ?mock=full|small|empty.`,
  );
  const worker = setupWorker(...allHandlers);
  await worker.start({
    serviceWorker: { url: "/admin/mockServiceWorker.js", options: { scope: "/admin/" } },
    // MSW 3 renamed onUnhandledRequest to onUnhandledFrame.
    onUnhandledFrame: "bypass",
    quiet: true,
  });
}
