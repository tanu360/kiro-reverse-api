import { useMutation } from "@tanstack/react-query";
import { ScanSearchIcon } from "lucide-react";
import { type JSX, useState } from "react";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { getAccountProfiles, setAccountProfile } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, AccountProfilesResponse } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useInvalidateAccounts } from "../use-account-actions";
import { DetailSection, TOUCH_BUTTON } from "./detail-section";

function defaultArn(result: AccountProfilesResponse): string {
  return (result.profiles.find((profile) => profile.current) ?? result.profiles[0])?.arn ?? "";
}

/** Kiro profile pinning. The caller hides it for api_key accounts (the server answers 400). */
export function ProfileSection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
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
  return (
    <DetailSection
      actions={
        <Button
          loading={load.isPending}
          onClick={() => load.mutate()}
          className={TOUCH_BUTTON}
          size="sm"
          variant="outline"
        >
          <ScanSearchIcon aria-hidden="true" />
          {t("detail.profileLoad")}
        </Button>
      }
      title={t("detail.profile")}
    >
      <KeyValueGrid
        items={[
          { label: t("detail.profileRegion"), value: account.activeRegion || "us-east-1" },
          {
            label: t("detail.profileMode"),
            value: account.profileArnPinned ? t("detail.profilePinned") : t("detail.profileAuto"),
          },
        ]}
      />
      <p className="text-muted-foreground text-xs">{t("detail.profileHint")}</p>
      <div aria-live="polite" className="flex flex-col gap-3">
        {load.isPending ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner aria-hidden="true" className="size-4" />
            {t("detail.profileLoading")}
          </p>
        ) : load.isError ? (
          <p className="text-destructive-foreground text-sm" role="alert">
            {t("detail.loadFailed", { reason: errorMessage(load.error, t) })}
          </p>
        ) : result && result.profiles.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("detail.profileNone")}</p>
        ) : result ? (
          <>
            <RadioGroup
              aria-label={t("detail.profileList")}
              className="gap-2"
              onValueChange={(value) => setSelectedArn(String(value))}
              value={selectedArn}
            >
              {result.profiles.map((profile) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the Radio inside is the control.
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-ring has-data-checked:bg-accent/40"
                  key={profile.arn}
                >
                  <Radio className="mt-0.5" value={profile.arn} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 font-medium text-sm">
                      <span className="break-all">{profile.name || profile.arn}</span>
                      {profile.current ? (
                        <Badge variant="success">{t("detail.profileCurrent")}</Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground text-xs">{profile.region}</span>
                    {profile.name ? (
                      <span className="break-all font-mono text-muted-foreground text-xs">
                        {profile.arn}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </RadioGroup>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pin.isPending}
                loading={pin.isPending && pin.variables !== ""}
                onClick={onUseSelected}
                className={TOUCH_BUTTON}
                size="sm"
              >
                {t("detail.profileUse")}
              </Button>
              {result.pinned ? (
                <Button
                  disabled={pin.isPending}
                  loading={pin.isPending && pin.variables === ""}
                  onClick={() => pin.mutate("")}
                  className={TOUCH_BUTTON}
                  size="sm"
                  variant="outline"
                >
                  {t("detail.profileUnpin")}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </DetailSection>
  );
}
