import { CircleCheckIcon, ScanSearchIcon, UserSwitchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type JSX, useRef, useState } from "react";
import { ActionError } from "@/components/shared/action-error";
import { ChoiceCard } from "@/components/shared/choice-card";
import { PropertyList, PropertyRow } from "@/components/shared/property-list";
import { SectionCard } from "@/components/shared/section-card";
import { SETTINGS_ROW_X } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { announce } from "@/lib/announce";
import { getAccountProfiles, setAccountProfile } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, AccountProfilesResponse } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { supportsKiroProfiles } from "../account-model";
import { useInvalidateAccounts } from "../use-account-actions";

function defaultArn(result: AccountProfilesResponse): string {
  return (result.profiles.find((profile) => profile.current) ?? result.profiles[0])?.arn ?? "";
}

/**
 * Kiro profile pinning. The sheet shows it only where profiles exist (IAM Identity Center and
 * Microsoft sign-ins), never for api_key accounts (the server answers 400). An account pinned
 * before keeps it whatever its sign-in, with loading disabled where there are no profiles, so it
 * can still return to automatic. The pressed button spins ("Verifying profile…"), the
 * rows above show the new region and mode (a screen reader hears the result), and a failure stays
 * under the profiles, where Try again sends the same choice.
 */
export function ProfileSection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const supported = supportsKiroProfiles(account);
  const invalidate = useInvalidateAccounts();
  const [selectedArn, setSelectedArn] = useState("");
  const loadRef = useRef<HTMLButtonElement | null>(null);
  const pinRef = useRef<HTMLButtonElement | null>(null);
  const unpinRef = useRef<HTMLButtonElement | null>(null);

  // Discovery runs upstream and can take up to 30 s. A new list drops a failed choice's notice:
  // its Try again would pin a profile the new list may not show as chosen.
  const load = useMutation({
    mutationFn: () => getAccountProfiles(account.id),
    onMutate: () => {
      if (pin.isError) pin.reset();
    },
    onSuccess: (result) => setSelectedArn(defaultArn(result)),
  });

  const pin = useMutation({
    mutationFn: (profileArn: string) => setAccountProfile(account.id, profileArn),
    onSuccess: (result) => {
      announce(
        result.pinned
          ? t("detail.profilePinnedTo", { region: result.region })
          : t("detail.profileAutoRestored"),
      );
      // activeRegion, profileArn and the pinned flag change; the server also clears the
      // account's model list until the next refresh.
      load.reset();
      // The list and its buttons go: focus, if it was on them, moves to Load profiles.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) loadRef.current?.focus();
      });
      return invalidate();
    },
  });

  /** The button of the failed choice: Use selected profile, or Use automatic. */
  const pinButton = () => (pin.variables === "" ? unpinRef.current : pinRef.current);

  const result = load.data;
  const choices = result && result.profiles.length > 0 ? result : null;
  return (
    <SectionCard
      actions={
        <Button
          disabled={!supported}
          loading={load.isPending}
          onClick={() => load.mutate()}
          ref={loadRef}
          size="sm"
          variant="secondary"
        >
          <HugeiconsIcon icon={ScanSearchIcon} aria-hidden="true" />
          {t("detail.profileLoad")}
        </Button>
      }
      description={supported ? t("detail.profileHint") : t("detail.profileUnsupported")}
      footer={
        // Return to automatic needs no list: a pin stays undoable when discovery fails or is empty.
        account.profileArnPinned || choices ? (
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {account.profileArnPinned ? (
              <Button
                // The pressed button stays enabled while it spins, so it keeps focus.
                disabled={pin.isPending && pin.variables !== ""}
                loading={pin.isPending && pin.variables === ""}
                onClick={() => pin.mutate("")}
                ref={unpinRef}
                size="sm"
                variant="secondary"
              >
                {t("detail.profileUnpin")}
              </Button>
            ) : null}
            {choices ? (
              <Button
                disabled={(pin.isPending && pin.variables === "") || !selectedArn}
                loading={pin.isPending && pin.variables !== ""}
                loadingText={t("detail.profileSaving")}
                onClick={() => pin.mutate(selectedArn)}
                ref={pinRef}
                size="sm"
              >
                {t("detail.profileUse")}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
      icon={UserSwitchIcon}
      slim
      title={t("detail.profile")}
    >
      <div className="min-w-0">
        <PropertyList>
          <PropertyRow
            label={t("detail.profileRegion")}
            value={account.activeRegion || "us-east-1"}
          />
          <PropertyRow
            label={t("detail.profileMode")}
            value={account.profileArnPinned ? t("detail.profilePinned") : t("detail.profileAuto")}
          />
        </PropertyList>
        {/*
         * Always in the tree, so screen readers hear the list, the wait or the error arrive. Empty
         * it takes no room; with content it sits under a hairline like the rows above it.
         */}
        <div
          aria-live="polite"
          className={cn(SETTINGS_ROW_X, "border-border-subtle not-empty:border-t not-empty:pb-4")}
        >
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
              onValueChange={(value) => {
                setSelectedArn(String(value));
                // Another choice: the failed one's notice (and its Try again) no longer applies.
                if (pin.isError) pin.reset();
              }}
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
          {pin.isError ? (
            <ActionError
              className="mt-4"
              error={pin.error}
              onDismiss={() => {
                pinButton()?.focus();
                pin.reset();
              }}
              onRetry={() => {
                pinButton()?.focus();
                pin.mutate(pin.variables ?? selectedArn);
              }}
            />
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}
