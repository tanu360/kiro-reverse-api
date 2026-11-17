import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef } from "react";

/*
 * Single-key shortcuts (J, K, an arrow, "/"), the kind a list or a detail sheet answers to.
 * A shortcut never fires while the reader types or works a control that owns those keys:
 *   - with Ctrl, Meta or Alt held (Shift is part of the key: "?" or "/"),
 *   - in a text field, a select or contenteditable text,
 *   - inside a widget that moves with arrows or letters (tabs, a radio group, a menu, a listbox,
 *     a slider, a grid, a combobox), so its own arrow keys keep working,
 *   - on a key already handled (defaultPrevented), or held down (repeat) for a page shortcut.
 */

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const KEY_WIDGETS =
  '[role="tablist"], [role="radiogroup"], [role="toolbar"], [role="slider"], [role="menu"], [role="menubar"], [role="listbox"], [role="grid"], [role="tree"], [role="combobox"], [role="spinbutton"]';
/** Overlays that take the keyboard while open (toasts are dialogs too, but never do). */
const OPEN_OVERLAY =
  '[role="dialog"]:not([data-slot="toast"]), [role="alertdialog"], [role="menu"], [role="listbox"]';

function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || TYPING_TAGS.has(target.tagName))
  )
    return true;
  return target.closest(KEY_WIDGETS) !== null;
}

function matches(event: { key: string }, keys: readonly string[]): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return keys.includes(key);
}

function plain(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return !(event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented);
}

/**
 * A shortcut for a whole page ("/" to the search): a document listener that stays quiet while a
 * dialog, sheet, menu or list is open over the page, as well as in the cases above. `keys` are
 * KeyboardEvent.key values, letters in lower case.
 */
export function useKeyShortcut(
  keys: readonly string[],
  handler: (event: KeyboardEvent) => void,
  enabled = true,
): void {
  const latest = useRef({ keys, handler });
  latest.current = { keys, handler };

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!plain(event) || event.repeat || !matches(event, latest.current.keys)) return;
      if (ownsKeys(event.target) || document.querySelector(OPEN_OVERLAY)) return;
      latest.current.handler(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/**
 * Shortcuts scoped to one element, such as a sheet's popup: an onKeyDown for it that maps keys to
 * actions. Keys from a layer opened from inside it (a nested sheet or a menu, rendered in a
 * portal elsewhere in the page but still a React child) are not its own and pass through.
 */
export function scopedShortcuts(
  bindings: ReadonlyArray<{ keys: readonly string[]; run: (() => void) | undefined }>,
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  return (event) => {
    if (!plain(event) || !(event.target instanceof Node)) return;
    if (!event.currentTarget.contains(event.target) || ownsKeys(event.target)) return;
    const binding = bindings.find(({ keys }) => matches(event, keys));
    if (!binding?.run) return;
    event.preventDefault();
    binding.run();
  };
}
