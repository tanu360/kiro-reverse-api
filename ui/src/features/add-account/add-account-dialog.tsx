import { useQueryClient } from "@tanstack/react-query";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { refreshAccount } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import type { Account, AddedAccountRef } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { type FlowContextValue, FlowProvider } from "./flow-context";
import { FlowSessions } from "./flow-sessions";
import { ApiKeyFlow } from "./flows/api-key-flow";
import { BuilderIdFlow } from "./flows/builder-id-flow";
import { CookieFlow } from "./flows/cookie-flow";
import { CredentialsFlow } from "./flows/credentials-flow";
import { IamFlow } from "./flows/iam-flow";
import { LocalCacheFlow } from "./flows/local-cache-flow";
import { MicrosoftFlow } from "./flows/microsoft-flow";
import { SsoTokenFlow } from "./flows/sso-token-flow";
import { reloginMethod } from "./lib/relogin-method";
import { MethodHead, MethodRail, MethodSelect } from "./method-list";

export type AddAccountMethod =
  | "builderid"
  | "iam"
  | "microsoft"
  | "sso"
  | "local"
  | "credentials"
  | "cookie"
  | "apikey";

interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMethod?: AddAccountMethod;
  onAdded?: (accountIds: string[]) => void;
  /**
   * Log this account in again instead of adding one: the method it signed in with opens first,
   * every flow sends its id as reloginAccountId, and success replaces its login in place.
   */
  relogin?: Account;
}

const FLOWS: Record<AddAccountMethod, () => JSX.Element> = {
  builderid: BuilderIdFlow,
  iam: IamFlow,
  microsoft: MicrosoftFlow,
  sso: SsoTokenFlow,
  local: LocalCacheFlow,
  credentials: CredentialsFlow,
  cookie: CookieFlow,
  apikey: ApiKeyFlow,
};

/**
 * The add-account dialog as a split pane: every method in a rail at the start (a select at the
 * top on phones), the chosen method's steps beside it, so switching methods is one click and
 * there is no list-then-form step. Every way out (X, Escape, backdrop, Cancel, a method switch,
 * success, unmount) resets the shared FlowSessions, which cancels the Microsoft login, stops
 * Builder ID polling, forgets the IAM session and drops late responses.
 */
export function AddAccountDialog({
  open,
  onOpenChange,
  initialMethod,
  onAdded,
  relogin,
}: AddAccountDialogProps): JSX.Element {
  const { t } = useT("add-account");
  const display = useDisplayEmail();
  const queryClient = useQueryClient();
  const [sessions] = useState(() => new FlowSessions());
  const startMethod = initialMethod ?? (relogin ? reloginMethod(relogin) : "builderid");
  const [method, setMethod] = useState<AddAccountMethod>(startMethod);
  // A new key remounts the flow, so each visit starts from its first step.
  const [flowKey, setFlowKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  // Each time the dialog opens, start over at the requested method (Builder ID by default).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMethod(startMethod);
      setFlowKey((key) => key + 1);
      setBusy(false);
    }
  }

  // Closing (by any route, including a parent setting open=false) and unmounting both reset.
  useEffect(() => {
    if (!open) return;
    return () => sessions.reset();
  }, [open, sessions]);

  const latest = useRef({ onOpenChange, onAdded, relogin });
  latest.current = { onOpenChange, onAdded, relogin };

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) sessions.reset();
      latest.current.onOpenChange(next);
    },
    [sessions],
  );

  const finishAdd = useCallback(
    async (refs: AddedAccountRef[]) => {
      sessions.reset({ cancelMicrosoft: false });
      latest.current.onOpenChange(false);
      const ids = refs.map((ref) => ref.id).filter(Boolean);
      latest.current.onAdded?.(ids);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.status }),
      ]);
      // A re-login is checked by the server itself, and the list hears the result over SSE.
      if (ids.length === 0 || latest.current.relogin) return;
      // Fetch usage and subscription for each new account, one at a time, as the old UI did.
      for (const id of ids) {
        try {
          await refreshAccount(id);
        } catch {
          // The account is added either way; its usage loads on the next refresh.
        }
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all });
    },
    [queryClient, sessions],
  );

  // Switching methods drops whatever the open one had started. Focus stays on the rail item (or
  // the select), so a keyboard user can keep moving through the methods.
  const selectMethod = useCallback(
    (next: AddAccountMethod) => {
      sessions.reset();
      setMethod(next);
      setFlowKey((key) => key + 1);
      setBusy(false);
    },
    [sessions],
  );

  const cancel = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  const context = useMemo<FlowContextValue>(
    () => ({
      sessions,
      finishAdd: (refs) => void finishAdd(refs),
      setBusy,
      cancel,
      footer,
      relogin: relogin ?? null,
    }),
    [sessions, finishAdd, cancel, footer, relogin],
  );

  const Flow = FLOWS[method];
  // While a request runs, Escape and outside presses do nothing and the X is disabled; Cancel
  // still closes (it resets the sessions, which drops the late response).
  const onDialogOpenChange = (next: boolean, details?: { reason?: string }) => {
    if (!next && busy && details?.reason === "escape-key") return;
    handleOpenChange(next);
  };
  return (
    <Dialog disablePointerDismissal={busy} onOpenChange={onDialogOpenChange} open={open}>
      <DialogPopup
        // Hung from the top, so the title stays put while the methods change height.
        anchor="top"
        closeProps={{ disabled: busy }}
        size="3xl"
      >
        <DialogHeader>
          <DialogTitle>{relogin ? t("relogin.title") : t("title")}</DialogTitle>
          {relogin ? (
            <DialogDescription>
              {t("relogin.target", { name: display(relogin.email, relogin.id) })}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{t("description")}</DialogDescription>
          )}
        </DialogHeader>
        {/* A fixed height from sm up, so switching methods never resizes the dialog. */}
        <div className="flex min-h-0 flex-1 border-border-subtle border-t sm:h-128 sm:flex-initial">
          <MethodRail busy={busy} method={method} onSelect={selectMethod} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <DialogPanel className="in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-6">
              <MethodSelect busy={busy} method={method} onSelect={selectMethod} />
              <MethodHead method={method} />
              <FlowProvider value={context}>
                <Flow key={flowKey} />
              </FlowProvider>
            </DialogPanel>
          </div>
        </div>
        <DialogFooter>
          {/* The flows portal Cancel and their action in here (one row of two on phones). */}
          <div
            className="contents max-sm:[&>:last-child:nth-child(odd)]:col-span-2"
            ref={setFooter}
          />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
