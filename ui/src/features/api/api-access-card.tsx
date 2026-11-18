import { ShieldKeyIcon, TriangleAlertIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useRef, useState } from "react";
import { ActionError } from "@/components/shared/action-error";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard, SettingsFrame } from "@/components/shared/section-card";
import {
  SaveButton,
  SaveFooter,
  SETTINGS_ROW_X,
  SwitchField,
} from "@/components/shared/settings-rows";
import { useDraftGuard } from "@/components/shared/use-draft-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useSavedFlash } from "@/hooks/use-saved-flash";
import { announce } from "@/lib/announce";
import { apiKeysQuery } from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { settingsQuery, updateSettings } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { countEnabledKeys } from "./api-key-form";

/**
 * "Require an API key" (moved from the old Settings API card), as a Settings row. The switch is
 * a draft until Save, and leaving the page with an unsaved draft asks first.
 * The server refuses to require keys while none is enabled (409 api_key_lockout); the UI checks
 * first, so the warning shows here without a round trip.
 */
export function ApiAccessCard(): JSX.Element {
  const { t } = useT("api");
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery());
  const keys = useQuery(apiKeysQuery());
  const [draft, setDraft] = useState<boolean | null>(null);
  const [showKeyWarning, setShowKeyWarning] = useState(false);
  const savedFlash = useSavedFlash();
  const saveRef = useRef<HTMLButtonElement>(null);

  const saved = settings.data?.requireApiKey ?? false;
  const checked = draft ?? saved;
  const dirty = settings.data !== undefined && checked !== saved;

  useDraftGuard(dirty, {
    message: {
      title: t("access.discardTitle"),
      description: t("access.discardBody"),
      confirmLabel: t("access.discard"),
      cancelLabel: t("access.keepEditing"),
    },
  });

  // Save reads "Saved" for a moment, and a failure shows in the card.
  const save = useMutation({
    mutationFn: (requireApiKey: boolean) => updateSettings({ requireApiKey }),
    onMutate: () => savedFlash.clear(),
    onSuccess: (_result, requireApiKey) => {
      queryClient.setQueryData<Settings>(queryKeys.settings.general(), (old) =>
        old ? { ...old, requireApiKey } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
      setDraft(null);
      savedFlash.flash();
      announce(t("common:form.saved"));
    },
  });

  const onSave = () => {
    if (save.isPending || !dirty) return;
    // Only once the keys are loaded: while they load or failed, the count is no answer.
    if (checked && keys.data && countEnabledKeys(keys.data) === 0) {
      setShowKeyWarning(true);
      return;
    }
    setShowKeyWarning(false);
    save.mutate(checked);
  };

  const failed = save.isError && dirty;

  if (settings.isError) {
    return (
      <SectionCard icon={ShieldKeyIcon} id="api-access" title={t("access.title")}>
        <ErrorState
          compact
          error={settings.error}
          onRetry={() => void settings.refetch()}
          title={t("access.loadFailed")}
        />
      </SectionCard>
    );
  }

  // The hint follows the switch; SaveFooter's "Unsaved changes" says when it is only a draft.
  const hint = checked ? t("access.stateOn") : t("access.stateOff");

  // Title-only header, as the Settings cards: the row itself says what the switch does.
  return (
    <SettingsFrame
      footer={
        <SaveFooter
          action={
            <SaveButton
              dirty={dirty}
              onClick={onSave}
              ref={saveRef}
              saved={savedFlash.saved}
              saving={save.isPending}
              type="button"
            />
          }
          dirty={dirty}
          saving={save.isPending}
        />
      }
      icon={ShieldKeyIcon}
      id="api-access"
      title={t("access.title")}
    >
      {settings.isPending ? (
        // Skeleton rows while it loads, as the Settings sections: an unchecked switch would
        // claim a state the server may not have.
        <div aria-hidden="true" className={cn(SETTINGS_ROW_X, "flex flex-col gap-2 py-4")}>
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : (
        <SwitchField
          checked={checked}
          description={<span data-testid="api-access-state">{hint}</span>}
          disabled={save.isPending}
          onCheckedChange={(next) => {
            setDraft(next);
            setShowKeyWarning(false);
            savedFlash.clear();
            save.reset();
          }}
          title={t("access.requireApiKey")}
        >
          {showKeyWarning ? (
            <Alert className="mt-2" variant="warning">
              <HugeiconsIcon icon={TriangleAlertIcon} aria-hidden="true" />
              <AlertDescription>{t("access.enabledApiKeyRequired")}</AlertDescription>
            </Alert>
          ) : null}
          {/* The draft stays, so Try again sends it again; focus goes to Save as the notice goes. */}
          {failed ? (
            <ActionError
              className="mt-2"
              error={save.error}
              onDismiss={() => {
                save.reset();
                saveRef.current?.focus();
              }}
              onRetry={() => {
                saveRef.current?.focus();
                onSave();
              }}
            />
          ) : null}
        </SwitchField>
      )}
    </SettingsFrame>
  );
}
