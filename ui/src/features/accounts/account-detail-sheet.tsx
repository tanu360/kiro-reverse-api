import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import { accountsQuery } from "@/lib/api/accounts";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { AuthAvatar, accountMeta, StatusPill } from "./account-cells";
import { isApiKeyAccount, isHeld, supportsKiroProfiles } from "./account-model";
import { AccountSheetActions } from "./account-row-actions";
import { AccountSection } from "./detail/account-section";
import { ModelsSection } from "./detail/models-section";
import { OverageSection } from "./detail/overage-section";
import { ProfileSection } from "./detail/profile-section";
import { StatisticsSection } from "./detail/usage-sections";
import { TestAccountDialog } from "./test-account-dialog";

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
  const showProfile =
    account !== undefined &&
    !isApiKeyAccount(account) &&
    (supportsKiroProfiles(account) || account.profileArnPinned);

  return (
    <>
      <ResponsiveSheet onOpenChange={onOpenChange} open={open && account !== undefined}>
        <ResponsiveSheetHeader className={account ? "gap-4" : undefined}>
          {account ? (
            <>
              <div className="flex items-start gap-3">
                {/* Centred on the title and meta lines (48 px), and stays there over a ban reason. */}
                <AuthAvatar account={account} className="mt-1" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <ResponsiveSheetTitle className="truncate">
                    {displayEmail(account.email, account.id)}
                  </ResponsiveSheetTitle>
                  {/* The list's status pill leads the meta line, as on the phone cards. */}
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusPill account={account} plain size="sm" />
                    {meta ? (
                      <ResponsiveSheetDescription className="min-w-0 truncate">
                        {meta}
                      </ResponsiveSheetDescription>
                    ) : null}
                  </div>
                  {/* The ban reason in words, where the list puts it in the pill's tooltip. */}
                  {account.banReason && isHeld(account) ? (
                    <p className="text-meta text-muted-foreground">{account.banReason}</p>
                  ) : null}
                </div>
              </div>
              {/*
                From sm up the header keeps 56 px at its end for the close button; the actions sit
                under it, so they run out to the cards' 24 px edge instead. Phones keep 16 px.
              */}
              <AccountSheetActions
                account={account}
                className="sm:-me-8"
                onTest={() =>
                  setTest((current) => ({ open: true, session: (current?.session ?? 0) + 1 }))
                }
              />
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
    </>
  );
}
