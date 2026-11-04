import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { backupScheduleQuery, updateBackupSchedule } from "@/lib/api/backups";
import { queryKeys } from "@/lib/api/query-keys";
import type { BackupCadence, BackupSchedule } from "@/lib/api/types";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import {
  CADENCES,
  clampKeep,
  KEEP_MAX,
  KEEP_MIN,
  keepSentenceParts,
  type ScheduleForm,
  scheduleDirty,
  scheduleForm,
} from "./backup-model";

function seedKey(form: ScheduleForm): string {
  return `${form.enabled}-${form.cadence}-${form.keep}`;
}

function ScheduleFields({ initial }: { initial: ScheduleForm }): JSX.Element {
  const { t, lang } = useT("backups");
  const queryClient = useQueryClient();
  const ids = { switch: useId(), frequency: useId(), keep: useId() };
  const [enabled, setEnabled] = useState(initial.enabled);
  const [cadence, setCadence] = useState<BackupCadence>(initial.cadence);
  const [keep, setKeep] = useState<number | null>(initial.keep);

  // New server values (after a save or a restore) re-seed the fields in place. The form is not
  // remounted, so focus stays on Save after a save.
  const [seed, setSeed] = useState(() => seedKey(initial));
  if (seed !== seedKey(initial)) {
    setSeed(seedKey(initial));
    setEnabled(initial.enabled);
    setCadence(initial.cadence);
    setKeep(initial.keep);
  }

  const dirty = scheduleDirty(initial, { enabled, cadence, keep });

  const save = useMutation({
    mutationFn: () => {
      const body = { enabled, cadence, keep: clampKeep(keep ?? Number.NaN) };
      setKeep(body.keep);
      return updateBackupSchedule(body);
    },
    onSuccess: () => {
      toast.success(t("scheduleSaved"));
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups.all });
    },
    onError: (error) => toastError(error, t),
  });

  const [before, after] = keepSentenceParts(t, lang, clampKeep(keep ?? Number.NaN));
  const items = CADENCES.map((value) => ({ value, label: t(value) }));

  return (
    <form
      className="grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(11rem,1fr)_minmax(10rem,12rem)_auto_auto] lg:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !save.isPending) save.mutate();
      }}
    >
      <div className="flex min-h-10 items-center lg:min-h-9">
        <Label className="cursor-pointer" htmlFor={ids.switch}>
          <Switch checked={enabled} id={ids.switch} onCheckedChange={setEnabled} />
          {t("scheduleEnabled")}
        </Label>
      </div>

      <div className="flex flex-col gap-2">
        <Label id={ids.frequency}>{t("frequency")}</Label>
        <Select
          items={items}
          onValueChange={(value) => {
            if (value) setCadence(value as BackupCadence);
          }}
          value={cadence}
        >
          <SelectTrigger aria-labelledby={ids.frequency} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span aria-hidden="true">{before}</span>
        <NumberField
          className="w-32"
          id={ids.keep}
          max={KEEP_MAX}
          min={KEEP_MIN}
          onValueChange={(value) => setKeep(value)}
          step={1}
          value={keep}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput aria-label={t("keepAria")} />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
        <span aria-hidden="true">{after}</span>
      </div>

      {/* aria-disabled, not disabled: a clean or saving form keeps Save focusable. */}
      <Button
        aria-busy={save.isPending || undefined}
        aria-disabled={!dirty || save.isPending || undefined}
        className="w-full aria-disabled:pointer-events-none sm:w-auto"
        type="submit"
      >
        {save.isPending ? <Spinner aria-hidden="true" /> : null}
        {save.isPending ? t("common:actions.saving") : t("common:actions.save")}
      </Button>
    </form>
  );
}

function LastRun({ schedule }: { schedule: BackupSchedule }): JSX.Element {
  const { t, lang } = useT("backups");
  if (!schedule.lastRun) {
    return <span className="text-muted-foreground text-sm">{t("neverRun")}</span>;
  }
  return (
    <span className="text-muted-foreground text-sm" title={formatDateTime(schedule.lastRun, lang)}>
      {t("lastRun", { time: formatRelativeTime(schedule.lastRun, lang) })}
    </span>
  );
}

export function ScheduleCard(): JSX.Element {
  const { t } = useT("backups");
  const query = useQuery(backupScheduleQuery());
  const schedule = query.data;
  const initial = schedule ? scheduleForm(schedule) : null;

  return (
    <SectionCard
      actions={schedule ? <LastRun schedule={schedule} /> : null}
      description={t("common:text.joinSentences", {
        first: t("schedule.description"),
        second: t("keepHint"),
      })}
      id="backup-schedule"
      title={t("schedule.title")}
    >
      {initial ? (
        <ScheduleFields initial={initial} />
      ) : query.isError ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("scheduleLoadError")}
        />
      ) : (
        <div aria-busy="true" className="grid gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
            <Skeleton className="h-9 w-full" key={index} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
