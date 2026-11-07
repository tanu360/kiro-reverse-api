import { afterEach, describe, expect, it, vi } from "vitest";
import { installWorkerRecovery, UNHANDLED_HEADER } from "./worker-recovery";

/** A stand-in for navigator.serviceWorker whose worker answers MOCK_ACTIVATE like MSW's. */
function fakeServiceWorker(options: { controller?: boolean; answers?: boolean } = {}) {
  const container = new EventTarget();
  const postMessage = vi.fn((message: unknown) => {
    if (message !== "MOCK_ACTIVATE" || options.answers === false) return;
    queueMicrotask(() =>
      container.dispatchEvent(
        new MessageEvent("message", { data: { type: "MOCKING_ENABLED", payload: {} } }),
      ),
    );
  });
  Object.assign(container, {
    controller: options.controller === false ? null : { postMessage },
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return { postMessage };
}

const unhandled = () => new Response("{}", { status: 503, headers: { [UNHANDLED_HEADER]: "1" } });
const ok = () => new Response('{"ok":true}', { status: 200 });

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.useRealTimers();
});

describe("installWorkerRecovery", () => {
  it("leaves every other response alone, including the mock's own 503s", async () => {
    const { postMessage } = fakeServiceWorker();
    const own503 = new Response("{}", { status: 503 });
    const native = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(own503);
    const target = { fetch: native as typeof fetch };
    installWorkerRecovery(target);

    expect((await target.fetch("/admin/api/status")).status).toBe(200);
    expect(await target.fetch("/admin/api/accounts")).toBe(own503);
    expect(native).toHaveBeenCalledTimes(2);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("announces the page to a restarted worker and repeats the request once", async () => {
    const { postMessage } = fakeServiceWorker();
    const native = vi.fn().mockResolvedValueOnce(unhandled()).mockResolvedValueOnce(ok());
    const target = { fetch: native as typeof fetch };
    installWorkerRecovery(target);

    const init = { method: "POST", body: "{}" };
    const response = await target.fetch("/admin/api/session/ticket", init);

    expect(response.status).toBe(200);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith("MOCK_ACTIVATE");
    expect(native).toHaveBeenLastCalledWith("/admin/api/session/ticket", init);
  });

  it("re-announces once for requests that fail together", async () => {
    const { postMessage } = fakeServiceWorker();
    const native = vi
      .fn()
      .mockResolvedValueOnce(unhandled())
      .mockResolvedValueOnce(unhandled())
      .mockResolvedValue(ok());
    const target = { fetch: native as typeof fetch };
    installWorkerRecovery(target);

    const [a, b] = await Promise.all([target.fetch("/admin/api/a"), target.fetch("/admin/api/b")]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("returns the 503 when no worker controls the page", async () => {
    fakeServiceWorker({ controller: false });
    const first = unhandled();
    const native = vi.fn().mockResolvedValueOnce(first);
    const target = { fetch: native as typeof fetch };
    installWorkerRecovery(target);

    expect(await target.fetch("/admin/api/status")).toBe(first);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("gives up and returns the 503 when the worker never answers", async () => {
    vi.useFakeTimers();
    fakeServiceWorker({ answers: false });
    const first = unhandled();
    const native = vi.fn().mockResolvedValueOnce(first);
    const target = { fetch: native as typeof fetch };
    installWorkerRecovery(target);

    const pending = target.fetch("/admin/api/status");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toBe(first);
    expect(native).toHaveBeenCalledTimes(1);
  });
});
