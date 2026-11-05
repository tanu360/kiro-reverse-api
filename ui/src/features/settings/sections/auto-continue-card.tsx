import { useQuery } from "@tanstack/react-query";
import { type JSX, useId, useState } from "react";
import { Code } from "@/components/shared/code";
import { SettingsRow, SwitchField } from "@/components/shared/settings-rows";
import { Field, FieldError } from "@/components/ui/field";
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
import { fillNodes, Hint, SaveFooter, SectionQuery, SettingsSection } from "./settings-section";

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

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/**
 * The continuations number field. The row's label and description (SettingsRow puts them on its
 * control) go to the input itself, not to the field's wrapper.
 */
function ContinuationsField({
  id,
  value,
  onValueChange,
  ...aria
}: AriaProps & {
  id: string;
  value: number | null;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      allowOutOfRange
      id={id}
      max={MAX_CONTINUATIONS}
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
      title={t("autoContinue")}
    >
      <SwitchField
        checked={draft.value.autoContinue}
        description={<Hint more={t("autoContinueMore")}>{t("autoContinueHint")}</Hint>}
        onCheckedChange={(autoContinue) => draft.set((prev) => ({ ...prev, autoContinue }))}
        title={t("autoContinueEnable")}
      />
      {/* One Field round the row: it marks the input invalid and adds the error, which sits
          under the description, to the input's description. */}
      <Field className="items-stretch" invalid={maxInvalid}>
        <SettingsRow
          control={
            <ContinuationsField
              id={maxId}
              onValueChange={(value) => {
                setMaxInvalid(false);
                draft.set((prev) => ({ ...prev, autoContinueMax: value }));
              }}
              value={draft.value.autoContinueMax}
            />
          }
          controlWidth="number"
          description={fillNodes(t("autoContinueMaxHint"), { param: <Code>max_tokens</Code> })}
          htmlFor={maxId}
          title={t("autoContinueMax")}
        >
          {maxInvalid ? (
            <FieldError match>{t("autoContinueMaxInvalid", { max: MAX_CONTINUATIONS })}</FieldError>
          ) : null}
        </SettingsRow>
      </Field>
    </SettingsSection>
  );
}
