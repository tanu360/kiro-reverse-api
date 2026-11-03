import { setupWorker } from "msw/browser";
import { allHandlers } from "./handlers";

/**
 * Starts the MSW service worker in mock mode. Only main.tsx loads this, through a dynamic
 * import behind VITE_MOCK, so MSW never reaches the production bundle.
 */
export async function startMockWorker(): Promise<void> {
  const worker = setupWorker(...allHandlers);
  await worker.start({
    serviceWorker: { url: "/admin/mockServiceWorker.js", options: { scope: "/admin/" } },
    // MSW 3 renamed onUnhandledRequest to onUnhandledFrame.
    onUnhandledFrame: "bypass",
    quiet: true,
  });
}
