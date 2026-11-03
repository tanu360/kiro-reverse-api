"use client";

/*
 * Notch Toaster, adapted from notch-toast 0.2.0 (https://github.com/Devsethi3/notch-toast).
 *
 * MIT License. Copyright (c) 2026 notch-toast contributors.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or substantial portions of
 * the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 * The package renders one island that morphs between toasts. It is copied in, like the other
 * components in this folder, because the package has no hooks for what the app needs:
 * - Kiro patch: lucide icons per type instead of the package's drawn glyphs.
 * - Kiro patch: translated close and region labels (the package hardcodes English).
 * - Kiro patch: an optional description line, and titles that wrap instead of being clipped.
 * - Kiro patch: colours come from the --notch-* tokens in index.css (light and dark).
 * - Kiro patch: a newer toast covers a persistent one (an error, a running task) instead of
 *   dropping it; the covered toast comes back when the newer one goes.
 * - Kiro patch: the timer pauses while the island is hovered or focused, or the tab is hidden.
 * - Kiro patch: Escape inside a dialog or menu closes that first, not the toast.
 * - Kiro patch: an always-mounted live region announces toasts (a region added together with
 *   its text is often not read), and the styles live in index.css, not an injected <style>.
 */

import {
  CircleCheckIcon,
  CircleXIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { AnimatePresence, motion, type Transition, useReducedMotion } from "motion/react";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useUiT } from "@/components/ui/messages";
import { cn } from "@/lib/utils";

export type NotchToastType = "default" | "success" | "error" | "warning" | "info" | "loading";
export type NotchPosition = "top-center" | "bottom-center";
export type NotchMode = "attached" | "floating";
export type NotchAnimationPreset = "fluid" | "gooey" | "smooth" | "subtle" | "snappy";

export interface NotchToastAction {
  label: ReactNode;
  onClick: () => void;
}

export interface NotchToastOptions {
  /** A stable id: showing a toast with the id of an open one morphs that toast in place. */
  id?: string;
  description?: string;
  /** Milliseconds on screen; 0 keeps the toast until it is dismissed. */
  duration?: number;
  /** Shows the close button and lets Escape dismiss. Defaults to on for persistent toasts. */
  dismissible?: boolean;
  action?: NotchToastAction;
}

export interface NotchToastRecord {
  id: string;
  title: string;
  description?: string;
  type: NotchToastType;
  duration: number;
  dismissible?: boolean;
  action?: NotchToastAction;
  /** Bumped on every change, so the island replays its content morph. */
  revision: number;
}

export type NotchToastPatch = Partial<Omit<NotchToastRecord, "id" | "revision">>;

const DEFAULT_DURATION: Record<NotchToastType, number> = {
  default: 3600,
  success: 3600,
  info: 3600,
  warning: 0,
  error: 0,
  loading: 0,
};

/** Covered persistent toasts kept underneath the active one. */
const MAX_TOASTS = 5;

let idSeed = 0;
let revisionSeed = 0;
/** Oldest first; the last one is on screen. */
let stack: NotchToastRecord[] = [];
let active: NotchToastRecord | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  active = stack.at(-1) ?? null;
  for (const listener of listeners) listener();
}

function isPersistent(record: NotchToastRecord): boolean {
  return record.duration <= 0;
}

/**
 * Puts `record` on screen. A timed toast it covers is done; a persistent one waits underneath
 * and comes back when everything newer has gone.
 */
function bringToFront(record: NotchToastRecord): void {
  stack = stack.filter((item) => item.id !== record.id && isPersistent(item));
  stack.push(record);
  if (stack.length > MAX_TOASTS) stack = stack.slice(-MAX_TOASTS);
  emit();
}

function show(type: NotchToastType, title: string, options: NotchToastOptions = {}): string {
  const record: NotchToastRecord = {
    id: options.id ?? `notch-${Date.now()}-${idSeed++}`,
    title,
    description: options.description,
    type,
    duration: options.duration ?? DEFAULT_DURATION[type],
    dismissible: options.dismissible,
    action: options.action,
    revision: revisionSeed++,
  };
  bringToFront(record);
  return record.id;
}

function update(id: string, patch: NotchToastPatch): void {
  const index = stack.findIndex((item) => item.id === id);
  const current = stack[index];
  if (!current) return;
  const next: NotchToastRecord = { ...current, ...patch, id, revision: revisionSeed++ };
  // A covered task that settles (loading to success, say) is news: it comes to the front.
  const settled = patch.type !== undefined && patch.type !== current.type;
  if (index !== stack.length - 1 && settled) {
    bringToFront(next);
    return;
  }
  stack = stack.map((item) => (item.id === id ? next : item));
  emit();
}

function dismiss(id?: string): void {
  const next = id === undefined ? [] : stack.filter((item) => item.id !== id);
  if (next.length === stack.length) return;
  stack = next;
  emit();
}

interface PromiseToastOptions<T> extends Omit<NotchToastOptions, "duration"> {
  loading: string;
  success: string | ((value: T) => string);
  error: string | ((reason: unknown) => string);
  /** How long the settled toast stays; errors stay until dismissed unless this is set. */
  duration?: number;
}

/** Shows a loading island at once and morphs it into the result when the promise settles. */
function promise<T>(
  work: Promise<T> | (() => Promise<T>),
  { loading, success, error, duration, ...options }: PromiseToastOptions<T>,
): Promise<T> {
  const id = show("loading", loading, options);
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(typeof work === "function" ? work() : work);
  } catch (reason) {
    pending = Promise.reject(reason);
  }
  return pending.then(
    (value) => {
      update(id, {
        type: "success",
        title: typeof success === "function" ? success(value) : success,
        duration: duration ?? DEFAULT_DURATION.success,
      });
      return value;
    },
    (reason: unknown) => {
      update(id, {
        type: "error",
        title: typeof error === "function" ? error(reason) : error,
        duration: duration ?? DEFAULT_DURATION.error,
      });
      throw reason;
    },
  );
}

/** The store behind the island. Every call that shows a toast returns its id. */
export const notchToast: {
  show: typeof show;
  update: typeof update;
  dismiss: typeof dismiss;
  promise: typeof promise;
} = { show, update, dismiss, promise };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): NotchToastRecord | null {
  return active;
}

function isDismissible(record: NotchToastRecord): boolean {
  if (record.dismissible !== undefined) return record.dismissible;
  return (
    isPersistent(record) ||
    record.action !== undefined ||
    record.type === "error" ||
    record.type === "warning" ||
    record.type === "loading"
  );
}

const PRESETS: Record<NotchAnimationPreset, Transition> = {
  fluid: { type: "spring", stiffness: 400, damping: 32, mass: 0.62 },
  gooey: { type: "spring", stiffness: 280, damping: 18, mass: 0.7 },
  smooth: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
  subtle: { type: "spring", stiffness: 340, damping: 40, mass: 0.58 },
  snappy: { type: "spring", stiffness: 520, damping: 34, mass: 0.48 },
};

const CONTENT_TRANSITION: Transition = { duration: 0.42, ease: [0.16, 1, 0.3, 1] };
const REDUCED_FADE: Transition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] };

const ICONS: Partial<Record<NotchToastType, typeof InfoIcon>> = {
  success: CircleCheckIcon,
  error: CircleXIcon,
  warning: TriangleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
};

/** Measures the content's natural size, so the shell morphs without scaling its children. */
function useContentSize(revision: number | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every revision.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [revision]);

  return [ref, size] as const;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** Escape there belongs to the layer that has focus: a dialog, menu or list closes first. */
const ESCAPE_OWNERS = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

/**
 * Keeps the timer of the toast on screen, paused while `paused` is true. The remaining time
 * survives a pause; a new revision starts the full duration again.
 */
function useAutoDismiss(record: NotchToastRecord | null, paused: boolean): void {
  const remaining = useRef<{ revision: number; ms: number } | null>(null);

  useEffect(() => {
    if (!record || record.duration <= 0 || paused) return;
    if (remaining.current?.revision !== record.revision) {
      remaining.current = { revision: record.revision, ms: record.duration };
    }
    const left = remaining.current;
    const startedAt = Date.now();
    const timeout = window.setTimeout(() => dismiss(record.id), left.ms);
    return () => {
      window.clearTimeout(timeout);
      left.ms -= Date.now() - startedAt;
    };
  }, [record, paused]);
}

function usePageHidden(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
    () => document.visibilityState === "hidden",
    () => false,
  );
}

export interface NotchToasterProps {
  position?: NotchPosition;
  mode?: NotchMode;
  animation?: NotchAnimationPreset;
  /** Accessible name of the close button. */
  closeLabel?: string;
  /** Accessible name of the notifications region. */
  regionLabel?: string;
  className?: string;
}

/** The renderer for the toast store. Mount it once per app. */
export function NotchToaster({
  position = "top-center",
  mode = "attached",
  animation = "fluid",
  closeLabel,
  regionLabel,
  className,
}: NotchToasterProps): ReactElement {
  const { t } = useUiT();
  const record = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const reduceMotion = useReducedMotion() ?? false;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const pageHidden = usePageHidden();
  const [contentRef, contentSize] = useContentSize(record?.revision);
  const rootRef = useRef<HTMLElement>(null);
  const isBottom = position === "bottom-center";
  const transition = reduceMotion ? REDUCED_FADE : PRESETS[animation];
  const slotOffset = isBottom ? 7 : -7;
  const slotOrigin = mode === "attached" ? (isBottom ? "bottom center" : "top center") : "center";
  const dismissible = record ? isDismissible(record) : false;

  useAutoDismiss(record, hovered || focused || pageHidden);

  // A dismissed island unmounts under the pointer, so no pointerleave arrives to clear these.
  const empty = record === null;
  useEffect(() => {
    if (!empty) return;
    setHovered(false);
    setFocused(false);
  }, [empty]);

  useEffect(() => {
    if (!record || !dismissible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isEditable(event.target)) return;
      const target = event.target instanceof Element ? event.target : null;
      const insideToaster = target !== null && rootRef.current?.contains(target);
      if (!insideToaster && target?.closest(ESCAPE_OWNERS)) return;
      dismiss(record.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [record, dismissible]);

  const Icon = record ? ICONS[record.type] : undefined;

  return (
    <section
      aria-label={regionLabel ?? t("toast.region")}
      className={cn("notch-toaster", className)}
      data-mode={mode}
      data-position={position}
      ref={rootRef}
    >
      {/*
        Always mounted, so a toast added inside is announced (a live region that arrives with
        its text often is not). Errors interrupt; everything else waits its turn.
      */}
      <div aria-live={record?.type === "error" ? "assertive" : "polite"}>
        <AnimatePresence initial={false}>
          {record ? (
            <motion.div
              animate={
                reduceMotion
                  ? { opacity: 1 }
                  : {
                      opacity: 1,
                      y: 0,
                      scale: 1,
                      filter: "blur(0px)",
                      width: contentSize?.width,
                      height: contentSize?.height,
                    }
              }
              className="notch-shell"
              data-slot="notch-toast"
              data-type={record.type}
              exit={
                reduceMotion
                  ? { opacity: 0 }
                  : { opacity: 0, y: isBottom ? 8 : -8, scale: 0.96, filter: "blur(6px)" }
              }
              initial={
                reduceMotion
                  ? { opacity: 0 }
                  : { opacity: 0, y: isBottom ? 12 : -12, scale: 0.96, filter: "blur(8px)" }
              }
              key="shell"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
              }}
              onFocus={() => setFocused(true)}
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
              transition={transition}
            >
              <div className="notch-viewport">
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.div
                    animate={
                      reduceMotion
                        ? { opacity: 1 }
                        : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
                    }
                    className="notch-content"
                    exit={
                      reduceMotion
                        ? { opacity: 0, transition: REDUCED_FADE }
                        : {
                            opacity: 0,
                            y: slotOffset,
                            scale: 0.92,
                            filter: "blur(0px)",
                            transition: { duration: 0.1, ease: [0.16, 1, 0.3, 1] },
                          }
                    }
                    initial={
                      reduceMotion
                        ? { opacity: 0 }
                        : { opacity: 0, y: slotOffset, scale: 0.92, filter: "blur(5px)" }
                    }
                    key={record.revision}
                    ref={contentRef}
                    style={{ transformOrigin: slotOrigin }}
                    transition={transition}
                  >
                    {Icon ? (
                      <span className="notch-icon" data-slot="notch-toast-icon">
                        <motion.span
                          animate={{ opacity: 1, scale: 1 }}
                          className="grid place-items-center"
                          initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
                          key={record.type}
                          transition={
                            reduceMotion ? { duration: 0 } : { ...CONTENT_TRANSITION, delay: 0.08 }
                          }
                        >
                          <Icon aria-hidden="true" />
                        </motion.span>
                      </span>
                    ) : null}
                    <div className="notch-text">
                      <p className="notch-title" data-slot="notch-toast-title">
                        {record.title}
                      </p>
                      {record.description ? (
                        <p className="notch-description" data-slot="notch-toast-description">
                          {record.description}
                        </p>
                      ) : null}
                    </div>
                    {record.action || dismissible ? (
                      <div className="notch-buttons">
                        {record.action ? (
                          <button
                            className="notch-action"
                            data-slot="notch-toast-action"
                            onClick={() => {
                              const { id, action } = record;
                              action?.onClick();
                              dismiss(id);
                            }}
                            type="button"
                          >
                            {record.action.label}
                          </button>
                        ) : null}
                        {dismissible ? (
                          <button
                            aria-keyshortcuts="Escape"
                            aria-label={closeLabel ?? t("toast.dismiss")}
                            className="notch-close"
                            data-slot="notch-toast-close"
                            onClick={() => dismiss(record.id)}
                            type="button"
                          >
                            <XIcon aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}
