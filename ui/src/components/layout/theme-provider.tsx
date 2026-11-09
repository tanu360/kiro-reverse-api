import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { flushSync } from "react-dom";
import "./theme-transitions.css";

export type Theme = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "kiro_theme";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

const DARK_QUERY = "(prefers-color-scheme: dark)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const NO_TRANSITIONS_CLASS = "no-transitions";
/** On <html> while the reveal runs, so theme-transitions.css only restyles this transition. */
const REVEAL_CLASS = "theme-reveal";
const REVEAL_MS = 400;

/**
 * The browser chrome's colour (mobile address bar, PWA title bar): the page background of the
 * theme on screen (index.css --background), so a forced theme does not sit under the OS one.
 */
export const THEME_COLORS: Record<ResolvedTheme, string> = { dark: "#0f0f10", light: "#fafafa" };

/** Leaves one <meta name="theme-color"> (index.html ships a light and a dark media variant). */
function writeThemeColor(theme: ResolvedTheme): void {
  const metas = [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  const meta = metas.shift() ?? document.head.appendChild(document.createElement("meta"));
  for (const extra of metas) extra.remove();
  meta.name = "theme-color";
  meta.removeAttribute("media");
  meta.content = THEME_COLORS[theme];
}

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  /**
   * `origin` is the control that was used: when the page actually changes between light and
   * dark, the new theme grows over the old one as a circle from its centre (the viewport centre
   * without one).
   */
  setTheme: (theme: Theme, origin?: Element | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {}
  return "system";
}

function writeStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** View transitions are supported and the user has not asked for reduced motion. */
function canReveal(): boolean {
  if (typeof document.startViewTransition !== "function") return false;
  try {
    return !window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Runs `update` (which must change the DOM synchronously) inside a view transition and grows
 * the new page as a circle from (x, y) until it covers the farthest corner.
 */
function revealFrom(x: number, y: number, update: () => void): void {
  const root = document.documentElement;
  root.classList.add(REVEAL_CLASS);
  const transition = document.startViewTransition(update);
  transition.ready
    .then(() => {
      const radius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: REVEAL_MS,
          easing: "ease-in-out",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    // Skipped (another theme change started first): the update has still run.
    .catch(() => {});
  void transition.finished.finally(() => root.classList.remove(REVEAL_CLASS));
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // `system` follows the OS setting live.
  useEffect(() => {
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useLayoutEffect(() => {
    const root = document.documentElement;
    // Suppress colour transitions for one frame so the whole page swaps at once.
    root.classList.add(NO_TRANSITIONS_CLASS);
    root.classList.toggle("dark", resolvedTheme === "dark");
    root.style.colorScheme = resolvedTheme;
    writeThemeColor(resolvedTheme);
    const frame = requestAnimationFrame(() => root.classList.remove(NO_TRANSITIONS_CLASS));
    return () => {
      cancelAnimationFrame(frame);
      root.classList.remove(NO_TRANSITIONS_CLASS);
    };
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme, origin?: Element | null) => {
    writeStoredTheme(next);
    // The <html> class is the theme on screen right now.
    const nextDark = next === "dark" || (next === "system" && systemPrefersDark());
    const changes = nextDark !== document.documentElement.classList.contains("dark");
    if (!changes || !canReveal()) {
      setThemeState(next);
      return;
    }
    // Measured now, before the transition starts, in case the control unmounts (a menu item).
    const rect = origin?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    // flushSync: the layout effect above flips the .dark class inside the transition's update.
    revealFrom(x, y, () => flushSync(() => setThemeState(next)));
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
