import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId } from "react";
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
import { useDraft } from "../lib/dirty";
import { SECTION_ID } from "./sections";
import {
  Code,
  fillNodes,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  useSectionSave,
} from "./settings-section";

const DEFAULT_SUFFIX = "-thinking";

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

function FormatSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
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
    <div className="flex min-w-0 flex-col gap-2">
      <Label id={`${id}-label`}>{label}</Label>
      <Select
        items={items}
        onValueChange={(next) => {
          if (next) onChange(next as ThinkingFormat);
        }}
        value={value}
      >
        <SelectTrigger aria-labelledby={`${id}-label`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
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
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor={suffixId}>{t("thinkingSuffix")}</Label>
          <Input
            aria-describedby={`${suffixId}-hint`}
            autoComplete="off"
            className="max-w-xs"
            id={suffixId}
            onChange={(event) => {
              const suffix = event.target.value;
              draft.set((prev) => ({ ...prev, suffix }));
            }}
            placeholder={DEFAULT_SUFFIX}
            spellCheck={false}
            value={draft.value.suffix}
          />
          <p className="text-muted-foreground text-xs" id={`${suffixId}-hint`}>
            {fillNodes(t("thinkingSuffixHint"), {
              example: <Code>claude-sonnet-4.5-thinking</Code>,
            })}
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <FormatSelect
            label={t("openaiFormat")}
            onChange={(openaiFormat) => draft.set((prev) => ({ ...prev, openaiFormat }))}
            options={["reasoning_content", "thinking", "think"]}
            value={draft.value.openaiFormat}
          />
          <FormatSelect
            label={t("claudeFormat")}
            onChange={(claudeFormat) => draft.set((prev) => ({ ...prev, claudeFormat }))}
            options={["thinking", "think"]}
            value={draft.value.claudeFormat}
          />
        </div>
      </div>
    </SettingsSection>
  );
}
