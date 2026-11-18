import { createContext, type JSX, type ReactNode, useContext, useMemo } from "react";
import { ActionError } from "@/components/shared/action-error";

/**
 * A failed account action (a row's, the detail sheet's, a batch's), said in one place in place of
 * a toast: the top of the accounts card on the list page, the top of the detail sheet.
 */
export interface AccountFailure {
  /** The failed request's error: its reason is the line. */
  error: unknown;
  /** The line in place of the reason, for a failure with words of its own (a batch's result). */
  message?: string;
  /** Runs the same action again, on the same accounts, without asking again. */
  retry?: () => void;
  /** The control the action came from: focus goes there as the notice goes. */
  target?: () => HTMLElement | null | undefined;
}

export type ReportAccountFailure = (failure: AccountFailure | null) => void;

interface FailurePlace {
  report: ReportAccountFailure;
  /** Where focus goes when the action's own control is gone (a deleted row's menu). */
  fallbackFocus: () => HTMLElement | null | undefined;
}

const FailureContext = createContext<FailurePlace | null>(null);

/**
 * Lets the account actions under it report a failure to the place that shows it (`report`), and
 * clear it as a new action starts (`report(null)`).
 */
export function AccountFailureProvider({
  report,
  fallbackFocus,
  children,
}: FailurePlace & { children: ReactNode }): JSX.Element {
  const value = useMemo(() => ({ report, fallbackFocus }), [report, fallbackFocus]);
  return <FailureContext.Provider value={value}>{children}</FailureContext.Provider>;
}

/** The place that shows this action's failure; null outside a provider (the hooks then say it). */
export function useAccountFailurePlace(): FailurePlace | null {
  return useContext(FailureContext);
}

/** Whether an element is laid out: the table and the cards both render, one hidden. */
function isShown(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    (typeof element.checkVisibility !== "function" || element.checkVisibility())
  );
}

/** Focuses the action's own control while it is shown, else the place's fallback. */
export function focusFailureTarget(
  failure: AccountFailure,
  fallbackFocus: () => HTMLElement | null | undefined,
): void {
  const own = failure.target?.();
  (own && isShown(own) ? own : fallbackFocus())?.focus();
}

/**
 * The failure as one inline line (ActionError) with Try again and close. Both move focus to the
 * action's control first, as the notice and its focused button go away.
 */
export function AccountFailureNotice({
  failure,
  report,
  fallbackFocus,
  className,
}: FailurePlace & { failure: AccountFailure; className?: string }): JSX.Element {
  const { retry } = failure;
  return (
    <ActionError
      className={className}
      error={failure.error}
      message={failure.message}
      onDismiss={() => {
        focusFailureTarget(failure, fallbackFocus);
        report(null);
      }}
      onRetry={
        retry
          ? () => {
              focusFailureTarget(failure, fallbackFocus);
              report(null);
              retry();
            }
          : undefined
      }
    />
  );
}
