import type { TFunction } from "@/lib/i18n";

export interface ToastOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  id?: string;
}

// Skeleton: Task 3 wires these to the coss toast manager. Each call returns a toast id.

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
  success: () => "",
  error: () => "",
  warning: () => "",
  info: () => "",
  loading: () => "",
  update: () => {},
  dismiss: () => {},
};

export function toastError(_error: unknown, _t: TFunction, _fallbackKey?: string): string {
  return "";
}
