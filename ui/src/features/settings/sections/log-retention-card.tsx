import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, type JSX, type ReactNode, useId, useState } from "react";
import { RelativeTime } from "@/components/shared/relative-time";
import { SettingsRow } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { Field, FieldError } from "@/components/ui/field";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import {
  type LogRetention,
  type LogRetentionUpdate,
  logRetentionQuery,
  updateLogRetention,
} from "@/lib/api/log-retention";
import { queryKeys } from "@/lib/api/query-keys";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { SECTION_ID } from "./sections";
import {
  fillNodes,
  Hint,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  useSectionSave,
} from "./settings-section";

export function LogRetentionCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(logRetentionQuery());
  return (
    <SectionQuery id={SECTION_ID.logRetention} query={query} title={t("logRetention")}>
      {(retention) => <LogRetentionForm retention={retention} />}
    </SectionQuery>
  );
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/**
 * The days field, 0 to the server's maximum, 0 keeping every entry. The row's label and
 * description go to the input, not the field's wrapper.
 */
function DaysField({
  id,
  max,
  value,
  onValueChange,
  ...aria
}: AriaProps & {
  id: string;
  max: number;
  value: number | null;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      allowOutOfRange
      id={id}
      max={max}
      min={0}
      onValueChange={onValueChange}
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

/** The days as the server has them; 0 keeps every entry forever. */
function serverDraft(retention: LogRetention): { days: number | null } {
  return { days: retention.days };
}

function LogRetentionForm({ retention }: { retention: LogRetention }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const daysId = useId();
  const draft = useDraft(serverDraft(retention));
  const [daysInvalid, setDaysInvalid] = useState(false);
  const { save, saving } = useSectionSave((body: LogRetentionUpdate) => updateLogRetention(body), {
    onSaved: ({ days }) => {
      draft.commit({ days });
      queryClient.setQueryData<LogRetention>(queryKeys.settings.logRetention(), (old) =>
        old ? { ...old, days } : old,
      );
      // The save starts a prune; the status lines follow on its settings_changed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.logRetention() });
    },
  });

  const onSubmit = () => {
    const { days } = draft.value;
    if (days === null || !Number.isInteger(days) || days < 0 || days > retention.maxDays) {
      setDaysInvalid(true);
      return;
    }
    save({ days });
  };

  return (
    <SettingsSection
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={() => {
            setDaysInvalid(false);
            draft.reload();
          }}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      id={SECTION_ID.logRetention}
      onSubmit={onSubmit}
      title={t("logRetention")}
    >
      {/* One Field round the row: it marks the input invalid and adds the error, which sits
          under the description, to the input's description. */}
      <Field className="items-stretch" invalid={daysInvalid}>
        <SettingsRow
          control={
            <DaysField
              id={daysId}
              max={retention.maxDays}
              onValueChange={(days) => {
                setDaysInvalid(false);
                draft.set((prev) => ({ ...prev, days }));
              }}
              value={draft.value.days}
            />
          }
          controlWidth="number"
          description={
            <Hint more={t("logRetentionMore")}>
              {t("logRetentionDaysHint", { max: retention.maxDays })}
            </Hint>
          }
          htmlFor={daysId}
          status={
            draft.value.days === 0 ? (
              <Badge size="sm" tone="neutral">
                {t("logRetentionForever")}
              </Badge>
            ) : null
          }
          title={t("logRetentionDays")}
        >
          {daysInvalid ? (
            <FieldError match>
              {t("logRetentionDaysInvalid", { max: retention.maxDays })}
            </FieldError>
          ) : null}
        </SettingsRow>
      </Field>
      <SettingsRow
        description={<LogStatus retention={retention} />}
        title={t("logRetentionStatus")}
      />
    </SettingsSection>
  );
}

/**
 * The pruning job's state: the last cleanup and what it removed (or none yet), the oldest entry
 * left and how many removed requests the totals still count. The times keep to one line.
 */
function LogStatus({ retention }: { retention: LogRetention }): JSX.Element {
  const { t, lang } = useT("settings");
  const removed = retention.lastPrunedRequests + retention.lastPrunedErrors;
  const parts: Array<{ key: string; node: ReactNode }> = [];
  if (retention.lastRunAt) {
    parts.push({
      key: "last-run",
      node: fillNodes(t("logRetentionLastRun"), {
        time: <RelativeTime value={retention.lastRunAt} />,
      }),
    });
    parts.push({
      key: "removed",
      node: t("logRetentionRemoved", { count: removed, n: formatNumber(removed, lang) }),
    });
  } else {
    parts.push({ key: "never", node: t("logRetentionNeverRun") });
  }
  if (retention.oldestRequestTs) {
    parts.push({
      key: "oldest",
      node: fillNodes(t("logRetentionOldest"), {
        time: <RelativeTime value={retention.oldestRequestTs} />,
      }),
    });
  }
  if (retention.archivedRequests) {
    parts.push({
      key: "archived",
      node: t("logRetentionArchived", {
        count: retention.archivedRequests,
        n: formatNumber(retention.archivedRequests, lang),
      }),
    });
  }
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i > 0 ? " · " : null}
          {part.node}
        </Fragment>
      ))}
    </>
  );
}
