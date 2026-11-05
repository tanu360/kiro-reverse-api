import { useQueryClient } from "@tanstack/react-query";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { refreshAccount } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import type { AddedAccountRef } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
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
import { firstStepControl } from "./focus";
import { MethodList } from "./method-list";

export type AddAccountMethod =
  | "builderid"
  | "iam"
  | "microsoft"
  | "sso"
  | "local"
  | "credentials"
  | "cookie"
  | "apikey";

export interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMethod?: AddAccountMethod;
  onAdded?: (accountIds: string[]) => void;
}

function footerSubmit(footer: HTMLElement | null): HTMLElement | null {
  return footer?.querySelector<HTMLElement>('button[type="submit"]') ?? null;
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
 * The add-account wizard: a method list, then one flow, with a back arrow in the header. Every
 * way out (X, Escape, backdrop, Cancel, Back, success, unmount) resets the shared FlowSessions,
 * which cancels the Microsoft login, stops Builder ID polling, forgets the IAM session and drops
 * late responses.
 */
export function AddAccountDialog({
  open,
  onOpenChange,
  initialMethod,
  onAdded,
}: AddAccountDialogProps): JSX.Element {
  const { t } = useT("add-account");
  const queryClient = useQueryClient();
  const [sessions] = useState(() => new FlowSessions());
  const [method, setMethod] = useState<AddAccountMethod | null>(initialMethod ?? null);
  // A new key remounts the flow, so each visit starts from its first step.
  const [flowKey, setFlowKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Set when the user moves between the list and a flow: the clicked control unmounts, so focus
  // must move into the new step. "list:<method>" returns to the method that was open.
  const focusNext = useRef<string | null>(null);

  // Each time the dialog opens, start over at the requested method (or the list).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMethod(initialMethod ?? null);
      setFlowKey((key) => key + 1);
      setBusy(false);
    }
  }

  // Closing (by any route, including a parent setting open=false) and unmounting both reset.
  useEffect(() => {
    if (!open) return;
    return () => sessions.reset();
  }, [open, sessions]);

  const latest = useRef({ onOpenChange, onAdded });
  latest.current = { onOpenChange, onAdded };

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
      if (ids.length === 0) return;
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

  const selectMethod = useCallback(
    (next: AddAccountMethod) => {
      sessions.reset();
      focusNext.current = "flow";
      setMethod(next);
      setFlowKey((key) => key + 1);
    },
    [sessions],
  );

  const methodRef = useRef(method);
  methodRef.current = method;
  const back = useCallback(() => {
    sessions.reset();
    focusNext.current = `list:${methodRef.current ?? ""}`;
    setMethod(null);
    setBusy(false);
  }, [sessions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes.
  useEffect(() => {
    const next = focusNext.current;
    const body = bodyRef.current;
    focusNext.current = null;
    if (!next || !body) return;
    if (next.startsWith("list:")) {
      const button = body.querySelector<HTMLElement>(`[data-method="${next.slice(5)}"]`);
      (button ?? body.querySelector<HTMLElement>("[data-method]"))?.focus();
      return;
    }
    // On touch screens a focused text field opens the keyboard over the drawer, so focus the
    // step itself there; the next swipe or Tab reaches its first field.
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const target = coarse ? body : (firstStepControl(body) ?? footerSubmit(footer) ?? body);
    target.focus();
  }, [method, flowKey]);

  const cancel = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  const context = useMemo<FlowContextValue>(
    () => ({
      sessions,
      finishAdd: (refs) => void finishAdd(refs),
      setBusy,
      cancel,
      footer,
    }),
    [sessions, finishAdd, cancel, footer],
  );

  const Flow = method ? FLOWS[method] : null;
  return (
    <ResponsiveDialog
      // Hung from the top, so the title stays put while the steps change height.
      anchor="top"
      backLabel={t("common:actions.back")}
      description={t(method ? `methods.${method}.description` : "description")}
      dismissible={!busy}
      footer={
        // The flows portal their buttons in here. The box itself does not lay out: the buttons
        // are the footer's own items (one row of two on phones), and a lone Cancel spans it.
        <div
          className="contents max-sm:[&>:last-child:nth-child(odd)]:col-span-2"
          ref={setFooter}
        />
      }
      onBack={method ? back : undefined}
      onOpenChange={handleOpenChange}
      open={open}
      size="xl"
      title={method ? t(`methods.${method}.title`) : t("title")}
    >
      <div className="outline-none" ref={bodyRef} tabIndex={-1}>
        <FlowProvider value={context}>
          {Flow ? <Flow key={flowKey} /> : <MethodList onSelect={selectMethod} />}
        </FlowProvider>
      </div>
    </ResponsiveDialog>
  );
}
