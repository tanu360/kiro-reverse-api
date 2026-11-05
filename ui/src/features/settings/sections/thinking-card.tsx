import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId } from "react";
import { MakerLogo } from "@/components/shared/model-logo";
import type { ModelMaker } from "@/components/shared/model-logos";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/api/query-keys";
import { thinkingQuery, updateThinkingConfig } from "@/lib/api/settings";
import type { ThinkingConfig, ThinkingFormat } from "@/lib/api/types";
import { type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useDraft } from "../lib/dirty";
import { SECTION_ID } from "./sections";
import {
  Code,
  fillNodes,
  ROW_DESCRIPTION,
  SaveFooter,
  SectionQuery,
  SettingsRow,
  SettingsSection,
  TOUCH_INPUT,
  useSectionSave,
} from "./settings-section";

const DEFAULT_SUFFIX = "-thinking";

/** A row with its control at the end; the control drops under the text on a narrow card. */
const ROW_WITH_CONTROL = "flex flex-wrap items-center justify-between gap-x-8 gap-y-3";

/** The company each output format comes from, shown as its mark. */
const FORMAT_MAKER: Record<ThinkingFormat, ModelMaker> = {
  reasoning_content: "deepseek",
  thinking: "claude",
  think: "openai",
};

function formatLabel(format: ThinkingFormat, t: TFunction): string {
  switch (format) {
    case "reasoning_content":
      return t("formatReasoningContent");
    case "thinking":
      return t("formatThinkingClaude");
    case "think":
      return t("formatThinkOpenAI");
  }
}

export function ThinkingCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(thinkingQuery());
  return (
    <SectionQuery id={SECTION_ID.thinking} query={query} title={t("thinkingSettings")}>
      {(config) => <ThinkingForm config={config} />}
    </SectionQuery>
  );
}

/** A select as a settings row: name and hint on the left, the select at the end. */
function FormatSelect({
  label,
  maker,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  /** Whose API the format is for, shown as its mark before the name. */
  maker: ModelMaker;
  hint: string;
  value: ThinkingFormat;
  options: readonly ThinkingFormat[];
  onChange: (value: ThinkingFormat) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  // The server also accepts values the select does not offer; keep a stored one visible.
  const shown = options.includes(value) ? options : [...options, value];
  const items = shown.map((format) => ({ value: format, label: formatLabel(format, t) }));
  return (
    <SettingsRow className={ROW_WITH_CONTROL}>
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <Label id={`${id}-label`}>
          <MakerLogo maker={maker} />
          {label}
        </Label>
        <p className={ROW_DESCRIPTION} id={`${id}-hint`}>
          {hint}
        </p>
      </div>
      <Select
        items={items}
        onValueChange={(next) => {
          if (next) onChange(next as ThinkingFormat);
        }}
        value={value}
      >
        <SelectTrigger
          aria-describedby={`${id}-hint`}
          aria-labelledby={`${id}-label`}
          className="w-full sm:w-72"
        >
          <SelectValue>
            {(format: ThinkingFormat) => (
              <span className="flex min-w-0 items-center gap-2">
                {format in FORMAT_MAKER ? <MakerLogo maker={FORMAT_MAKER[format]} /> : null}
                <span className="truncate">{formatLabel(format, t)}</span>
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.value in FORMAT_MAKER ? <MakerLogo maker={FORMAT_MAKER[item.value]} /> : null}
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </SettingsRow>
  );
}

function ThinkingForm({ config }: { config: ThinkingConfig }): JSX.Element {
  const { t } = useT("settings");
  const suffixId = useId();
  const queryClient = useQueryClient();
  // Empty stored values read back as their defaults.
  const draft = useDraft<ThinkingConfig>({
    suffix: config.suffix || DEFAULT_SUFFIX,
    openaiFormat: config.openaiFormat || "reasoning_content",
    claudeFormat: config.claudeFormat || "thinking",
  });
  const { save, saving } = useSectionSave(updateThinkingConfig, {
    onSaved: (sent) => {
      draft.commit(sent);
      queryClient.setQueryData(queryKeys.settings.thinking(), sent);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.thinking() });
    },
  });

  return (
    <SettingsSection
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={draft.reload}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      hint={t("thinkingHint")}
      id={SECTION_ID.thinking}
      // Not a patch: all three fields are always sent; an empty suffix becomes the default.
      onSubmit={() =>
        save({
          suffix: draft.value.suffix.trim() || DEFAULT_SUFFIX,
          openaiFormat: draft.value.openaiFormat,
          claudeFormat: draft.value.claudeFormat,
        })
      }
      rows
      title={t("thinkingSettings")}
    >
      <SettingsRow className={ROW_WITH_CONTROL}>
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <Label htmlFor={suffixId}>{t("thinkingSuffix")}</Label>
          <p className={ROW_DESCRIPTION} id={`${suffixId}-hint`}>
            {fillNodes(t("thinkingSuffixHint"), {
              example: <Code>claude-sonnet-4.5-thinking</Code>,
            })}
          </p>
        </div>
        <Input
          aria-describedby={`${suffixId}-hint`}
          autoComplete="off"
          className={cn("w-full sm:w-72", TOUCH_INPUT)}
          id={suffixId}
          onChange={(event) => {
            const suffix = event.target.value;
            draft.set((prev) => ({ ...prev, suffix }));
          }}
          placeholder={DEFAULT_SUFFIX}
          spellCheck={false}
          value={draft.value.suffix}
        />
      </SettingsRow>
      <FormatSelect
        hint={t("openaiFormatHint")}
        label={t("openaiFormat")}
        maker="openai"
        onChange={(openaiFormat) => draft.set((prev) => ({ ...prev, openaiFormat }))}
        options={["reasoning_content", "thinking", "think"]}
        value={draft.value.openaiFormat}
      />
      <FormatSelect
        hint={t("claudeFormatHint")}
        label={t("claudeFormat")}
        maker="claude"
        onChange={(claudeFormat) => draft.set((prev) => ({ ...prev, claudeFormat }))}
        options={["thinking", "think"]}
        value={draft.value.claudeFormat}
      />
    </SettingsSection>
  );
}
