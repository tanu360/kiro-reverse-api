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
 * The add-account wizard: a method list, then one flow. Every way out (X, Escape, backdrop,
 * Cancel, Back, success, unmount) resets the shared FlowSessions, which cancels the Microsoft
 * login, stops Builder ID polling, forgets the IAM session and drops late responses.
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
      setMethod(next);
      setFlowKey((key) => key + 1);
    },
    [sessions],
  );

  const back = useCallback(() => {
    sessions.reset();
    setMethod(null);
    setBusy(false);
  }, [sessions]);

  const cancel = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  const context = useMemo<FlowContextValue>(
    () => ({
      sessions,
      finishAdd: (refs) => void finishAdd(refs),
      setBusy,
      back,
      cancel,
      footer,
    }),
    [sessions, finishAdd, back, cancel, footer],
  );

  const Flow = method ? FLOWS[method] : null;
  return (
    <ResponsiveDialog
      description={method ? undefined : t("description")}
      dismissible={!busy}
      footer={
        <div
          className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end"
          ref={setFooter}
        />
      }
      onOpenChange={handleOpenChange}
      open={open}
      size="lg"
      title={method ? t(`methods.${method}.title`) : t("title")}
    >
      <FlowProvider value={context}>
        {Flow ? <Flow key={flowKey} /> : <MethodList onSelect={selectMethod} />}
      </FlowProvider>
    </ResponsiveDialog>
  );
}
