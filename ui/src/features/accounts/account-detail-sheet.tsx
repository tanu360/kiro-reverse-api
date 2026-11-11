import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
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
import { isApiKeyAccount, isHeld } from "./account-model";
import { BasicSection } from "./detail/basic-section";
import { ModelsSection } from "./detail/models-section";
import { OverageSection } from "./detail/overage-section";
import { ProfileSection } from "./detail/profile-section";
import { StatisticsSection, SubscriptionSection } from "./detail/usage-sections";

/**
 * The account's detail sheet (a right sheet from `md` up, a full-height bottom sheet below it):
 * the sign-in mark beside the email (the title) over the status pill and the nickname, plan and
 * sign-in line; then the credits and lifetime numbers, then one Settings-style card per topic,
 * its facts as label and value rows. The account comes from the list cache, so saves and
 * refetches update it in place; each editor keeps its own draft. Focus starts on the sheet
 * itself (ResponsiveSheet), so no phone keyboard opens over it.
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

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open && account !== undefined}>
      <ResponsiveSheetHeader className={account ? "flex-row items-start gap-3" : undefined}>
        {account ? (
          <>
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
          </>
        ) : (
          <ResponsiveSheetTitle>{t("detail.title")}</ResponsiveSheetTitle>
        )}
      </ResponsiveSheetHeader>
      <ResponsiveSheetPanel className="flex flex-col gap-4">
        {account ? (
          <>
            <StatisticsSection account={account} />
            <BasicSection account={account} />
            <SubscriptionSection account={account} />
            <OverageSection account={account} />
            {isApiKeyAccount(account) ? null : <ProfileSection account={account} />}
            <ModelsSection accountId={account.id} />
          </>
        ) : null}
      </ResponsiveSheetPanel>
    </ResponsiveSheet>
  );
}
