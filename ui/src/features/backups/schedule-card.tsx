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
  keepMax,
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

/**
 * How many scheduled backups to keep; `id` is the input's, for the row title's label. `max` is
 * 200, or a larger legacy keep so the field shows it as stored.
 */
function KeepField({
  id,
  value,
  max,
  onValueChange,
  ...aria
}: RowAria & {
  id: string;
  value: number | null;
  max: number;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      id={id}
      max={max}
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

/**
 * The scheduler's state under the switch: the last run (or none yet) and the next one. Each part
 * keeps to one line, so a narrow row breaks the text only at the separator.
 */
function RunTimes({ schedule }: { schedule: BackupSchedule }): JSX.Element {
  const { t } = useT("backups");
  return (
    <>
      <span className="whitespace-nowrap">
        {schedule.lastRun ? (
          <RunTime messageKey="lastRun" value={schedule.lastRun} />
        ) : (
          t("neverRun")
        )}
      </span>
      {schedule.nextRun ? (
        <>
          {" · "}
          <span className="whitespace-nowrap">
            <RunTime messageKey="nextRun" value={schedule.nextRun} />
          </span>
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
      // The stored keep goes back as is, so a legacy keep above 200 is not clamped away.
      const body = { enabled, cadence, keep: clampKeep(keep ?? Number.NaN, initial.keep) };
      setKeep(body.keep);
      return updateBackupSchedule(body);
    },
    onSuccess: ({ schedule: saved, pruneError }) => {
      // Saved either way; a failed prune leaves extra scheduled backups until the next save of
      // an enabled schedule, or its next run, retries it.
      if (pruneError) {
        toast.warning(t("schedulePruneFailed"), {
          description: t("schedulePruneFailedBody", { detail: pruneError }),
        });
      } else {
        toast.success(t("scheduleSaved"));
      }
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
                max={keepMax(initial.keep)}
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

/** A text line's placeholder: a bar centred in the line's height, `line` and `bar` sized. */
function LineSkeleton({
  line,
  bar,
  className,
}: {
  line: string;
  bar: string;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex items-center", line, className)}>
      <Skeleton className={bar} />
    </div>
  );
}

/**
 * A placeholder shaped like the SettingsRow it stands for: the title (and description) line, and
 * the control beside it once the row has room or under it before that, so the card keeps its
 * height when the schedule arrives.
 */
function RowSkeleton({
  titleWidth,
  description = false,
  control,
  nowrap = false,
  wrapsNarrow = false,
}: {
  titleWidth: string;
  description?: boolean;
  control: JSX.Element;
  nowrap?: boolean;
  /** The description takes a second line in a narrow row (a phone's). */
  wrapsNarrow?: boolean;
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        SETTINGS_ROW_X,
        "@container/settings-row flex items-center justify-between gap-x-8 gap-y-3 py-4",
        nowrap ? "flex-nowrap" : "flex-wrap",
      )}
    >
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <LineSkeleton bar={cn("h-3.5", titleWidth)} line="h-5" />
        {description ? <LineSkeleton bar="h-3 w-56 max-w-full" line="h-4.5" /> : null}
        {description && wrapsNarrow ? (
          <LineSkeleton bar="h-3 w-28" className="-mt-1 @sm/settings-row:hidden" line="h-4.5" />
        ) : null}
      </div>
      {control}
    </div>
  );
}

/** A field's placeholder at the field's height on every pointer. */
const FIELD_SKELETON = "h-9 w-full sm:h-8 pointer-coarse:h-10";

/** The three rows (switch, frequency, keep) and the Save button, before the schedule loads. */
function ScheduleSkeleton(): JSX.Element {
  return (
    <>
      <RowSkeleton
        control={<Skeleton className="h-5.5 w-9.5 shrink-0 rounded-full sm:h-4.5 sm:w-7.5" />}
        description
        nowrap
        titleWidth="w-32"
        wrapsNarrow
      />
      <RowSkeleton
        control={<Skeleton className={cn(FIELD_SKELETON, "@xl/settings-row:w-72")} />}
        titleWidth="w-20"
      />
      <RowSkeleton
        control={<Skeleton className={cn(FIELD_SKELETON, "@md/settings-row:w-36")} />}
        description
        titleWidth="w-24"
      />
    </>
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
      footer={
        query.isError ? undefined : (
          <Skeleton aria-hidden="true" className="ms-auto h-8 w-18 sm:h-7 pointer-coarse:h-9" />
        )
      }
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
        <ScheduleSkeleton />
      )}
    </SettingsFrame>
  );
}
