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
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import { Hint, SaveFooter, SectionQuery, SettingsSection } from "./settings-section";

/** Mirrors config/image_resize.go. */
const DIMENSION = { min: 256, max: 4096, step: 32, fallback: 1568 } as const;
const SIZE_KB = { min: 50, max: 4096, step: 50, fallback: 400 } as const;
/** The longest side Claude scales a larger image down to, in pixels. */
const CLAUDE_MAX_EDGE = 1568;

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
  disabled,
  onValueChange,
  ...aria
}: AriaProps & {
  id: string;
  limit: Limit;
  value: number | null;
  disabled: boolean;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      allowOutOfRange
      disabled={disabled}
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
  const { t, lang } = useT("settings");
  // Grouped as numbers are everywhere else ("4,096"), in the hints and the errors alike.
  const dimension = {
    min: formatNumber(DIMENSION.min, lang),
    max: formatNumber(DIMENSION.max, lang),
  };
  const sizeKB = { min: formatNumber(SIZE_KB.min, lang), max: formatNumber(SIZE_KB.max, lang) };
  const dimensionId = useId();
  const sizeId = useId();
  const draft = useDraft<Draft>({
    // Missing means on.
    imageResize: settings.imageResize !== false,
    imageResizeMaxDimension: settings.imageResizeMaxDimension || DIMENSION.fallback,
    imageResizeMaxKB: settings.imageResizeMaxKB || SIZE_KB.fallback,
  });
  const [invalid, setInvalid] = useState({ dimension: false, size: false });
  const { save, feedback } = useGeneralSettingsSave(draft);

  const onSubmit = () => {
    const { imageResize, imageResizeMaxDimension, imageResizeMaxKB } = draft.value;
    const dimensionOk = inRange(imageResizeMaxDimension, DIMENSION);
    const sizeOk = inRange(imageResizeMaxKB, SIZE_KB);
    if (!imageResize) {
      // Nothing reads the limits while resizing is off, and their fields cannot be fixed then:
      // a value they cannot take keeps the saved one.
      setInvalid({ dimension: false, size: false });
      save({
        imageResize,
        imageResizeMaxDimension: dimensionOk
          ? imageResizeMaxDimension
          : (draft.saved.imageResizeMaxDimension ?? DIMENSION.fallback),
        imageResizeMaxKB: sizeOk
          ? imageResizeMaxKB
          : (draft.saved.imageResizeMaxKB ?? SIZE_KB.fallback),
      });
      return;
    }
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
          feedback={feedback}
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
        onCheckedChange={(imageResize) => {
          // Off, the fields cannot be fixed: their errors go with them.
          if (!imageResize) setInvalid({ dimension: false, size: false });
          draft.set((prev) => ({ ...prev, imageResize }));
        }}
        title={t("imageResizeEnable")}
      />
      {/* One Field round each row: it marks the input invalid and adds the error, which sits
          under the description, to the input's description. */}
      <Field
        className="items-stretch"
        disabled={!draft.value.imageResize}
        invalid={invalid.dimension}
      >
        <SettingsRow
          control={
            <LimitField
              disabled={!draft.value.imageResize}
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
          description={t("imageResizeMaxDimensionHint", {
            ...dimension,
            claude: formatNumber(CLAUDE_MAX_EDGE, lang),
          })}
          htmlFor={dimensionId}
          title={t("imageResizeMaxDimension")}
        >
          {invalid.dimension ? (
            <FieldError match>{t("imageResizeMaxDimensionInvalid", dimension)}</FieldError>
          ) : null}
        </SettingsRow>
      </Field>
      <Field className="items-stretch" disabled={!draft.value.imageResize} invalid={invalid.size}>
        <SettingsRow
          control={
            <LimitField
              disabled={!draft.value.imageResize}
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
          description={t("imageResizeMaxKBHint", sizeKB)}
          htmlFor={sizeId}
          title={t("imageResizeMaxKB")}
        >
          {invalid.size ? (
            <FieldError match>{t("imageResizeMaxKBInvalid", sizeKB)}</FieldError>
          ) : null}
        </SettingsRow>
      </Field>
    </SettingsSection>
  );
}
