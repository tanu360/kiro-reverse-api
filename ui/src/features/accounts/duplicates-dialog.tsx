import { CircleCheckIcon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { ChoiceCard } from "@/components/shared/choice-card";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { type DuplicateAccount, type DuplicateGroup, mergeDuplicates } from "@/lib/api/duplicates";
import { queryKeys } from "@/lib/api/query-keys";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast, toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { authLabel, isApiKeyAccount } from "./account-model";

/** A group's identity across refetches: its account ids, in order. */
function groupKey(group: DuplicateGroup): string {
  return group.accounts.map((account) => account.id).join(",");
}

function DuplicateChoice({
  account,
  suggested,
}: {
  account: DuplicateAccount;
  suggested: boolean;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const displayEmail = useDisplayEmail();
  const mono = isApiKeyAccount(account) || !account.email;
  const meta = [account.nickname, authLabel(account, t), account.region]
    .filter(Boolean)
    .join(" · ");
  const activity = [
    account.lastRefresh > 0
      ? t("duplicates.refreshed", { time: formatRelativeTime(account.lastRefresh, lang) })
      : "",
    t("duplicates.requests", { count: account.requestCount }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ChoiceCard
      control={(id) => <Radio id={id} value={account.id} />}
      description={meta}
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn("min-w-0 wrap-anywhere", mono && "font-mono text-meta")}>
            {displayEmail(account.email, account.id)}
          </span>
          {suggested ? (
            <Badge icon={CircleCheckIcon} size="sm" tone="success">
              {t("duplicates.suggested")}
            </Badge>
          ) : null}
          {account.healthy ? null : (
            <Badge icon={InformationCircleIcon} size="sm" tone="warning">
              {t("duplicates.needsAttention")}
            </Badge>
          )}
        </span>
      }
    >
      <span className="text-muted-foreground text-xs">{activity}</span>
    </ChoiceCard>
  );
}

/**
 * Lists every duplicate group with the account each keeps, the server's suggestion until the
 * operator picks another, and merges the groups left switched on, one after another. A group the
 * operator switched off (a false match) is left as it is. A group that fails stays listed after
 * the refetch; the dialog closes once every merge went through.
 */
export function DuplicatesDialog({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: DuplicateGroup[];
}): JSX.Element {
  const { t } = useT("accounts");
  const { t: tc } = useT();
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [merging, setMerging] = useState(false);
  const included = groups.filter((group) => !skipped[groupKey(group)]);

  // The operator's pick while it is still in the group, else the server's suggestion.
  const keeperOf = (group: DuplicateGroup): string => {
    const chosen = choices[groupKey(group)];
    return chosen && group.accounts.some((account) => account.id === chosen)
      ? chosen
      : group.suggestedKeepId;
  };

  const onMerge = async () => {
    if (merging || included.length === 0) return;
    setMerging(true);
    let removed = 0;
    let failed = 0;
    try {
      for (const group of included) {
        try {
          const res = await mergeDuplicates({
            keepId: keeperOf(group),
            ids: group.accounts.map((account) => account.id),
          });
          removed += res.removed.length;
        } catch (error) {
          failed += 1;
          toastError(error, t);
        }
      }
    } finally {
      await queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all });
      setMerging(false);
    }
    if (removed > 0) toast.success(t("duplicates.mergeSuccess", { count: removed }));
    if (failed === 0) onOpenChange(false);
  };

  return (
    <ResponsiveDialog
      description={t("duplicates.description")}
      dismissible={!merging}
      footer={
        <>
          <Button disabled={merging} onClick={() => onOpenChange(false)} variant="ghost">
            {tc("actions.cancel")}
          </Button>
          <Button disabled={included.length === 0} loading={merging} onClick={() => void onMerge()}>
            {t("duplicates.merge")}
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      title={t("duplicates.title")}
    >
      <div className="flex flex-col gap-6">
        {groups.map((group, index) => {
          const key = groupKey(group);
          const label = t("duplicates.groupLabel", { index: index + 1 });
          const on = !skipped[key];
          return (
            <section aria-label={label} className="flex min-w-0 flex-col gap-2" key={key}>
              <div className="flex min-w-0 items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h3 className="font-medium text-sm">{label}</h3>
                  <p className="text-muted-foreground text-xs">
                    {group.reasons.map((reason) => t(`duplicates.reason.${reason}`)).join(" · ")}
                  </p>
                </div>
                <Label className="shrink-0" variant="option">
                  <Switch
                    checked={on}
                    disabled={merging}
                    onCheckedChange={(checked) =>
                      setSkipped((current) => ({ ...current, [key]: !checked }))
                    }
                  />
                  {t("duplicates.include")}
                </Label>
              </div>
              <RadioGroup
                aria-label={t("duplicates.keepLabel", { index: index + 1 })}
                className="gap-2"
                disabled={merging || !on}
                onValueChange={(value) =>
                  setChoices((current) => ({ ...current, [key]: String(value) }))
                }
                value={keeperOf(group)}
              >
                {group.accounts.map((account) => (
                  <DuplicateChoice
                    account={account}
                    key={account.id}
                    suggested={account.id === group.suggestedKeepId}
                  />
                ))}
              </RadioGroup>
            </section>
          );
        })}
      </div>
    </ResponsiveDialog>
  );
}
