import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api/server-errors";
import type { TFunction } from "@/lib/i18n";

export interface ToastOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  id?: string;
}

type ToastType = "success" | "error" | "warning" | "info" | "loading";

// Errors and loading toasts stay until dismissed (0 = no auto-dismiss).
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 0,
  loading: 0,
};

function show(type: ToastType, title: string, options: ToastOptions = {}): string {
  const { description, duration, action, id } = options;
  return toastManager.add({
    id,
    type,
    title,
    description,
    timeout: duration ?? DEFAULT_DURATION[type],
    priority: type === "error" ? "high" : "low",
    actionProps: action ? { children: action.label, onClick: action.onClick } : undefined,
  });
}

/** App toasts on top of the coss toast manager. Each call returns the toast id. */
export const toast: {
  success(title: string, options?: ToastOptions): string;
  error(title: string, options?: ToastOptions): string;
  warning(title: string, options?: ToastOptions): string;
  info(title: string, options?: ToastOptions): string;
  loading(title: string, options?: ToastOptions): string;
  update(
    id: string,
    next: {
      type: "success" | "error" | "warning" | "info";
      title: string;
      description?: string;
      duration?: number;
    },
  ): void;
  dismiss(id?: string): void;
} = {
  success: (title, options) => show("success", title, options),
  error: (title, options) => show("error", title, options),
  warning: (title, options) => show("warning", title, options),
  info: (title, options) => show("info", title, options),
  loading: (title, options) => show("loading", title, options),
  update(id, next) {
    toastManager.update(id, {
      type: next.type,
      title: next.title,
      description: next.description,
      timeout: next.duration ?? DEFAULT_DURATION[next.type],
      priority: next.type === "error" ? "high" : "low",
    });
  },
  dismiss(id) {
    toastManager.close(id);
  },
};

export function toastError(error: unknown, t: TFunction, fallbackKey?: string): string {
  return toast.error(errorMessage(error, t, fallbackKey));
}
