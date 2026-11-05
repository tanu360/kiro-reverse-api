import { TimeScheduleIcon } from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { SettingsFrame } from "@/components/shared/section-card";
import {
  SaveFooter,
  SETTINGS_ROW_X,
  SettingsRow,
  SwitchField,
} from "@/components/shared/settings-rows";
import { useDraftGuard } from "@/components/shared/use-draft-guard";
import { Field, FieldError } from "@/components/ui/field";
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
import { backupScheduleQuery, updateBackupSchedule } from "@/lib/api/backups";
import { queryKeys } from "@/lib/api/query-keys";
import { serverErrorCode } from "@/lib/api/server-errors";
import type { BackupCadence, BackupSchedule } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  CADENCES,
  clampKeep,
  KEEP_MAX,
  KEEP_MIN,
  messageParts,
  type ScheduleForm,
  scheduleDirty,
  scheduleForm,
} from "./backup-model";

/** What SettingsRow puts on its control: the row title as the name, the description. */
interface RowAria {
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** The field a 400 from POST /backups/schedule points at, from its `code`. */
type InvalidField = "cadence" | "keep";
const INVALID_FIELDS: Readonly<Record<string, InvalidField>> = {
  invalid_cadence: "cadence",
  invalid_keep: "keep",
};

function seedKey(form: ScheduleForm): string {
  return `${form.enabled}-${form.cadence}-${form.keep}`;
}

/** The cadence Select; the row's title and description name and describe its trigger. */
function FrequencySelect({
  value,
  onValueChange,
  ...aria
}: RowAria & {
  value: BackupCadence;
  onValueChange: (value: BackupCadence) => void;
}): JSX.Element {
  const { t } = useT("backups");
  const items = CADENCES.map((cadence) => ({ value: cadence, label: t(cadence) }));
  return (
    <Select
      items={items}
      onValueChange={(next) => {
        if (next) onValueChange(next as BackupCadence);
      }}
      value={value}
    >
      <SelectTrigger {...aria}>
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
  );
}

/** How many scheduled backups to keep; `id` is the input's, for the row title's label. */
function KeepField({
  id,
  value,
  onValueChange,
  ...aria
}: RowAria & {
  id: string;
  value: number | null;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      id={id}
      max={KEEP_MAX}
      min={KEEP_MIN}
      onValueChange={(next) => onValueChange(next)}
      step={1}
      value={value}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement />
        <NumberFieldInput {...aria} />
        <NumberFieldIncrement />
      </NumberFieldGroup>
    </NumberField>
  );
}

/** "Last run {time}" with a live relative time where `{time}` goes. */
function RunTime({ messageKey, value }: { messageKey: string; value: number }): JSX.Element {
  const { t } = useT("backups");
  const [before, after] = messageParts(t, messageKey, "time");
  return (
    <>
      {before}
      <RelativeTime value={value} />
      {after}
    </>
  );
}

/** The scheduler's state under the switch: the last run (or none yet) and the next one. */
function RunTimes({ schedule }: { schedule: BackupSchedule }): JSX.Element {
  const { t } = useT("backups");
  return (
    <>
      {schedule.lastRun ? <RunTime messageKey="lastRun" value={schedule.lastRun} /> : t("neverRun")}
      {schedule.nextRun ? (
        <>
          {" · "}
          <RunTime messageKey="nextRun" value={schedule.nextRun} />
        </>
      ) : null}
    </>
  );
}

function ScheduleFormCard({
  initial,
  schedule,
}: {
  initial: ScheduleForm;
  schedule: BackupSchedule;
}): JSX.Element {
  const { t } = useT("backups");
  const queryClient = useQueryClient();
  const keepId = useId();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [cadence, setCadence] = useState<BackupCadence>(initial.cadence);
  const [keep, setKeep] = useState<number | null>(initial.keep);
  // A rejected value is marked on its row (the server's 400 names it by code), not toasted.
  const [invalid, setInvalid] = useState<InvalidField | null>(null);

  // New server values (after a save or a restore) re-seed the fields in place. The form is not
  // remounted, so focus stays on Save after a save.
  const [seed, setSeed] = useState(() => seedKey(initial));
  if (seed !== seedKey(initial)) {
    setSeed(seedKey(initial));
    setEnabled(initial.enabled);
    setCadence(initial.cadence);
    setKeep(initial.keep);
    setInvalid(null);
  }

  const dirty = scheduleDirty(initial, { enabled, cadence, keep });
  useDraftGuard(dirty, {
    message: {
      title: t("discardTitle"),
      description: t("discardBody"),
      confirmLabel: t("discardAction"),
      variant: "danger",
    },
  });

  const save = useMutation({
    mutationFn: () => {
      const body = { enabled, cadence, keep: clampKeep(keep ?? Number.NaN) };
      setKeep(body.keep);
      return updateBackupSchedule(body);
    },
    onSuccess: (saved) => {
      toast.success(t("scheduleSaved"));
      // The server answers with the saved schedule (nextRun included): the form re-seeds from
      // it right away. An older server answers without one; the refetch below covers that.
      if (Object.keys(saved).length > 0) {
        queryClient.setQueryData(queryKeys.backups.schedule(), saved);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups.all });
    },
    onError: (error) => {
      const field = INVALID_FIELDS[serverErrorCode(error) ?? ""];
      if (field) setInvalid(field);
      else toastError(error, t);
    },
  });

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !save.isPending) save.mutate();
      }}
    >
      <SettingsFrame
        description={t("schedule.description")}
        footer={<SaveFooter dirty={dirty} saving={save.isPending} />}
        icon={TimeScheduleIcon}
        id="backup-schedule"
        title={t("schedule.title")}
      >
        <SwitchField
          checked={enabled}
          description={<RunTimes schedule={schedule} />}
          onCheckedChange={setEnabled}
          title={t("scheduleEnabled")}
        />
        {/* One Field round each row: it marks the control invalid and adds the error, which
            sits under the description, to the control's description. */}
        <Field className="items-stretch" invalid={invalid === "cadence"}>
          <SettingsRow
            control={
              <FrequencySelect
                onValueChange={(value) => {
                  if (invalid === "cadence") setInvalid(null);
                  setCadence(value);
                }}
                value={cadence}
              />
            }
            title={t("frequency")}
          >
            {invalid === "cadence" ? <FieldError match>{t("invalidCadence")}</FieldError> : null}
          </SettingsRow>
        </Field>
        <Field className="items-stretch" invalid={invalid === "keep"}>
          <SettingsRow
            control={
              <KeepField
                id={keepId}
                onValueChange={(value) => {
                  if (invalid === "keep") setInvalid(null);
                  setKeep(value);
                }}
                value={keep}
              />
            }
            controlWidth="number"
            description={t("keepHint")}
            htmlFor={keepId}
            title={t("keepTitle")}
          >
            {invalid === "keep" ? (
              <FieldError match>{t("invalidKeep", { min: KEEP_MIN, max: KEEP_MAX })}</FieldError>
            ) : null}
          </SettingsRow>
        </Field>
      </SettingsFrame>
    </form>
  );
}

export function ScheduleCard(): JSX.Element {
  const { t } = useT("backups");
  const query = useQuery(backupScheduleQuery());
  const schedule = query.data;

  if (schedule) return <ScheduleFormCard initial={scheduleForm(schedule)} schedule={schedule} />;

  return (
    <SettingsFrame
      description={t("schedule.description")}
      icon={TimeScheduleIcon}
      id="backup-schedule"
      title={t("schedule.title")}
    >
      {query.isError ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("scheduleLoadError")}
        />
      ) : (
        Array.from({ length: 3 }, (_, index) => (
          <div
            aria-hidden="true"
            className={cn(SETTINGS_ROW_X, "flex items-center justify-between gap-8 py-4")}
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
            key={index}
          >
            <Skeleton className="h-4 w-full max-w-40" />
            <Skeleton className="h-8 w-full max-w-72" />
          </div>
        ))
      )}
    </SettingsFrame>
  );
}
