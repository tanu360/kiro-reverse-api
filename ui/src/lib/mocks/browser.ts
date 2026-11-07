import { setupWorker } from "msw/browser";
import { mockDb, resetMockDb } from "./db";
import { allHandlers } from "./handlers";
import { resolveMockScenario } from "./scenario";
import { installWorkerRecovery } from "./worker-recovery";

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
  installWorkerRecovery();
  reloadIfUncontrolled();
}

const RELOAD_KEY = "kiro_mock_worker_reload";

/**
 * A hard reload (Cmd/Ctrl+Shift+R, or DevTools' "Bypass for network") loads the page without its
 * service worker, so the mock worker is registered but never sees the page's requests: every
 * /admin/api call reaches the dev server, which answers 503 "Mock worker is not handling this
 * request". One plain reload hands the page back to the worker. The session flag stops a loop
 * when the worker cannot take control at all (Bypass for network left on).
 */
function reloadIfUncontrolled(): void {
  if (navigator.serviceWorker?.controller) {
    sessionStorage.removeItem(RELOAD_KEY);
    return;
  }
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  if (Date.now() - last < 10_000) {
    console.error(
      "[mock] The mock service worker does not control this page. Turn off DevTools > Application > Service workers > Bypass for network, then reload.",
    );
    return;
  }
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  location.reload();
}
