import type React from "react";

const FOCUSABLE =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable="true"]';

function isTabbable(element: HTMLElement): boolean {
  if (element.tabIndex < 0) return false;
  // Base UI's own guards would hand focus on in the next frame; skip them and wrap directly.
  if (element.hasAttribute("data-base-ui-focus-guard")) return false;
  if ((element as HTMLButtonElement).disabled) return false;
  if (element instanceof HTMLInputElement && element.type === "hidden") return false;
  if (element.closest("[inert], [hidden]")) return false;
  // jsdom has no layout and no checkVisibility; browsers drop display:none and hidden subtrees.
  if (
    typeof element.checkVisibility === "function" &&
    !element.checkVisibility({ visibilityProperty: true })
  ) {
    return false;
  }
  return true;
}

/** Keyboard-reachable elements inside `root`, in DOM order. */
export function tabbableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isTabbable);
}

/**
 * Keeps Tab inside a modal popup. Base UI traps focus with guard elements that move focus on the
 * next animation frame, so a fast Tab from the last control (or a key held down) can land on the
 * guard, then `<body>` and the page behind the backdrop, where Escape no longer closes the popup.
 * This wraps Tab and Shift+Tab synchronously instead. Events from nested portals (menus, selects,
 * a stacked dialog) are left to those popups.
 */
export function wrapTabFocus(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const popup = event.currentTarget;
  if (!popup.contains(event.target as Node)) return;
  const items = tabbableElements(popup);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = popup.ownerDocument.activeElement;
  if (event.shiftKey) {
    if (active === first || active === popup) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (active === last) {
    event.preventDefault();
    first.focus();
  }
}
