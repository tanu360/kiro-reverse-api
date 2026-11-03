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
  SaveFooter,
  SectionQuery,
  SettingsSection,
  SwitchField,
} from "./settings-section";

const MAX_CONTINUATIONS = 10;
const DEFAULT_CONTINUATIONS = 3;

export function AutoContinueCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  return (
    <SectionQuery id={SECTION_ID.autoContinue} query={query} title={t("autoContinue")}>
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
      defaultOn={false}
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
      hint={t("autoContinueHint")}
      id={SECTION_ID.autoContinue}
      learnMore={t("autoContinueMore")}
      onSubmit={onSubmit}
      title={t("autoContinue")}
    >
      <div className="flex flex-col gap-5">
        <SwitchField
          checked={draft.value.autoContinue}
          label={t("autoContinueEnable")}
          onCheckedChange={(autoContinue) => draft.set((prev) => ({ ...prev, autoContinue }))}
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor={maxId}>{t("autoContinueMax")}</Label>
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
          {maxInvalid ? (
            <FieldErrorText id={`${maxId}-error`}>
              {t("autoContinueMaxInvalid", { max: MAX_CONTINUATIONS })}
            </FieldErrorText>
          ) : null}
          <p className="text-muted-foreground text-xs" id={`${maxId}-hint`}>
            {t("autoContinueMaxHint")}
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
