import { createContext, type JSX, type ReactNode, useContext, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import type { AddedAccountRef } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import type { FlowSessions } from "./flow-sessions";

export interface FlowContextValue {
  sessions: FlowSessions;
  /** Closes the dialog, reports the ids, refreshes the lists and fetches usage for each id. */
  finishAdd: (refs: AddedAccountRef[]) => void;
  /** While true the dialog cannot be dismissed with Escape, the backdrop or the X. */
  setBusy: (busy: boolean) => void;
  /** Leaves the flow for the method list. */
  back: () => void;
  /** Closes the dialog. */
  cancel: () => void;
  /** The dialog footer, where flows render their buttons. */
  footer: HTMLElement | null;
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
 * Footer buttons: Back (unless `hideBack`), Cancel, then the flow's own actions. Rendered into
 * the dialog footer through a portal, so the body can scroll while the buttons stay put.
 */
export function FlowFooter({
  children,
  hideBack = false,
}: {
  children?: ReactNode;
  hideBack?: boolean;
}): JSX.Element | null {
  const { t } = useT("add-account");
  const { footer, back, cancel } = useFlow();
  if (!footer) return null;
  return createPortal(
    <>
      {hideBack ? null : (
        <Button className="h-10 sm:me-auto sm:h-8" onClick={back} variant="ghost">
          {t("back")}
        </Button>
      )}
      <Button className="h-10 sm:h-8" onClick={cancel} variant="outline">
        {t("cancel")}
      </Button>
      {children}
    </>,
    footer,
  );
}
