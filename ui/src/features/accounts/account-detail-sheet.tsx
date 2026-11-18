import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, Suspense, useCallback, useState } from "react";
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import { TruncatedText } from "@/components/shared/truncated-text";
import { accountsQuery } from "@/lib/api/accounts";
import { serverDataText } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { LiveStatusPill } from "./account-activity";
import { AuthAvatar, accountMeta } from "./account-cells";
import {
  type AccountFailure,
  AccountFailureNotice,
  AccountFailureProvider,
  useAccountFailurePlace,
} from "./account-failure";
import { isApiKeyAccount, isHeld, supportsKiroProfiles } from "./account-model";
import { AccountSheetActions } from "./account-row-actions";
import { AccountSection } from "./detail/account-section";
import { ModelsSection } from "./detail/models-section";
import { OverageSection } from "./detail/overage-section";
import { ProfileSection } from "./detail/profile-section";
import { StatisticsSection } from "./detail/usage-sections";
import { ReloginProvider } from "./relogin-context";
import { TestAccountDialog } from "./test-account-dialog";

// "Sign in again" opens the add-account dialog over the sheet. Its code loads on first use, so the
// pages that only open this sheet (Overview, Requests) do not carry it.
// The sheet's actions are always in it while it is open, so their failure needs no other focus.
const NO_FALLBACK = () => null;

const AddAccountDialog = lazy(() =>
  import("@/features/add-account/add-account-dialog").then((module) => ({
    default: module.AddAccountDialog,
  })),
);

/**
 * The account's detail sheet (a right sheet from `md` up, a full-height bottom sheet below it):
 * the sign-in mark beside the email (the title) over the status pill and the nickname, plan and
 * sign-in line, then the row's actions (Test, Refresh token, the Enabled switch, More). Then the
 * credits, the last 24 hours and the lifetime numbers; the account's facts and its editable
 * fields in one card; overage, the Kiro profile (only for the sign-ins that have profiles) and the
 * models. The account comes from the list cache, so saves and refetches update it in place; each
 * editor keeps its own draft. Focus starts on the sheet itself (ResponsiveSheet), so no phone
 * keyboard opens over it.
 */
export function AccountDetailSheet({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const displayEmail = useDisplayEmail();
  const { data } = useQuery(accountsQuery());
  const account = data?.find((item) => item.id === accountId);
  const meta = account ? accountMeta(account, t) : "";
  // Each Test opens a fresh dialog (a new session key), over the sheet.
  const [test, setTest] = useState<{ open: boolean; session: number } | null>(null);
  // "Sign in again" works the same way, on every page that opens the sheet.
  const [relogin, setRelogin] = useState<{ open: boolean; session: number } | null>(null);
  const openRelogin = useCallback(
    () => setRelogin((current) => ({ open: true, session: (current?.session ?? 0) + 1 })),
    [],
  );
  // A failed action of the sheet's own (Refresh token, the switch, Copy JSON, Delete), said under
  // those actions.
  const [failure, setFailure] = useState<AccountFailure | null>(null);
  // The sheet's actions are the page's next actions too: as one starts, the page's notice under
  // the sheet goes as well (it may be this account's failure, out of date once this succeeds).
  const parent = useAccountFailurePlace();
  const report = useCallback(
    (next: AccountFailure | null) => {
      if (!next) parent?.report(null);
      setFailure(next);
    },
    [parent],
  );
  const showProfile =
    account !== undefined &&
    !isApiKeyAccount(account) &&
    (supportsKiroProfiles(account) || account.profileArnPinned);

  return (
    <ReloginProvider onRelogin={openRelogin}>
      <AccountFailureProvider fallbackFocus={NO_FALLBACK} report={report}>
        <ResponsiveSheet onOpenChange={onOpenChange} open={open && account !== undefined}>
          <ResponsiveSheetHeader className={account ? "gap-4" : undefined}>
            {account ? (
              <>
                <div className="flex items-start gap-3">
                  {/* Centred on the title and meta lines (48 px), and stays there over a ban reason. */}
                  <AuthAvatar account={account} className="mt-1" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    {/* A long address is cut to the sheet and shows in full in a tooltip. */}
                    <ResponsiveSheetTitle className="min-w-0">
                      <TruncatedText>{displayEmail(account.email, account.id)}</TruncatedText>
                    </ResponsiveSheetTitle>
                    {/* The list's status pill leads the meta line, as on the phone cards. */}
                    <div className="flex min-w-0 items-center gap-2">
                      <LiveStatusPill account={account} plain size="sm" />
                      {meta ? (
                        <ResponsiveSheetDescription className="min-w-0">
                          <TruncatedText>{meta}</TruncatedText>
                        </ResponsiveSheetDescription>
                      ) : null}
                    </div>
                    {/* The ban reason in words, where the list puts it in the pill's tooltip. */}
                    {account.banReason && isHeld(account) ? (
                      <p className="text-meta text-muted-foreground">
                        {serverDataText(account.banReason, t)}
                      </p>
                    ) : null}
                  </div>
                </div>
                {/*
                The header keeps 48 px at its end for the close button; the actions sit under it, so
                they run out to the cards' 16 px edge instead (a phone's header keeps no room).
              */}
                <AccountSheetActions
                  account={account}
                  className="-me-8 max-sm:me-0"
                  onTest={() =>
                    setTest((current) => ({ open: true, session: (current?.session ?? 0) + 1 }))
                  }
                />
                {failure ? (
                  // Out to the cards' edge, as the actions above it.
                  <div className="-me-8 max-sm:me-0">
                    <AccountFailureNotice
                      failure={failure}
                      fallbackFocus={NO_FALLBACK}
                      report={setFailure}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <ResponsiveSheetTitle>{t("detail.title")}</ResponsiveSheetTitle>
            )}
          </ResponsiveSheetHeader>
          <ResponsiveSheetPanel className="flex flex-col gap-4">
            {account ? (
              <>
                <StatisticsSection account={account} />
                <AccountSection account={account} />
                <OverageSection account={account} />
                {showProfile ? <ProfileSection account={account} /> : null}
                <ModelsSection accountId={account.id} />
              </>
            ) : null}
          </ResponsiveSheetPanel>
        </ResponsiveSheet>
      </AccountFailureProvider>
      {test && account ? (
        <TestAccountDialog
          account={account}
          key={`test-${test.session}`}
          onOpenChange={(next) =>
            setTest((current) => (current ? { ...current, open: next } : null))
          }
          open={test.open}
        />
      ) : null}
      {relogin && account ? (
        <Suspense fallback={null}>
          <AddAccountDialog
            key={`relogin-${relogin.session}`}
            onOpenChange={(next) =>
              setRelogin((current) => (current ? { ...current, open: next } : null))
            }
            open={relogin.open}
            relogin={account}
          />
        </Suspense>
      ) : null}
    </ReloginProvider>
  );
}
