import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LAYOUT_HYSTERESIS,
  nextListLayout,
  TABLE_MIN_WIDTH,
  useListLayout,
} from "./use-list-layout";

describe("nextListLayout", () => {
  it("shows the table from md (768 px) of list width, cards below", () => {
    expect(nextListLayout(null, 767)).toBe("cards");
    expect(nextListLayout(null, 768)).toBe("table");
    // A 1280 or 1366 px window with the 256 px sidebar open.
    expect(nextListLayout(null, 960)).toBe("table");
    expect(nextListLayout(null, 1046)).toBe("table");
  });

  it("goes back from cards to the table only past the hysteresis band", () => {
    expect(LAYOUT_HYSTERESIS).toBe(24);
    expect(nextListLayout("cards", TABLE_MIN_WIDTH)).toBe("cards");
    expect(nextListLayout("cards", TABLE_MIN_WIDTH + LAYOUT_HYSTERESIS - 1)).toBe("cards");
    expect(nextListLayout("cards", TABLE_MIN_WIDTH + LAYOUT_HYSTERESIS)).toBe("table");
    expect(nextListLayout("table", TABLE_MIN_WIDTH)).toBe("table");
    expect(nextListLayout("table", TABLE_MIN_WIDTH - 1)).toBe("cards");
  });
});

describe("useListLayout", () => {
  let resize: ((width: number) => void) | null = null;
  const original = globalThis.ResizeObserver;

  afterEach(() => {
    globalThis.ResizeObserver = original;
    resize = null;
    vi.restoreAllMocks();
  });

  /** A ResizeObserver whose callback the test drives, and an element `initial` px wide. */
  function setup(initial: number) {
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resize = (width) =>
          callback(
            [{ contentRect: DOMRect.fromRect({ width, height: 40 }) } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    const element = document.createElement("div");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: initial, height: 40 }),
    );
    // One ref object for every render, as useRef gives the page.
    const ref = { current: element };
    return renderHook(() => useListLayout(ref));
  }

  it("keeps the table on a 960 px list (1280 px window, sidebar open)", () => {
    const { result } = setup(960);
    expect(result.current).toBe("table");
  });

  it("does not flip back and forth while the width hovers at the threshold", () => {
    const { result } = setup(900);
    const widthTo = (width: number) => act(() => resize?.(width));
    expect(result.current).toBe("table");
    widthTo(TABLE_MIN_WIDTH - 4);
    expect(result.current).toBe("cards");
    // A sidebar animation or a scrollbar change nudges the width just over the threshold.
    widthTo(TABLE_MIN_WIDTH + 4);
    expect(result.current).toBe("cards");
    widthTo(TABLE_MIN_WIDTH - 2);
    expect(result.current).toBe("cards");
    widthTo(TABLE_MIN_WIDTH + LAYOUT_HYSTERESIS);
    expect(result.current).toBe("table");
    widthTo(TABLE_MIN_WIDTH + 2);
    expect(result.current).toBe("table");
  });
});
