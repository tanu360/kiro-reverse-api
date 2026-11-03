import { notchToast } from "@/components/ui/notch-toaster";
import { errorMessage } from "@/lib/api/server-errors";
import type { TFunction } from "@/lib/i18n";

export interface ToastOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Showing a toast with the id of an open one morphs that toast instead of adding another. */
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
  const { duration, ...rest } = options;
  return notchToast.show(type, title, { ...rest, duration: duration ?? DEFAULT_DURATION[type] });
}

/** App toasts on top of the notch toaster. Each call returns the toast id. */
export const toast: {
  success(title: string, options?: ToastOptions): string;
  error(title: string, options?: ToastOptions): string;
  warning(title: string, options?: ToastOptions): string;
  info(title: string, options?: ToastOptions): string;
  loading(title: string, options?: ToastOptions): string;
  /** A loading toast that morphs into the result when `work` settles; returns `work`'s result. */
  promise<T>(
    work: Promise<T> | (() => Promise<T>),
    messages: {
      loading: string;
      success: string | ((value: T) => string);
      error: string | ((reason: unknown) => string);
    },
  ): Promise<T>;
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
  promise: (work, messages) => notchToast.promise(work, messages),
  update(id, next) {
    notchToast.update(id, {
      type: next.type,
      title: next.title,
      description: next.description,
      duration: next.duration ?? DEFAULT_DURATION[next.type],
    });
  },
  dismiss(id) {
    notchToast.dismiss(id);
  },
};

export function toastError(error: unknown, t: TFunction, fallbackKey?: string): string {
  return toast.error(errorMessage(error, t, fallbackKey));
}
