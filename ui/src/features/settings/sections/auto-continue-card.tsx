import { useQuery } from "@tanstack/react-query";
import { type JSX, useId, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import {
  FieldErrorText,
  ROW_DESCRIPTION,
  SaveFooter,
  SectionQuery,
  SettingsRow,
  SettingsSection,
  SwitchField,
} from "./settings-section";

const MAX_CONTINUATIONS = 10;
const DEFAULT_CONTINUATIONS = 3;

export function AutoContinueCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  return (
    <SectionQuery id={SECTION_ID.autoContinue} query={query} shared title={t("autoContinue")}>
      {(settings) => <AutoContinueForm settings={settings} />}
    </SectionQuery>
  );
}

function AutoContinueForm({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  const maxId = useId();
  const draft = useDraft<{ autoContinue: boolean; autoContinueMax: number | null }>({
    autoContinue: settings.autoContinue === true,
    autoContinueMax: settings.autoContinueMax || DEFAULT_CONTINUATIONS,
  });
  const [maxInvalid, setMaxInvalid] = useState(false);
  const { save, saving } = useGeneralSettingsSave(draft);

  const onSubmit = () => {
    const { autoContinue, autoContinueMax } = draft.value;
    if (
      autoContinueMax === null ||
      !Number.isInteger(autoContinueMax) ||
      autoContinueMax < 1 ||
      autoContinueMax > MAX_CONTINUATIONS
    ) {
      setMaxInvalid(true);
      return;
    }
    save({ autoContinue, autoContinueMax });
  };

  return (
    <SettingsSection
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={() => {
            setMaxInvalid(false);
            draft.reload();
          }}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      id={SECTION_ID.autoContinue}
      onSubmit={onSubmit}
      rows
      title={t("autoContinue")}
    >
      <SettingsRow>
        <SwitchField
          checked={draft.value.autoContinue}
          hint={t("autoContinueHint")}
          label={t("autoContinueEnable")}
          learnMore={t("autoContinueMore")}
          onCheckedChange={(autoContinue) => draft.set((prev) => ({ ...prev, autoContinue }))}
        />
      </SettingsRow>
      {/* t3code's row: the label and hint on the left, the number field at the row's end. */}
      <SettingsRow className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
          <Label htmlFor={maxId}>{t("autoContinueMax")}</Label>
          <p className={ROW_DESCRIPTION} id={`${maxId}-hint`}>
            {t("autoContinueMaxHint")}
          </p>
          {maxInvalid ? (
            <FieldErrorText id={`${maxId}-error`}>
              {t("autoContinueMaxInvalid", { max: MAX_CONTINUATIONS })}
            </FieldErrorText>
          ) : null}
        </div>
        <NumberField
          allowOutOfRange
          className="w-36"
          id={maxId}
          max={MAX_CONTINUATIONS}
          min={1}
          onValueChange={(value) => {
            setMaxInvalid(false);
            draft.set((prev) => ({ ...prev, autoContinueMax: value }));
          }}
          step={1}
          value={draft.value.autoContinueMax}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput
              aria-describedby={maxInvalid ? `${maxId}-error ${maxId}-hint` : `${maxId}-hint`}
              aria-invalid={maxInvalid || undefined}
            />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
      </SettingsRow>
    </SettingsSection>
  );
}
