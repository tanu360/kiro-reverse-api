/**
 * The dev server marks its 503 for an /admin/api request that no mock worker answered with this
 * header (serveMockWorker in vite.config.ts). The mock's own 503 responses never carry it.
 */
export const UNHANDLED_HEADER = "X-Kiro-Mock-Unhandled";

/** How long a restarted worker gets to confirm MOCK_ACTIVATE before the 503 stands. */
const ACTIVATE_TIMEOUT_MS = 3_000;

/**
 * Chrome stops an idle service worker after about 30 seconds. MSW's page sends a keepalive every
 * 5 seconds, but a background tab throttles that timer to once a minute, so the worker stops
 * anyway. The restarted worker has forgotten which pages turned mocking on, lets every
 * /admin/api request through to the dev server and gets its 503: Requests stays on its skeleton.
 * On that 503 this page announces itself to the worker again, the way MSW does at start, and
 * repeats the request once.
 */
export function installWorkerRecovery(target: { fetch: typeof fetch } = window): void {
  const nativeFetch = target.fetch.bind(target);
  let activating: Promise<boolean> | null = null;

  target.fetch = async (input, init) => {
    // A Request body can be read once, so keep a copy for the repeat.
    const repeat = input instanceof Request ? input.clone() : input;
    const response = await nativeFetch(input, init);
    if (response.status !== 503 || !response.headers.has(UNHANDLED_HEADER)) return response;
    activating ??= activateMocking().finally(() => {
      activating = null;
    });
    return (await activating) ? nativeFetch(repeat, init) : response;
  };
}

/** Sends MSW's MOCK_ACTIVATE to the controlling worker and waits for MOCKING_ENABLED. */
function activateMocking(): Promise<boolean> {
  const container = navigator.serviceWorker;
  const controller = container?.controller;
  if (!controller) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (enabled: boolean) => {
      clearTimeout(timer);
      container.removeEventListener("message", onMessage);
      resolve(enabled);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "MOCKING_ENABLED") finish(true);
    };
    const timer = setTimeout(() => finish(false), ACTIVATE_TIMEOUT_MS);
    container.addEventListener("message", onMessage);
    controller.postMessage("MOCK_ACTIVATE");
  });
}
