import { type ModalNoticeSlot, openModalSlot, showInOpenModal } from "@/components/ui/modal-notice";
import { toastManager as manager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api/server-errors";
import type { TFunction } from "@/lib/i18n";

interface ToastOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Showing a toast with the id of an open one replaces that toast instead of adding another. */
  id?: string;
  /**
   * The app path this toast points at (such as "/settings"). There it has nothing to add, so it
   * is not shown while the app is on that page and closes when the app goes there (see
   * syncToastPath).
   */
  hideOnPath?: string;
  /**
   * Raised by work in the background (a poll, a refetch, the server's events, the session
   * timer), not by something done in an open dialog or sheet: it is never copied into one.
   */
  background?: boolean;
}

type ToastType = "success" | "error" | "warning" | "info" | "loading";
type SettledType = Exclude<ToastType, "loading">;

// Every toast has a close button, and every settled one also times out; errors stay longest.
// Loading toasts never time out (0) and wait for their update.
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
  loading: 0,
};

/*
 * The type the coss toast is given, which picks its icon and colour (components/ui/toast.tsx):
 * errors and warnings carry the alert icon and colour, loading the spinner. Success and info stay
 * plain messages, so the alert accent keeps its meaning.
 */
function toastType(type: ToastType): "error" | "warning" | "loading" | undefined {
  return type === "error" || type === "warning" || type === "loading" ? type : undefined;
}

let idSeed = 0;

/**
 * The modal open when each loading toast started, by id: its error, when it settles, belongs in
 * that modal if it is still the open one (see update).
 */
const loadingOrigins = new Map<string, ModalNoticeSlot | undefined>();

/** Open toasts that close on a path (ToastOptions.hideOnPath), by id. */
const pathToasts = new Map<string, { path: string }>();

/** True when `pathname` is `path` or a page under it. */
function isOnPath(pathname: string, path: string): boolean {
  const current = pathname.replace(/\/+$/, "");
  const target = path.replace(/\/+$/, "");
  return current.endsWith(target) || current.includes(`${target}/`);
}

function currentPathname(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

/**
 * Closes the toasts that point at the page the app is now on (ToastOptions.hideOnPath). The app
 * shell calls it on every navigation.
 */
export function syncToastPath(pathname: string): void {
  for (const [id, entry] of pathToasts) {
    if (isOnPath(pathname, entry.path)) {
      pathToasts.delete(id);
      manager.close(id);
    }
  }
}

function show(type: ToastType, title: string, options: ToastOptions = {}): string {
  const id = options.id ?? `toast-${Date.now()}-${idSeed++}`;
  const { action, hideOnPath } = options;
  // Already on the page it points at: nothing to say.
  if (hideOnPath && isOnPath(currentPathname(), hideOnPath)) return id;
  // A toast that takes over an open one's id also takes over (or drops) its path.
  pathToasts.delete(id);
  let onRemove: (() => void) | undefined;
  if (hideOnPath) {
    const entry = { path: hideOnPath };
    pathToasts.set(id, entry);
    // Forget it once it is gone, unless a newer toast took over its id.
    onRemove = () => {
      if (pathToasts.get(id) === entry) pathToasts.delete(id);
    };
  }
  // Under an open modal the toast cannot be read (components/ui/modal-notice.tsx): an error or
  // warning also shows in the modal itself.
  if ((type === "error" || type === "warning") && !options.background) {
    showInOpenModal({ type, title, description: options.description });
  }
  if (type === "loading") loadingOrigins.set(id, openModalSlot());
  else loadingOrigins.delete(id);
  manager.add({
    id,
    type: toastType(type),
    title,
    description: options.description,
    timeout: options.duration ?? DEFAULT_DURATION[type],
    // Errors are announced at once; everything else waits its turn.
    priority: type === "error" ? "high" : "low",
    actionProps: action
      ? {
          children: action.label,
          onClick: () => {
            action.onClick();
            manager.close(id);
          },
        }
      : undefined,
    onRemove,
  });
  return id;
}

function update(
  id: string,
  next: { type: SettledType; title: string; description?: string; duration?: number },
): void {
  const origin = loadingOrigins.get(id);
  loadingOrigins.delete(id);
  // A failure shows in the modal it started in, while that modal is still the open one.
  if ((next.type === "error" || next.type === "warning") && origin && origin === openModalSlot()) {
    origin.show({ type: next.type, title: next.title, description: next.description });
  }
  // `type` is always set, even to undefined, so a settled loading toast drops its spinner.
  manager.update(id, {
    type: toastType(next.type),
    title: next.title,
    description: next.description,
    timeout: next.duration ?? DEFAULT_DURATION[next.type],
    priority: next.type === "error" ? "high" : "low",
  });
}

/** App toasts on top of the coss ui toast (Base UI). Each call returns the toast id. */
export const toast: {
  success(title: string, options?: ToastOptions): string;
  error(title: string, options?: ToastOptions): string;
  warning(title: string, options?: ToastOptions): string;
  info(title: string, options?: ToastOptions): string;
  loading(title: string, options?: ToastOptions): string;
  update(
    id: string,
    next: { type: SettledType; title: string; description?: string; duration?: number },
  ): void;
  dismiss(id?: string): void;
} = {
  success: (title, options) => show("success", title, options),
  error: (title, options) => show("error", title, options),
  warning: (title, options) => show("warning", title, options),
  info: (title, options) => show("info", title, options),
  loading: (title, options) => show("loading", title, options),
  update,
  dismiss(id) {
    if (id) loadingOrigins.delete(id);
    manager.close(id);
  },
};

export function toastError(error: unknown, t: TFunction, fallbackKey?: string): string {
  return toast.error(errorMessage(error, t, fallbackKey));
}
