import { useCallback } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import {
  confirmRelogin,
  discardRelogin,
  reloginMismatch,
  reloginOtherAccount,
} from "@/lib/api/relogin";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, AddedAccountRef } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { useFlow } from "./flow-context";
import { savedTitle } from "./result-toast";

interface FinishedLogin {
  account: AddedAccountRef;
  identityVerified?: boolean;
}

export interface ReloginFlow {
  /** The account being logged in again, or null when the dialog adds accounts. */
  target: Account | null;
  /** Sent as reloginAccountId; undefined (left out of the body) when adding. */
  accountId: string | undefined;
  /** The failure toast's key: "Could not add the account" or "Could not sign in again". */
  failedKey: "failed" | "relogin.failed";
  /** The success toast for one finished login, in either mode. */
  announce: (res: FinishedLogin) => void;
  /**
   * Handles a re-login that signed in as another user (409 relogin_identity_mismatch): asks to
   * replace the identity, then applies the waiting login (and finishes the dialog) or discards
   * it. A sign-in that is another stored account (409 relogin_other_account) only says so. True
   * when it handled the error, so the flow shows nothing else.
   */
  resolveMismatch: (error: unknown) => Promise<boolean>;
}

/** What every flow needs for re-login mode. Outside it, the hook is inert. */
export function useReloginFlow(): ReloginFlow {
  const { t } = useT("add-account");
  const display = useDisplayEmail();
  const confirm = useConfirm();
  const { relogin, finishAdd, setBusy } = useFlow();

  const announce = useCallback(
    (res: FinishedLogin) => {
      const name = display(res.account.email, res.account.id);
      if (!relogin) {
        // A login of an account already stored updates it instead of adding a copy.
        toast.success(savedTitle(t, res.account, name));
        return;
      }
      toast.success(t("relogin.success", { name }), {
        description: res.identityVerified === false ? t("relogin.unverified") : undefined,
      });
    },
    [display, relogin, t],
  );

  const resolveMismatch = useCallback(
    async (error: unknown) => {
      if (!relogin) return false;
      const other = reloginOtherAccount(error);
      if (other) {
        const name = other.otherEmail
          ? display(other.otherEmail, other.otherAccountId)
          : t("relogin.unknownUser");
        toast.error(t("relogin.otherAccount", { name }), {
          description: other.saved ? t("relogin.otherAccountSaved", { name }) : undefined,
        });
        return true;
      }
      const mismatch = reloginMismatch(error);
      if (!mismatch) return false;
      // Busy keeps the dialog open under the confirm: no outside press or Escape closes it.
      setBusy(true);
      try {
        const unknown = t("relogin.unknownUser");
        const replace = await confirm({
          title: t("relogin.mismatchTitle"),
          description: t("relogin.mismatchBody", {
            current: mismatch.currentEmail ? display(mismatch.currentEmail) : unknown,
            incoming: mismatch.incomingEmail ? display(mismatch.incomingEmail) : unknown,
          }),
          confirmLabel: t("relogin.mismatchConfirm"),
          variant: "danger",
        });
        if (!replace) {
          void discardRelogin(relogin.id, mismatch.pendingId);
          toast.info(t("relogin.mismatchDeclined"));
          return true;
        }
        try {
          const res = await confirmRelogin(relogin.id, mismatch.pendingId);
          announce(res);
          finishAdd([res.account]);
        } catch (caught) {
          toast.error(t("relogin.failed", { error: errorMessage(caught, t) }));
        }
        return true;
      } finally {
        setBusy(false);
      }
    },
    [announce, confirm, display, finishAdd, relogin, setBusy, t],
  );

  return {
    target: relogin,
    accountId: relogin?.id,
    failedKey: relogin ? "relogin.failed" : "failed",
    announce,
    resolveMismatch,
  };
}
