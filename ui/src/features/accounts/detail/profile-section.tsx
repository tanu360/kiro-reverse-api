import { CircleCheckIcon, ScanSearchIcon, UserSwitchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { ChoiceCard } from "@/components/shared/choice-card";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardPanel } from "@/components/ui/card";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { getAccountProfiles, setAccountProfile } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, AccountProfilesResponse } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { supportsKiroProfiles } from "../account-model";
import { useInvalidateAccounts } from "../use-account-actions";

function defaultArn(result: AccountProfilesResponse): string {
  return (result.profiles.find((profile) => profile.current) ?? result.profiles[0])?.arn ?? "";
}

/**
 * Kiro profile pinning. The caller hides it for api_key accounts (the server answers 400).
 * Builder ID and social logins have no profiles, so loading is disabled for them; a pinned
 * account keeps it, so it can still return to automatic.
 */
export function ProfileSection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const supported = supportsKiroProfiles(account) || account.profileArnPinned;
  const invalidate = useInvalidateAccounts();
  const [selectedArn, setSelectedArn] = useState("");

  // Discovery runs upstream and can take up to 30 s.
  const load = useMutation({
    mutationFn: () => getAccountProfiles(account.id),
    onSuccess: (result) => setSelectedArn(defaultArn(result)),
  });

  const pin = useMutation({
    mutationFn: (profileArn: string) => setAccountProfile(account.id, profileArn),
    onMutate: () => ({ toastId: toast.loading(t("detail.profileSaving")) }),
    onSuccess: (result, _arn, context) => {
      toast.update(context.toastId, {
        type: "success",
        title: result.pinned
          ? t("detail.profilePinnedTo", { region: result.region })
          : t("detail.profileAutoRestored"),
      });
      // activeRegion, profileArn and the pinned flag change; the server also clears the
      // account's model list until the next refresh.
      load.reset();
      return invalidate();
    },
    onError: (error, _arn, context) => {
      if (!context) return;
      toast.update(context.toastId, {
        type: "error",
        title: t("detail.saveFailed", { reason: errorMessage(error, t) }),
      });
    },
  });

  const onUseSelected = () => {
    if (!selectedArn) {
      toast.warning(t("detail.profileNone"));
      return;
    }
    pin.mutate(selectedArn);
  };

  const result = load.data;
  const choices = result && result.profiles.length > 0 ? result : null;
  return (
    <SectionCard
      actions={
        <Button
          disabled={!supported}
          loading={load.isPending}
          onClick={() => load.mutate()}
          size="sm"
          variant="secondary"
        >
          <HugeiconsIcon icon={ScanSearchIcon} aria-hidden="true" />
          {t("detail.profileLoad")}
        </Button>
      }
      description={supported ? t("detail.profileHint") : t("detail.profileUnsupported")}
      footer={
        choices ? (
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {choices.pinned ? (
              <Button
                disabled={pin.isPending}
                loading={pin.isPending && pin.variables === ""}
                onClick={() => pin.mutate("")}
                size="sm"
                variant="secondary"
              >
                {t("detail.profileUnpin")}
              </Button>
            ) : null}
            <Button
              disabled={pin.isPending}
              loading={pin.isPending && pin.variables !== ""}
              onClick={onUseSelected}
              size="sm"
            >
              {t("detail.profileUse")}
            </Button>
          </div>
        ) : undefined
      }
      icon={UserSwitchIcon}
      slim
      title={t("detail.profile")}
    >
      <CardPanel>
        <KeyValueGrid
          items={[
            { label: t("detail.profileRegion"), value: account.activeRegion || "us-east-1" },
            {
              label: t("detail.profileMode"),
              value: account.profileArnPinned ? t("detail.profilePinned") : t("detail.profileAuto"),
            },
          ]}
        />
        {/* Always in the tree, so screen readers hear the list, the wait or the error arrive. */}
        <div aria-live="polite">
          {load.isPending ? (
            <p className="mt-4 flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner aria-hidden="true" className="size-4" />
              {t("detail.profileLoading")}
            </p>
          ) : load.isError ? (
            <p className="mt-4 text-destructive-foreground text-sm" role="alert">
              {t("detail.loadFailed", { reason: errorMessage(load.error, t) })}
            </p>
          ) : result && result.profiles.length === 0 ? (
            <p className="mt-4 text-muted-foreground text-sm">{t("detail.profileNone")}</p>
          ) : result ? (
            <RadioGroup
              aria-label={t("detail.profileList")}
              className="mt-4 gap-2"
              onValueChange={(value) => setSelectedArn(String(value))}
              value={selectedArn}
            >
              {result.profiles.map((profile) => (
                <ChoiceCard
                  control={(id) => <Radio id={id} value={profile.arn} />}
                  description={profile.region}
                  key={profile.arn}
                  title={
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      {profile.name ? (
                        <span className="min-w-0 wrap-anywhere">{profile.name}</span>
                      ) : (
                        <span className="min-w-0 wrap-anywhere font-mono text-meta">
                          {profile.arn}
                        </span>
                      )}
                      {profile.current ? (
                        <Badge icon={CircleCheckIcon} size="sm" tone="success">
                          {t("detail.profileCurrent")}
                        </Badge>
                      ) : null}
                    </span>
                  }
                >
                  {profile.name ? (
                    <span className="wrap-anywhere font-mono text-meta text-muted-foreground">
                      {profile.arn}
                    </span>
                  ) : null}
                </ChoiceCard>
              ))}
            </RadioGroup>
          ) : null}
        </div>
      </CardPanel>
    </SectionCard>
  );
}
