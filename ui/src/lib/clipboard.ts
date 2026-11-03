function isPromise(value: unknown): value is Promise<string> {
  return typeof (value as Promise<string> | null)?.then === "function";
}

/** Hidden-textarea fallback. The async Clipboard API is missing on plain-HTTP origins. */
function copyWithExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/**
 * Copies text to the clipboard. Resolves false on failure and never throws.
 *
 * A promise is handed to ClipboardItem first: Safari only keeps the user activation of the click
 * if clipboard.write starts synchronously, before the value (a secret fetched from the server,
 * for example) has arrived.
 */
export async function copyText(value: string | Promise<string>): Promise<boolean> {
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (isPromise(value) && typeof ClipboardItem !== "undefined" && clipboard?.write) {
      try {
        const blob = value.then((text) => new Blob([String(text ?? "")], { type: "text/plain" }));
        await clipboard.write([new ClipboardItem({ "text/plain": blob })]);
        return true;
      } catch {
        // Fall through to the other strategies.
      }
    }
    const text = String((await value) ?? "");
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to execCommand.
      }
    }
    return copyWithExecCommand(text);
  } catch {
    return false;
  }
}
