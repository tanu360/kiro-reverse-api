import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { resetMockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { queryClient } from "@/lib/query-client";

// The events provider uses the real EventSource only when no test passes createEventSource.
// Without one it stays 'closed' and requests no ticket. A test can stub its own.
vi.stubGlobal("EventSource", undefined);

// jsdom lacks several browser APIs that Base UI and the app touch. Stub them once here.

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}

if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:mock";
}

if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = () => {};
}

beforeAll(() => {
  // MSW 3 renamed onUnhandledRequest to onUnhandledFrame.
  mockServer.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  cleanup();
  mockServer.resetHandlers();
  resetMockDb();
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
});

afterAll(() => {
  mockServer.close();
});
