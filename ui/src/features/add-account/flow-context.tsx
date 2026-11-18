import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { NOTICE_LINE_CLASS } from "@/components/shared/notice-line";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Account, AddedAccountRef } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import type { FlowSessions } from "./flow-sessions";

export interface FinishOptions {
  keepOpen?: boolean;
  warning?: string;
}

export interface FlowContextValue {
  sessions: FlowSessions;
  /**
   * Closes the dialog, reports the ids, refreshes the lists and fetches usage for each id. With
   * `keepOpen` (a batch with failures) the dialog stays open on the flow, which shows them. With
   * a `warning` (a login that went in with something to read) the dialog stays open on that line
   * in place of the flow, with Close as its button.
   */
  finishAdd: (refs: AddedAccountRef[], options?: FinishOptions) => void;
  /** Accounts went in while the dialog stayed open, so Cancel (which undoes nothing) reads Close. */
  saved: boolean;
  /** While true the dialog cannot be dismissed with Escape, the backdrop or the X. */
  setBusy: (busy: boolean) => void;
  /** Closes the dialog. */
  cancel: () => void;
  /** The dialog footer, where flows render their buttons. */
  footer: HTMLElement | null;
  /** The account a re-login replaces the login of, or null when adding (see useReloginFlow). */
  relogin: Account | null;
}

const FlowContext = createContext<FlowContextValue | null>(null);

export const FlowProvider = FlowContext.Provider;

export function useFlow(): FlowContextValue {
  const value = useContext(FlowContext);
  if (!value) throw new Error("useFlow must be used inside the add-account dialog");
  return value;
}

/** Reports a pending request to the dialog for as long as `busy` is true. */
export function useReportBusy(busy: boolean): void {
  const { setBusy } = useFlow();
  useEffect(() => {
    if (!busy) return;
    setBusy(true);
    return () => setBusy(false);
  }, [busy, setBusy]);
}

/** A form id for a submit button rendered in the footer, outside the form. */
export function useFormId(): string {
  return `add-account-${useId().replace(/[^\w-]/g, "")}`;
}

/**
 * Footer buttons: a ghost Cancel, then the flow's own actions (Back is the arrow in the dialog
 * header). Rendered into the dialog footer through a portal, so the body can scroll while the
 * buttons stay put; on phones Cancel and the main action share one row.
 */
export function FlowFooter({ children }: { children?: ReactNode }): JSX.Element | null {
  const { t } = useT("add-account");
  const { footer, cancel, saved } = useFlow();
  if (!footer) return null;
  return createPortal(
    <>
      <Button onClick={cancel} variant="ghost">
        {saved ? t("common:actions.close") : t("cancel")}
      </Button>
      {children}
    </>,
    footer,
  );
}

/**
 * A login that went in with something to read (its Kiro profile not found yet, a re-login whose
 * user could not be confirmed): one amber line in place of the finished flow, and Close as the
 * footer's only button. The line's alert role reads it out; Close takes the focus of the flow's
 * controls, which are gone.
 */
export function SavedWarning({ text }: { text: string }): JSX.Element {
  const { t } = useT("add-account");
  const { footer, cancel } = useFlow();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <>
      <Alert className={NOTICE_LINE_CLASS} variant="warning">
        <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
        <AlertDescription className="wrap-break-word">{text}</AlertDescription>
      </Alert>
      {footer
        ? createPortal(
            <Button onClick={cancel} ref={closeRef}>
              {t("common:actions.close")}
            </Button>,
            footer,
          )
        : null}
    </>
  );
}
