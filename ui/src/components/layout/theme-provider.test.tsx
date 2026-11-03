import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "./theme-provider";

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <>
      <p data-testid="state">
        {theme}/{resolvedTheme}
      </p>
      <button onClick={() => setTheme("dark")} type="button">
        dark
      </button>
      <button onClick={() => setTheme("system")} type="button">
        system
      </button>
    </>
  );
}

/** A controllable prefers-color-scheme media query. */
function mockColorScheme(initialDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let dark = initialDark;
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList => ({
      get matches() {
        return query.includes("dark") ? dark : false;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      },
      dispatchEvent: () => false,
    }),
  );
  return (next: boolean) => {
    dark = next;
    for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
  };
}

beforeEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeProvider", () => {
  it("setTheme('dark') adds .dark and persists kiro_theme", async () => {
    mockColorScheme(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("system/light");
    expect(document.documentElement).not.toHaveClass("dark");

    await user.click(screen.getByRole("button", { name: "dark" }));
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("reads the stored theme", () => {
    mockColorScheme(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("dark/dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it("system follows a live colour-scheme change", () => {
    const setSystemDark = mockColorScheme(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement).not.toHaveClass("dark");

    act(() => setSystemDark(true));
    expect(screen.getByTestId("state")).toHaveTextContent("system/dark");
    expect(document.documentElement).toHaveClass("dark");

    act(() => setSystemDark(false));
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
