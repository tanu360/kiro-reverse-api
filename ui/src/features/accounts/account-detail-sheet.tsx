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
import { accountMeta, StatusPill } from "./account-cells";
import { isApiKeyAccount, isHeld } from "./account-model";
import { BasicSection } from "./detail/basic-section";
import { ModelsSection } from "./detail/models-section";
import { OverageSection } from "./detail/overage-section";
import { ProfileSection } from "./detail/profile-section";
import { StatisticsSection, SubscriptionSection } from "./detail/usage-sections";

/**
 * The account's detail sheet (a right sheet from `md` up, a full-height bottom sheet below it):
 * the email as the title over the nickname, plan and sign-in line, then one Settings-style card
 * per topic. The account comes from the list cache, so saves and refetches update it in place;
 * each editor keeps its own draft. Focus starts on the sheet itself (ResponsiveSheet), so no
 * phone keyboard opens over it.
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
      <ResponsiveSheetHeader>
        {account ? (
          <>
            <ResponsiveSheetTitle className="truncate">
              {displayEmail(account.email, account.id)}
            </ResponsiveSheetTitle>
            {meta ? (
              <ResponsiveSheetDescription className="truncate">{meta}</ResponsiveSheetDescription>
            ) : null}
            {/* The list's one status pill, and the ban reason in words when there is one. */}
            <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
              <StatusPill account={account} plain />
              {account.banReason && isHeld(account) ? (
                <span className="min-w-0 text-muted-foreground text-xs">{account.banReason}</span>
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
            <BasicSection account={account} />
            {isApiKeyAccount(account) ? null : <ProfileSection account={account} />}
            <OverageSection account={account} />
            <SubscriptionSection account={account} />
            <StatisticsSection account={account} />
            <ModelsSection accountId={account.id} />
          </>
        ) : null}
      </ResponsiveSheetPanel>
    </ResponsiveSheet>
  );
}
