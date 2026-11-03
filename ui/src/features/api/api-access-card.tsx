import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { LockKeyholeIcon, LockKeyholeOpenIcon, TriangleAlertIcon } from "lucide-react";
import { type JSX, useEffect, useId, useRef, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiKeysQuery } from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { settingsQuery, updateSettings } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { countEnabledKeys } from "./api-key-form";

/**
 * "Require an API key" (moved from the old Settings API card). The switch is a draft until Save,
 * and leaving the page with an unsaved draft asks first.
 * The server does not check for an enabled key, so the UI refuses to require one without it.
 */
export function ApiAccessCard(): JSX.Element {
  const { t } = useT("api");
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const settings = useQuery(settingsQuery());
  const keys = useQuery(apiKeysQuery());
  const [draft, setDraft] = useState<boolean | null>(null);
  const [showKeyWarning, setShowKeyWarning] = useState(false);
  const labelId = useId();
  const stateId = useId();
  const switchRef = useRef<HTMLElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  // Save turns disabled once the draft is saved; focus then moves to the switch, not <body>.
  const refocusSwitch = useRef(false);

  const saved = settings.data?.requireApiKey ?? false;
  const checked = draft ?? saved;
  const dirty = settings.data !== undefined && checked !== saved;

  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: () => dirty,
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      const discard = await confirm({
        title: t("access.discardTitle"),
        description: t("access.discardBody"),
        confirmLabel: t("access.discard"),
        cancelLabel: t("access.keepEditing"),
      });
      return !discard;
    },
  });

  const save = useMutation({
    mutationFn: (requireApiKey: boolean) => updateSettings({ requireApiKey }),
    onSuccess: (_result, requireApiKey) => {
      refocusSwitch.current = document.activeElement === saveRef.current;
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

  useEffect(() => {
    if (save.isPending || !refocusSwitch.current) return;
    refocusSwitch.current = false;
    switchRef.current?.focus();
  }, [save.isPending]);

  const onSave = () => {
    if (save.isPending) return;
    if (checked && countEnabledKeys(keys.data ?? []) === 0) {
      setShowKeyWarning(true);
      return;
    }
    setShowKeyWarning(false);
    save.mutate(checked);
  };

  if (settings.isError) {
    return (
      <SectionCard id="api-access" title={t("access.title")}>
        <ErrorState
          compact
          error={settings.error}
          onRetry={() => void settings.refetch()}
          title={t("access.loadFailed")}
        />
      </SectionCard>
    );
  }

  const StateIcon = saved ? LockKeyholeIcon : LockKeyholeOpenIcon;

  return (
    <SectionCard
      description={t("access.description")}
      footer={
        // Same footer as the settings cards: Save on the right.
        <div className="flex w-full justify-end">
          <Button
            aria-disabled={save.isPending || undefined}
            disabled={!dirty && !save.isPending}
            onClick={onSave}
            ref={saveRef}
          >
            {save.isPending ? t("common:actions.saving") : t("common:actions.save")}
          </Button>
        </div>
      }
      id="api-access"
      title={t("access.title")}
    >
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label className="w-fit cursor-pointer gap-3 pointer-coarse:min-h-10">
            <Switch
              aria-describedby={stateId}
              aria-labelledby={labelId}
              checked={checked}
              disabled={settings.isPending || save.isPending}
              onCheckedChange={(next) => {
                setDraft(next);
                setShowKeyWarning(false);
              }}
              ref={switchRef}
            />
            <span id={labelId}>{t("access.requireApiKey")}</span>
          </Label>
          <div className="flex min-w-0 flex-col gap-1">
            {settings.isPending ? (
              <Skeleton className="h-4 w-48" />
            ) : (
              <p
                className="flex items-center gap-1.5 text-muted-foreground text-sm"
                data-testid="api-access-state"
                id={stateId}
              >
                <StateIcon aria-hidden="true" className="size-3.5 shrink-0" />
                {saved ? t("access.stateOn") : t("access.stateOff")}
              </p>
            )}
          </div>
        </div>
        {showKeyWarning ? (
          <Alert variant="warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription>{t("access.enabledApiKeyRequired")}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </SectionCard>
  );
}
