import { type JSX, useId, useState } from "react";
import { SettingsRow, SwitchField } from "@/components/shared/settings-rows";
import { Field, FieldError } from "@/components/ui/field";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { type Draft, useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { Hint, SaveFooter } from "./settings-section";

/** config.MaxAccountRPMLimit */
export const MAX_ACCOUNT_RPM_LIMIT = 1000;
/** The value the field offers when the limit is switched on for the first time. */
export const DEFAULT_ACCOUNT_RPM_LIMIT = 20;

/**
 * The draft is the saved setting itself, so a save commits it as is. `on` is set only while the
 * field holds a typed 0, which is not "off": the switch stays on and Save marks the field.
 */
type RpmLimitDraft = { accountRpmLimit: number | null; on?: true };

export interface RpmLimitForm {
  draft: Draft<RpmLimitDraft>;
  /** The draft's limit is on (anything but 0). */
  on: boolean;
  /** The number the field shows: the draft's limit, or the one to restore when switched on. */
  shown: number | null;
  invalid: boolean;
  saving: boolean;
  setOn: (on: boolean) => void;
  setValue: (value: number | null) => void;
  /** Validates and saves; an invalid number marks the field instead. */
  submit: () => void;
  reload: () => void;
}

function validLimit(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= MAX_ACCOUNT_RPM_LIMIT;
}

/**
 * The per-account RPM limit as a draft of the Routing card: a switch and a number, saved
 * together with the card's Save as one accountRpmLimit (0 when off). Switching off keeps the
 * number, so switching back on restores it.
 */
export function useRpmLimitForm(settings: Settings): RpmLimitForm {
  const saved = settings.accountRpmLimit ?? 0;
  const draft = useDraft<RpmLimitDraft>({ accountRpmLimit: saved });
  const [restore, setRestore] = useState<number | null>(saved > 0 ? saved : null);
  const [invalid, setInvalid] = useState(false);
  const { save, saving } = useGeneralSettingsSave(draft);
  const current = draft.value.accountRpmLimit;
  const on = draft.value.on === true || current !== 0;

  return {
    draft,
    on,
    shown: on ? current : (restore ?? DEFAULT_ACCOUNT_RPM_LIMIT),
    invalid,
    saving,
    setOn: (next) => {
      setInvalid(false);
      if (next) {
        draft.set({ accountRpmLimit: restore ?? DEFAULT_ACCOUNT_RPM_LIMIT });
        return;
      }
      // A cleared or typed-0 field has nothing worth restoring; switching on offers the default.
      setRestore(current !== null && current > 0 ? current : null);
      draft.set({ accountRpmLimit: 0 });
    },
    setValue: (value) => {
      setInvalid(false);
      draft.set(value === 0 ? { accountRpmLimit: 0, on: true } : { accountRpmLimit: value });
    },
    submit: () => {
      if (!on) {
        save({ accountRpmLimit: 0 });
        return;
      }
      if (!validLimit(current)) {
        setInvalid(true);
        return;
      }
      setRestore(current);
      save({ accountRpmLimit: current });
    },
    reload: () => {
      setInvalid(false);
      draft.reload();
    },
  };
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/**
 * The requests-per-minute number field. The row's label and description (SettingsRow puts them
 * on its control) go to the input itself, not to the field's wrapper.
 */
function PerMinuteField({
  id,
  value,
  disabled,
  onValueChange,
  ...aria
}: AriaProps & {
  id: string;
  value: number | null;
  disabled: boolean;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      allowOutOfRange
      disabled={disabled}
      id={id}
      max={MAX_ACCOUNT_RPM_LIMIT}
      min={1}
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

/** The switch and the requests-per-minute row. */
export function RpmLimitRows({ form }: { form: RpmLimitForm }): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  return (
    <>
      <SwitchField
        checked={form.on}
        description={<Hint more={t("rpmLimitMore")}>{t("rpmLimitHint")}</Hint>}
        onCheckedChange={form.setOn}
        title={t("rpmLimit")}
      />
      {/* One Field round the row: it marks the input invalid and adds the error, under the
          description, to the input's description. */}
      <Field className="items-stretch" disabled={!form.on} invalid={form.invalid}>
        <SettingsRow
          control={
            <PerMinuteField
              disabled={!form.on}
              id={id}
              onValueChange={form.setValue}
              value={form.shown}
            />
          }
          controlWidth="number"
          description={t("rpmLimitPerMinuteHint", { max: MAX_ACCOUNT_RPM_LIMIT })}
          htmlFor={id}
          title={t("rpmLimitPerMinute")}
        >
          {form.invalid ? (
            <FieldError match>{t("rpmLimitInvalid", { max: MAX_ACCOUNT_RPM_LIMIT })}</FieldError>
          ) : null}
        </SettingsRow>
      </Field>
    </>
  );
}

/** The Routing card's Save footer, for the limit (session affinity saves as it is flipped). */
export function RpmLimitFooter({ form }: { form: RpmLimitForm }): JSX.Element {
  return (
    <SaveFooter
      dirty={form.draft.dirty}
      onReload={form.reload}
      saving={form.saving}
      serverChanged={form.draft.serverChanged}
    />
  );
}
