import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { useSavedFlash } from "@/hooks/use-saved-flash";
import { announce } from "@/lib/announce";
import { deleteAccount, getAccountFull, refreshAccount, updateAccount } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import type { Account } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { type AccountFailure, useAccountFailurePlace } from "./account-failure";
import { buildCopyJson, isHeld } from "./account-model";

/** The control an action came from, for focus when its failure notice goes. */
type Target = () => HTMLElement | null | undefined;

/** Refetches the accounts list, and the stat cards when `withStatus` is set. */
export function useInvalidateAccounts(): (options?: { withStatus?: boolean }) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (options) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all }),
        options?.withStatus
          ? queryClient.invalidateQueries({ queryKey: queryKeys.status })
          : Promise.resolve(),
      ]);
    },
    [queryClient],
  );
}

/**
 * An action's failure goes to the place that shows them (the accounts card, the detail sheet,
 * the Overview's Needs attention and Accounts cards), cleared as the next action starts. Every
 * page with these actions puts them under such a place (AccountFailureProvider).
 */
function useFailures() {
  const place = useAccountFailurePlace();
  return {
    clear: () => place?.report(null),
    fail: (failure: AccountFailure) => place?.report(failure),
    fallbackFocus: place?.fallbackFocus,
  };
}

/**
 * The row as the server leaves it after PUT {enabled} (apiUpdateAccount): turning an account on
 * also lifts its hold and its silence, so it is back in rotation.
 */
function withEnabled(account: Account, enabled: boolean): Account {
  if (!enabled) return { ...account, enabled };
  return {
    ...account,
    enabled,
    silent: false,
    banStatus: isHeld(account) ? "ACTIVE" : account.banStatus,
  };
}

/**
 * PUT {enabled} with an optimistic list update; an error puts the row back as it was and is said
 * in the card, where Try again sends the same state again.
 */
export function useToggleEnabled(account: Account, target?: Target) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAccounts();
  const failures = useFailures();
  const listKey = queryKeys.accounts.list();
  const replaceRow = (next: (item: Account) => Account) =>
    queryClient.setQueryData<Account[]>(listKey, (list) =>
      list?.map((item) => (item.id === account.id ? next(item) : item)),
    );
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => updateAccount(account.id, { enabled }),
    onMutate: async (enabled) => {
      failures.clear();
      await queryClient.cancelQueries({ queryKey: listKey });
      const before = queryClient
        .getQueryData<Account[]>(listKey)
        ?.find((item) => item.id === account.id);
      replaceRow((item) => withEnabled(item, enabled));
      return { before };
    },
    onError: (error, enabled, context) => {
      const before = context?.before;
      if (before) replaceRow(() => before);
      failures.fail({
        error,
        retry: () => mutation.mutate(enabled),
        target,
        accountId: account.id,
      });
    },
    onSettled: () => invalidate({ withStatus: true }),
  });
  return mutation;
}

/**
 * Token and usage refresh. The answer may lack `info` (suspended branch), so it only refetches.
 * The row's refresh control spins meanwhile; the new expiry and status show the result. A Kiro API
 * key (`apiKey`) has no token to refresh: only its usage is read again (refreshAccountNow).
 */
export function useRefreshAccount(accountId: string, target?: Target, apiKey = false) {
  const { t } = useT("accounts");
  const invalidate = useInvalidateAccounts();
  const failures = useFailures();
  const mutation = useMutation({
    mutationFn: () => refreshAccount(accountId),
    onMutate: () => failures.clear(),
    onSuccess: () => {
      announce(t(apiKey ? "refreshUsageSuccess" : "refreshSuccess"));
      return invalidate();
    },
    onError: (error) => {
      failures.fail({ error, retry: () => mutation.mutate(), target, accountId });
    },
  });
  return mutation;
}

/**
 * Copies the account's credentials JSON. The /full answer holds secrets: it is never cached
 * and never logged. The promise goes to copyText so Safari keeps the click's user activation.
 * While it runs `copying` is set (the menu spins), then `copied` for two seconds (a tick).
 */
export function useCopyAccountJson(target?: Target): {
  copy: (accountId: string) => Promise<boolean>;
  copying: boolean;
  copied: boolean;
} {
  const { t } = useT("accounts");
  const failures = useFailures();
  const [copying, setCopying] = useState(false);
  const { saved: copied, flash, clear } = useSavedFlash();

  const copy = async (accountId: string): Promise<boolean> => {
    failures.clear();
    clear();
    let failure: unknown = null;
    const json = getAccountFull(accountId).then(
      (full) => JSON.stringify(buildCopyJson(full), null, 2),
      (error: unknown) => {
        failure = error;
        throw error;
      },
    );
    setCopying(true);
    const ok = await copyText(json);
    setCopying(false);
    if (ok) {
      flash();
      announce(t("copyJsonSuccess"));
    } else {
      // The server's reason when /full failed, else the browser refused the clipboard.
      failures.fail({
        error: failure,
        message: failure ? undefined : t("copyJsonFailed"),
        retry: () => void copy(accountId),
        target,
        accountId,
      });
    }
    return ok;
  };

  return { copy, copying, copied };
}

/** The menu of the row after this one (else before it), to take focus once the row is gone. */
function neighbourMenu(trigger: HTMLElement | null | undefined): HTMLElement | null {
  const row = trigger?.closest("tr, li");
  const next = row?.nextElementSibling ?? row?.previousElementSibling;
  return next?.querySelector<HTMLElement>("[data-account-menu]") ?? null;
}

/**
 * Confirms (naming the account), deletes and refetches the list and the stat cards. `deleting`
 * spins the row's menu; the row going away is the result. Its menu, which had focus, goes with
 * it: focus moves to the next row's menu.
 */
export function useDeleteAccount(target?: Target): {
  remove: (account: Account) => Promise<void>;
  deleting: boolean;
} {
  const { t } = useT("accounts");
  const confirm = useConfirm();
  const invalidate = useInvalidateAccounts();
  const displayEmail = useDisplayEmail();
  const failures = useFailures();
  const neighbour = useRef<HTMLElement | null>(null);

  const mutation = useMutation({
    mutationFn: (account: Account) => deleteAccount(account.id),
    onMutate: () => failures.clear(),
    onSuccess: () => announce(t("deleteSuccess")),
    onError: (error, account) => {
      failures.fail({
        error,
        retry: () => mutation.mutate(account),
        target,
        accountId: account.id,
      });
    },
    onSettled: async (_result, error) => {
      await invalidate({ withStatus: true });
      if (error) return;
      const next = neighbour.current;
      const fallback = failures.fallbackFocus;
      const own = target?.();
      // A frame later the refetched list has drawn without the row. Focus is lost on <body>, in
      // the confirm, or on the account's own menu while its detail sheet closes with it.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const lost =
          !active ||
          active === document.body ||
          active === own ||
          active.closest('[role="alertdialog"]');
        if (lost) (next?.isConnected ? next : fallback?.())?.focus();
      });
    },
  });

  const remove = async (account: Account) => {
    const ok = await confirm({
      title: t("confirmDelete.title", { email: displayEmail(account.email, account.id) }),
      description: t("confirmDelete.body"),
      confirmLabel: t("confirmDelete.confirm"),
      variant: "danger",
    });
    if (!ok) return;
    neighbour.current = neighbourMenu(target?.());
    mutation.mutate(account);
  };

  return { remove, deleting: mutation.isPending };
}
