import { toastManager as manager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api/server-errors";
import type { TFunction } from "@/lib/i18n";

export interface ToastOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Showing a toast with the id of an open one replaces that toast instead of adding another. */
  id?: string;
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

function show(type: ToastType, title: string, options: ToastOptions = {}): string {
  const id = options.id ?? `toast-${Date.now()}-${idSeed++}`;
  const { action } = options;
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
  });
  return id;
}

function update(
  id: string,
  next: { type: SettledType; title: string; description?: string; duration?: number },
): void {
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
    manager.close(id);
  },
};

export function toastError(error: unknown, t: TFunction, fallbackKey?: string): string {
  return toast.error(errorMessage(error, t, fallbackKey));
}
