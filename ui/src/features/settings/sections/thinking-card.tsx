import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, type ReactNode, useId } from "react";
import { Code } from "@/components/shared/code";
import { MakerLogo } from "@/components/shared/model-logo";
import type { ModelMaker } from "@/components/shared/model-logos";
import { SettingsRow } from "@/components/shared/settings-rows";
import { Input } from "@/components/ui/input";
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
import { noSpaces } from "@/lib/input-filters";
import { useDraft } from "../lib/dirty";
import { SECTION_ID } from "./sections";
import {
  fillNodes,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  useSectionSave,
} from "./settings-section";

const DEFAULT_SUFFIX = "-thinking";

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

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/**
 * An output format select, each format with the mark of the company it comes from. The row's
 * label and description (SettingsRow puts them on its control) go to the trigger.
 */
function FormatPicker({
  value,
  options,
  onChange,
  ...aria
}: AriaProps & {
  value: ThinkingFormat;
  options: readonly ThinkingFormat[];
  onChange: (value: ThinkingFormat) => void;
}): JSX.Element {
  const { t } = useT("settings");
  // The server also accepts values the select does not offer; keep a stored one visible.
  const shown = options.includes(value) ? options : [...options, value];
  const items = shown.map((format) => ({ value: format, label: formatLabel(format, t) }));
  return (
    <Select
      items={items}
      onValueChange={(next) => {
        if (next) onChange(next as ThinkingFormat);
      }}
      value={value}
    >
      <SelectTrigger {...aria}>
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
  );
}

/** A select as a settings row: name and hint on the left, the select at the end. */
function FormatSelect({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: ReactNode;
  value: ThinkingFormat;
  options: readonly ThinkingFormat[];
  onChange: (value: ThinkingFormat) => void;
}): JSX.Element {
  return (
    <SettingsRow
      control={<FormatPicker onChange={onChange} options={options} value={value} />}
      description={hint}
      title={label}
    />
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
      title={t("thinkingSettings")}
    >
      <SettingsRow
        control={
          <Input
            maxLength={32}
            autoComplete="off"
            id={suffixId}
            onChange={(event) => {
              const suffix = noSpaces(event.target.value);
              draft.set((prev) => ({ ...prev, suffix }));
            }}
            placeholder={DEFAULT_SUFFIX}
            spellCheck={false}
            value={draft.value.suffix}
          />
        }
        description={fillNodes(t("thinkingSuffixHint"), {
          example: <Code>claude-sonnet-4.5-thinking</Code>,
        })}
        htmlFor={suffixId}
        title={t("thinkingSuffix")}
      />
      <FormatSelect
        hint={fillNodes(t("openaiFormatHint"), { path: <Code>/v1/chat/completions</Code> })}
        label={t("openaiFormat")}
        onChange={(openaiFormat) => draft.set((prev) => ({ ...prev, openaiFormat }))}
        options={["reasoning_content", "thinking", "think"]}
        value={draft.value.openaiFormat}
      />
      <FormatSelect
        hint={fillNodes(t("claudeFormatHint"), { path: <Code>/v1/messages</Code> })}
        label={t("claudeFormat")}
        onChange={(claudeFormat) => draft.set((prev) => ({ ...prev, claudeFormat }))}
        options={["thinking", "think"]}
        value={draft.value.claudeFormat}
      />
    </SettingsSection>
  );
}
