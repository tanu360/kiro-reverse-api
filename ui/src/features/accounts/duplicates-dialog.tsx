import {
  ArchiveIcon,
  CircleCheckIcon,
  Coins01Icon,
  GitMergeIcon,
  UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { formatList, formatRelativeTime } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast, toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { STATUS_PILL } from "./account-cells";
import { authLabel, isApiKeyAccount, isBanned, isHeld } from "./account-model";

/** A group's identity across refetches: its account ids, in order. */
function groupKey(group: DuplicateGroup): string {
  return group.accounts.map((account) => account.id).join(",");
}

/**
 * Why the server does not count a copy as healthy (config.IsHealthyAccount), as the status the
 * Accounts list shows for it: banned or suspended by Kiro, switched off, or holding no token or
 * key. Null for a healthy copy. Such a copy is never suggested over a healthy one.
 */
export function unusableStatus(
  account: DuplicateAccount,
): "banned" | "suspended" | "disabled" | "noToken" | null {
  if (account.healthy) return null;
  if (isBanned(account)) return account.banStatus === "SUSPENDED" ? "suspended" : "banned";
  if (!account.enabled || account.silent || isHeld(account)) return "disabled";
  return "noToken";
}

/** "Matched by: same refresh token and same user ID", the list joined the language's way. */
function matchLine(group: DuplicateGroup, t: TFunction, lang: Lang): string {
  const reasons = formatList(
    group.reasons.map((reason) => t(`duplicates.reason.${reason}`)),
    lang,
  );
  return t("duplicates.matchedBy", { reasons });
}

/**
 * Why the copies matter, what to choose (and what a user left out keeps), what Merge does, and
 * what restoring the backup it saves first brings back, as four points.
 */
const POINTS = [
  { icon: Coins01Icon, key: "duplicates.pointCredits" },
  { icon: UserCheck01Icon, key: "duplicates.pointChoose" },
  { icon: GitMergeIcon, key: "duplicates.pointMerge" },
  { icon: ArchiveIcon, key: "duplicates.pointBackup" },
] as const;

function MergePoints(): JSX.Element {
  const { t } = useT("accounts");
  return (
    <ul className="flex flex-col gap-2 text-sm leading-normal">
      {POINTS.map((point) => (
        <li className="flex gap-2.5" key={point.key}>
          <HugeiconsIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            icon={point.icon}
          />
          <span className="min-w-0 text-pretty">{t(point.key)}</span>
        </li>
      ))}
    </ul>
  );
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
  const unusable = unusableStatus(account);
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
          {/* The Accounts list's own pill for that status: its word, colour and icon. */}
          {unusable ? (
            <Badge
              data-status={unusable}
              icon={STATUS_PILL[unusable].icon}
              size="sm"
              tone={STATUS_PILL[unusable].tone}
            >
              {t(`health.${unusable}`)}
            </Badge>
          ) : null}
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
  const { t, lang } = useT("accounts");
  const { t: tc } = useT();
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [merging, setMerging] = useState(false);
  const included = groups.filter((group) => !skipped[groupKey(group)]);
  // Every group switched on merges at once, each down to the one account it keeps.
  const removing = included.reduce((sum, group) => sum + group.accounts.length - 1, 0);

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
      // The kept account's requests today and live RPM now include the removed copies'.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.observe.accountActivity() }),
      ]);
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
            {removing > 0 ? t("duplicates.mergeCount", { count: removing }) : t("duplicates.merge")}
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      title={t("duplicates.title")}
    >
      <div className="flex flex-col gap-6">
        <MergePoints />
        {groups.map((group, index) => {
          const key = groupKey(group);
          const label = t("duplicates.groupLabel", {
            index: index + 1,
            count: group.accounts.length,
          });
          const on = !skipped[key];
          return (
            <section aria-label={label} className="flex min-w-0 flex-col gap-2" key={key}>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <h3 className="font-medium text-sm">{label}</h3>
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
                <p className="text-pretty text-muted-foreground text-xs">
                  {matchLine(group, t, lang)}
                </p>
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
