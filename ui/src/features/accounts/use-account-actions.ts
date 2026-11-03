import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { deleteAccount, getAccountFull, refreshAccount, updateAccount } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { buildCopyJson } from "./account-model";

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

/** PUT {enabled} with an optimistic list update; an error reverts the row and toasts. */
export function useToggleEnabled(account: Account) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAccounts();
  const listKey = queryKeys.accounts.list();
  const setEnabled = (enabled: boolean) =>
    queryClient.setQueryData<Account[]>(listKey, (list) =>
      list?.map((item) => (item.id === account.id ? { ...item, enabled } : item)),
    );
  return useMutation({
    mutationFn: (enabled: boolean) => updateAccount(account.id, { enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      setEnabled(enabled);
    },
    onError: (error, enabled) => {
      setEnabled(!enabled);
      toastError(error, t);
    },
    onSettled: () => invalidate({ withStatus: true }),
  });
}

/** Token and usage refresh. The answer may lack `info` (suspended branch), so it only refetches. */
export function useRefreshAccount(accountId: string) {
  const { t } = useT("accounts");
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: () => refreshAccount(accountId),
    onSuccess: () => invalidate(),
    onError: (error) => {
      toast.error(t("refreshFailed", { reason: errorMessage(error, t) }));
    },
  });
}

/**
 * Copies the account's credentials JSON. The /full answer holds secrets: it is never cached
 * and never logged. The promise goes to copyText so Safari keeps the click's user activation.
 */
export function useCopyAccountJson(): (accountId: string) => Promise<boolean> {
  const { t } = useT("accounts");
  return useCallback(
    async (accountId) => {
      const json = getAccountFull(accountId).then((full) =>
        JSON.stringify(buildCopyJson(full), null, 2),
      );
      const ok = await copyText(json);
      if (ok) toast.success(t("copyJsonSuccess"));
      else toast.error(t("copyJsonFailed"));
      return ok;
    },
    [t],
  );
}

/** Confirms, deletes, toasts and refetches the list and the stat cards. */
export function useDeleteAccount(): (accountId: string) => Promise<void> {
  const { t } = useT("accounts");
  const confirm = useConfirm();
  const invalidate = useInvalidateAccounts();
  return useCallback(
    async (accountId) => {
      const ok = await confirm({
        title: t("confirmDelete.title"),
        description: t("confirmDelete.body"),
        confirmLabel: t("confirmDelete.confirm"),
        variant: "danger",
      });
      if (!ok) return;
      try {
        await deleteAccount(accountId);
        toast.success(t("deleteSuccess"));
      } catch (error) {
        toastError(error, t);
      }
      await invalidate({ withStatus: true });
    },
    [confirm, invalidate, t],
  );
}
