import { useQuery } from "@tanstack/react-query";
import { type JSX, useRef } from "react";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-media-query";
import { accountsQuery } from "@/lib/api/accounts";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { StatusPill } from "./account-cells";
import { isApiKeyAccount, isHeld } from "./account-model";
import { BasicSection } from "./detail/basic-section";
import { MachineIdSection } from "./detail/machine-id-section";
import { ModelsSection } from "./detail/models-section";
import { OverageSection } from "./detail/overage-section";
import { ProfileSection } from "./detail/profile-section";
import { ProxySection } from "./detail/proxy-section";
import { StatisticsSection, SubscriptionSection } from "./detail/usage-sections";
import { WeightSection } from "./detail/weight-section";

/**
 * Right-side sheet from `md` up, a full-height bottom drawer below it. The account comes from the
 * list cache, so saves and refetches update it in place; each section keeps its own input state.
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
  const { t: tc } = useT();
  const isMobile = useIsMobile();
  const displayEmail = useDisplayEmail();
  const { data } = useQuery(accountsQuery());
  const account = data?.find((item) => item.id === accountId);
  const popupRef = useRef<HTMLDivElement | null>(null);

  return (
    <Sheet onOpenChange={onOpenChange} open={open && account !== undefined}>
      {/* Focus starts on the sheet itself, not the Nickname field: an input would open the
          on-screen keyboard over half the sheet on phones. Tab still reaches the first field. */}
      <SheetPopup
        className={cn("outline-none", isMobile ? "h-full" : "max-w-none sm:max-w-xl")}
        closeProps={{ "aria-label": tc("actions.close") }}
        initialFocus={popupRef}
        ref={popupRef}
        side={isMobile ? "bottom" : "right"}
      >
        <SheetHeader>
          <SheetTitle>{t("detail.title")}</SheetTitle>
          {account ? (
            <>
              <SheetDescription className="truncate">
                {displayEmail(account.email, account.id)}
              </SheetDescription>
              {/* The list's one status pill, and the ban reason in words when there is one. */}
              <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
                <StatusPill account={account} plain />
                {account.banReason && isHeld(account) ? (
                  <span className="min-w-0 text-muted-foreground text-xs">{account.banReason}</span>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-5">
          {account ? (
            <>
              <BasicSection account={account} />
              {isApiKeyAccount(account) ? null : <ProfileSection account={account} />}
              <MachineIdSection account={account} />
              <WeightSection account={account} />
              <OverageSection account={account} />
              <ProxySection account={account} />
              <SubscriptionSection account={account} />
              <StatisticsSection account={account} />
              <ModelsSection accountId={account.id} />
            </>
          ) : null}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
