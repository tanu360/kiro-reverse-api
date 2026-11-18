import { useCallback } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { announce } from "@/lib/announce";
import {
  confirmRelogin,
  discardRelogin,
  reloginMismatch,
  reloginOtherAccount,
} from "@/lib/api/relogin";
import type { Account, AddedAccountRef } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import type { FlowFailure } from "./fields";
import { useFlow } from "./flow-context";
import { savedText } from "./result-text";

interface FinishedLogin {
  account: AddedAccountRef;
  identityVerified?: boolean;
}

interface ReloginFlow {
  /** The account being logged in again, or null when the dialog adds accounts. */
  target: Account | null;
  /** Sent as reloginAccountId; undefined (left out of the body) when adding. */
  accountId: string | undefined;
  /**
   * Reads out one finished login, in either mode, with an optional note after it. The dialog
   * closes onto the row it added or signed in again, so nothing else shows it.
   */
  announce: (res: FinishedLogin, note?: string) => void;
  /**
   * Handles a re-login that signed in as another user (409 relogin_identity_mismatch): asks to
   * replace the identity, then applies the waiting login (and finishes the dialog) or discards
   * it. A sign-in that is another stored account (409 relogin_other_account) only says so, through
   * `fail`, as does a failed apply. True when it handled the error, so the flow shows nothing
   * else.
   */
  resolveMismatch: (error: unknown, fail: (failure: FlowFailure) => void) => Promise<boolean>;
}

/** What every flow needs for re-login mode. Outside it, the hook is inert. */
export function useReloginFlow(): ReloginFlow {
  const { t } = useT("add-account");
  const display = useDisplayEmail();
  const confirm = useConfirm();
  const { relogin, finishAdd, setBusy } = useFlow();

  const announceLogin = useCallback(
    (res: FinishedLogin, note?: string) => {
      const name = display(res.account.email, res.account.id);
      const parts = [
        // A login of an account already stored updates it instead of adding a copy.
        relogin ? t("relogin.success", { name }) : savedText(t, res.account, name),
        note,
        relogin && res.identityVerified === false ? t("relogin.unverified") : undefined,
      ].filter((part): part is string => Boolean(part));
      announce(parts.reduce((first, second) => t("common:text.joinSentences", { first, second })));
    },
    [display, relogin, t],
  );

  const resolveMismatch = useCallback(
    async (error: unknown, fail: (failure: FlowFailure) => void) => {
      if (!relogin) return false;
      const other = reloginOtherAccount(error);
      if (other) {
        const name = other.otherEmail
          ? display(other.otherEmail, other.otherAccountId)
          : t("relogin.unknownUser");
        const first = t("relogin.otherAccount", { name });
        fail({
          error,
          message: other.saved
            ? t("common:text.joinSentences", {
                first,
                second: t("relogin.otherAccountSaved", { name }),
              })
            : first,
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
          // The admin chose this in the confirm; the flow stays as it was.
          void discardRelogin(relogin.id, mismatch.pendingId);
          announce(t("relogin.mismatchDeclined"));
          return true;
        }
        try {
          const res = await confirmRelogin(relogin.id, mismatch.pendingId);
          announceLogin(res);
          finishAdd([res.account]);
        } catch (caught) {
          fail({ error: caught });
        }
        return true;
      } finally {
        setBusy(false);
      }
    },
    [announceLogin, confirm, display, finishAdd, relogin, setBusy, t],
  );

  return {
    target: relogin,
    accountId: relogin?.id,
    announce: announceLogin,
    resolveMismatch,
  };
}
