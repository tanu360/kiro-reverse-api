import { Alert02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { RelativeTime } from "@/components/shared/relative-time";
import { ROW_DESCRIPTION, SettingsRow, SwitchField } from "@/components/shared/settings-rows";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { announce } from "@/lib/announce";
import {
  type AccountHealth,
  accountHealthKey,
  accountHealthQuery,
  resumeAccountHealth,
  SELF_HEAL_INTERVAL_MAX,
  SELF_HEAL_INTERVAL_MIN,
  SELF_HEAL_ROUNDS_MAX,
  type SelfHealState,
  updateAccountHealth,
} from "@/lib/api/account-health";
import { formatDuration, formatNumber } from "@/lib/format";
import { fillNodes, useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { SECTION_ID } from "./sections";
import {
  Hint,
  RowActionError,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  useSectionSave,
} from "./settings-section";

export function SelfHealCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(accountHealthQuery());
  return (
    <SectionQuery id={SECTION_ID.selfHeal} query={query} title={t("selfHeal")}>
      {(health) => <SelfHealForm health={health} />}
    </SectionQuery>
  );
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/**
 * A whole-number field. The row's label and description (SettingsRow puts them on its control)
 * go to the input itself, not to the field's wrapper.
 */
function WholeNumberField({
  id,
  min,
  max,
  value,
  onValueChange,
  ...aria
}: AriaProps & {
  id: string;
  min: number;
  max: number;
  value: number | null;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      allowOutOfRange
      id={id}
      max={max}
      min={min}
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

interface SelfHealDraft {
  enabled: boolean;
  minIntervalSec: number | null;
  maxRounds: number | null;
}

function inRange(value: number | null, min: number, max: number): value is number {
  return value !== null && Number.isInteger(value) && value >= min && value <= max;
}

function SelfHealForm({ health }: { health: AccountHealth }): JSX.Element {
  const { t, lang } = useT("settings");
  const queryClient = useQueryClient();
  const intervalId = useId();
  const roundsId = useId();
  const draft = useDraft<SelfHealDraft>({
    enabled: health.enabled,
    minIntervalSec: health.minIntervalSec,
    maxRounds: health.maxRounds,
  });
  const [intervalInvalid, setIntervalInvalid] = useState(false);
  const [roundsInvalid, setRoundsInvalid] = useState(false);
  const { save, feedback } = useSectionSave(
    (body: { enabled: boolean; minIntervalSec: number; maxRounds: number }) =>
      updateAccountHealth(body),
    {
      onSaved: (sent) => {
        draft.commit(sent);
        void queryClient.invalidateQueries({ queryKey: accountHealthKey });
      },
    },
  );

  // The seconds typed so far as a duration ("5m", "1h 15m"), every unit shown so it reads what
  // was typed (3661 is "1h 1m 1s"); nothing while they are not valid.
  const interval = draft.value.minIntervalSec;
  const intervalText = inRange(interval, SELF_HEAL_INTERVAL_MIN, SELF_HEAL_INTERVAL_MAX)
    ? formatDuration(interval, lang, "narrow", 4)
    : null;
  // The range grouped the way the field shows its number ("86,400", "86.400").
  const intervalRange = {
    min: formatNumber(SELF_HEAL_INTERVAL_MIN, lang),
    max: formatNumber(SELF_HEAL_INTERVAL_MAX, lang),
  };

  const onSubmit = () => {
    const { enabled, minIntervalSec, maxRounds } = draft.value;
    const intervalOk = inRange(minIntervalSec, SELF_HEAL_INTERVAL_MIN, SELF_HEAL_INTERVAL_MAX);
    const roundsOk = inRange(maxRounds, 0, SELF_HEAL_ROUNDS_MAX);
    setIntervalInvalid(!intervalOk);
    setRoundsInvalid(!roundsOk);
    if (!intervalOk || !roundsOk) return;
    save({ enabled, minIntervalSec, maxRounds });
  };

  return (
    <SettingsSection
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={() => {
            setIntervalInvalid(false);
            setRoundsInvalid(false);
            draft.reload();
          }}
          feedback={feedback}
          serverChanged={draft.serverChanged}
        />
      }
      id={SECTION_ID.selfHeal}
      onSubmit={onSubmit}
      title={t("selfHeal")}
    >
      <SwitchField
        checked={draft.value.enabled}
        description={<Hint more={t("selfHeal.more")}>{t("selfHeal.hint")}</Hint>}
        onCheckedChange={(enabled) => draft.set((prev) => ({ ...prev, enabled }))}
        title={t("selfHeal.enable")}
      />
      {/* One Field round each number row: it marks the input invalid and adds the error, which
          sits under the description, to the input's description. */}
      <Field className="items-stretch" invalid={intervalInvalid}>
        <SettingsRow
          control={
            <WholeNumberField
              id={intervalId}
              max={SELF_HEAL_INTERVAL_MAX}
              min={SELF_HEAL_INTERVAL_MIN}
              onValueChange={(minIntervalSec) => {
                setIntervalInvalid(false);
                draft.set((prev) => ({ ...prev, minIntervalSec }));
              }}
              value={draft.value.minIntervalSec}
            />
          }
          controlWidth="number"
          description={t("selfHeal.intervalHint", intervalRange)}
          htmlFor={intervalId}
          title={t("selfHeal.interval")}
        >
          {intervalText && !intervalInvalid ? (
            <p className={ROW_DESCRIPTION}>
              {t("selfHeal.intervalDuration", { duration: intervalText })}
            </p>
          ) : null}
          {intervalInvalid ? (
            <FieldError match>{t("selfHeal.intervalInvalid", intervalRange)}</FieldError>
          ) : null}
        </SettingsRow>
      </Field>
      <Field className="items-stretch" invalid={roundsInvalid}>
        <SettingsRow
          control={
            <WholeNumberField
              id={roundsId}
              max={SELF_HEAL_ROUNDS_MAX}
              min={0}
              onValueChange={(maxRounds) => {
                setRoundsInvalid(false);
                draft.set((prev) => ({ ...prev, maxRounds }));
              }}
              value={draft.value.maxRounds}
            />
          }
          controlWidth="number"
          description={t("selfHeal.roundsHint", { max: SELF_HEAL_ROUNDS_MAX })}
          htmlFor={roundsId}
          title={t("selfHeal.rounds")}
        >
          {roundsInvalid ? (
            <FieldError match>
              {t("selfHeal.roundsInvalid", { max: SELF_HEAL_ROUNDS_MAX })}
            </FieldError>
          ) : null}
        </SettingsRow>
      </Field>
      <HealStatusRow maxRounds={health.maxRounds} state={health.state} />
    </SettingsSection>
  );
}

/**
 * The last heal and the rounds used since the last successful request, from the saved settings.
 * A halt adds a warning with Resume.
 */
function HealStatusRow({
  state,
  maxRounds,
}: {
  state: SelfHealState;
  maxRounds: number;
}): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const resumeRef = useRef<HTMLButtonElement>(null);
  const resumed = useRef(false);
  // The warning goes once the refetch says it is running again; a failure shows under it.
  const resume = useMutation({
    mutationFn: resumeAccountHealth,
    onSuccess: () => {
      resumed.current = true;
      announce(t("selfHeal.resumed"));
      void queryClient.invalidateQueries({ queryKey: accountHealthKey });
    },
  });
  // Resume goes with the warning: focus, left on the page, moves on to the card's Save.
  useEffect(() => {
    if (state.halted || !resumed.current) return;
    resumed.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    document
      .getElementById(SECTION_ID.selfHeal)
      ?.querySelector<HTMLElement>('[data-slot="card-footer"] button[type="submit"]')
      ?.focus();
  }, [state.halted]);

  let description: ReactNode = t("selfHeal.never");
  if (state.lastHealAt > 0) {
    // {time} stays a placeholder through t() and becomes a live relative time.
    const lastHeal = fillNodes(t("selfHeal.lastHeal", { count: state.lastHealed }), {
      time: <RelativeTime value={state.lastHealAt} />,
    });
    const used =
      maxRounds > 0
        ? t("selfHeal.roundsUsed", { count: maxRounds, used: state.rounds, max: maxRounds })
        : t("selfHeal.roundsUsedUnlimited", { count: state.rounds });
    description = fillNodes(t("common:text.joinSentences"), { first: lastHeal, second: used });
  }

  return (
    <SettingsRow
      description={description}
      notice={
        state.halted && resume.isError ? (
          <RowActionError
            error={resume.error}
            focusTarget={resumeRef}
            onDismiss={resume.reset}
            onRetry={() => resume.mutate()}
          />
        ) : null
      }
      title={t("selfHeal.status")}
    >
      {state.halted ? (
        <Alert role="status" variant="warning">
          <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
          <AlertDescription>{t("selfHeal.halted")}</AlertDescription>
          <AlertAction>
            <Button
              loading={resume.isPending}
              onClick={() => resume.mutate()}
              ref={resumeRef}
              size="sm"
              variant="tone"
            >
              <HugeiconsIcon icon={PlayIcon} aria-hidden="true" />
              {t("selfHeal.resume")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </SettingsRow>
  );
}
