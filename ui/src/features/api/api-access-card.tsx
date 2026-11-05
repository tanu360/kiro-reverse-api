import { ShieldKeyIcon, TriangleAlertIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard, SettingsFrame } from "@/components/shared/section-card";
import { SaveButton, SaveFooter, SwitchField } from "@/components/shared/settings-rows";
import { useDraftGuard } from "@/components/shared/use-draft-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { apiKeysQuery } from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { settingsQuery, updateSettings } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
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

  const save = useMutation({
    mutationFn: (requireApiKey: boolean) => updateSettings({ requireApiKey }),
    onSuccess: (_result, requireApiKey) => {
      queryClient.setQueryData<Settings>(queryKeys.settings.general(), (old) =>
        old ? { ...old, requireApiKey } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
      setDraft(null);
      toast.success(t("common:toast.saved"));
    },
    onError: (error) => {
      toastError(error, t);
    },
  });

  const onSave = () => {
    if (save.isPending || !dirty) return;
    if (checked && countEnabledKeys(keys.data ?? []) === 0) {
      setShowKeyWarning(true);
      return;
    }
    setShowKeyWarning(false);
    save.mutate(checked);
  };

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

  return (
    <SettingsFrame
      description={t("access.description")}
      footer={
        <SaveFooter
          action={
            <SaveButton dirty={dirty} onClick={onSave} saving={save.isPending} type="button" />
          }
          dirty={dirty}
          saving={save.isPending}
        />
      }
      icon={ShieldKeyIcon}
      id="api-access"
      title={t("access.title")}
    >
      <SwitchField
        checked={checked}
        description={
          settings.isPending ? undefined : <span data-testid="api-access-state">{hint}</span>
        }
        disabled={settings.isPending || save.isPending}
        onCheckedChange={(next) => {
          setDraft(next);
          setShowKeyWarning(false);
        }}
        title={t("access.requireApiKey")}
      >
        {settings.isPending ? <Skeleton className="h-4 w-48" /> : null}
        {showKeyWarning ? (
          <Alert className="mt-2" variant="warning">
            <HugeiconsIcon icon={TriangleAlertIcon} aria-hidden="true" />
            <AlertDescription>{t("access.enabledApiKeyRequired")}</AlertDescription>
          </Alert>
        ) : null}
      </SwitchField>
    </SettingsFrame>
  );
}
