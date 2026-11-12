import { useQuery } from "@tanstack/react-query";
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
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import { Hint, SaveFooter, SectionQuery, SettingsSection } from "./settings-section";

/** Mirrors config/image_resize.go. */
const DIMENSION = { min: 256, max: 4096, step: 32, fallback: 1568 } as const;
const SIZE_KB = { min: 50, max: 4096, step: 50, fallback: 400 } as const;

type Limit = typeof DIMENSION | typeof SIZE_KB;

function inRange(value: number | null, limit: Limit): value is number {
  return value !== null && Number.isInteger(value) && value >= limit.min && value <= limit.max;
}

export function ImageResizeCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  return (
    <SectionQuery id={SECTION_ID.imageResize} query={query} shared title={t("imageResize")}>
      {(settings) => <ImageResizeForm settings={settings} />}
    </SectionQuery>
  );
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/**
 * One limit's number field. The row's label and description (SettingsRow puts them on its
 * control) go to the input itself, not to the field's wrapper.
 */
function LimitField({
  id,
  limit,
  value,
  onValueChange,
  ...aria
}: AriaProps & {
  id: string;
  limit: Limit;
  value: number | null;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      allowOutOfRange
      id={id}
      max={limit.max}
      min={limit.min}
      onValueChange={onValueChange}
      step={limit.step}
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

type Draft = {
  imageResize: boolean;
  imageResizeMaxDimension: number | null;
  imageResizeMaxKB: number | null;
};

function ImageResizeForm({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  const dimensionId = useId();
  const sizeId = useId();
  const draft = useDraft<Draft>({
    // Missing means on.
    imageResize: settings.imageResize !== false,
    imageResizeMaxDimension: settings.imageResizeMaxDimension || DIMENSION.fallback,
    imageResizeMaxKB: settings.imageResizeMaxKB || SIZE_KB.fallback,
  });
  const [invalid, setInvalid] = useState({ dimension: false, size: false });
  const { save, saving } = useGeneralSettingsSave(draft);

  const onSubmit = () => {
    const { imageResize, imageResizeMaxDimension, imageResizeMaxKB } = draft.value;
    const dimensionOk = inRange(imageResizeMaxDimension, DIMENSION);
    const sizeOk = inRange(imageResizeMaxKB, SIZE_KB);
    if (!dimensionOk || !sizeOk) {
      setInvalid({ dimension: !dimensionOk, size: !sizeOk });
      return;
    }
    save({ imageResize, imageResizeMaxDimension, imageResizeMaxKB });
  };

  return (
    <SettingsSection
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={() => {
            setInvalid({ dimension: false, size: false });
            draft.reload();
          }}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      id={SECTION_ID.imageResize}
      onSubmit={onSubmit}
      title={t("imageResize")}
    >
      <SwitchField
        checked={draft.value.imageResize}
        description={<Hint more={t("imageResizeMore")}>{t("imageResizeHint")}</Hint>}
        onCheckedChange={(imageResize) => draft.set((prev) => ({ ...prev, imageResize }))}
        title={t("imageResizeEnable")}
      />
      {/* One Field round each row: it marks the input invalid and adds the error, which sits
          under the description, to the input's description. */}
      <Field className="items-stretch" invalid={invalid.dimension}>
        <SettingsRow
          control={
            <LimitField
              id={dimensionId}
              limit={DIMENSION}
              onValueChange={(value) => {
                setInvalid((prev) => ({ ...prev, dimension: false }));
                draft.set((prev) => ({ ...prev, imageResizeMaxDimension: value }));
              }}
              value={draft.value.imageResizeMaxDimension}
            />
          }
          controlWidth="number"
          description={t("imageResizeMaxDimensionHint")}
          htmlFor={dimensionId}
          title={t("imageResizeMaxDimension")}
        >
          {invalid.dimension ? (
            <FieldError match>
              {t("imageResizeMaxDimensionInvalid", { min: DIMENSION.min, max: DIMENSION.max })}
            </FieldError>
          ) : null}
        </SettingsRow>
      </Field>
      <Field className="items-stretch" invalid={invalid.size}>
        <SettingsRow
          control={
            <LimitField
              id={sizeId}
              limit={SIZE_KB}
              onValueChange={(value) => {
                setInvalid((prev) => ({ ...prev, size: false }));
                draft.set((prev) => ({ ...prev, imageResizeMaxKB: value }));
              }}
              value={draft.value.imageResizeMaxKB}
            />
          }
          controlWidth="number"
          description={t("imageResizeMaxKBHint")}
          htmlFor={sizeId}
          title={t("imageResizeMaxKB")}
        >
          {invalid.size ? (
            <FieldError match>
              {t("imageResizeMaxKBInvalid", { min: SIZE_KB.min, max: SIZE_KB.max })}
            </FieldError>
          ) : null}
        </SettingsRow>
      </Field>
    </SettingsSection>
  );
}
