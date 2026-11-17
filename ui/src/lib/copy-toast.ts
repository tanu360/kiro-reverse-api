/**
 * Whether a successful copy also raises a toast. Android 13 and later shows its own "Copied"
 * overlay for every copy, so a toast there says it twice: never there. On a phone a control that
 * marks the copy itself (CopyButton's tick and "Copied" label, `marksItself`) is enough as well.
 * iOS shows nothing of its own, so there a copy with no mark of its own (a menu item) still
 * toasts. A failed copy always toasts; this is only for success.
 */
export function copiedToastWanted({ marksItself }: { marksItself: boolean }): boolean {
  // The OS's own clipboard overlay is a platform trait no media query reports.
  if (typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent)) return false;
  if (!marksItself || typeof window === "undefined" || !window.matchMedia) return true;
  return !window.matchMedia("(max-width: 39.99rem) and (pointer: coarse)").matches;
}
