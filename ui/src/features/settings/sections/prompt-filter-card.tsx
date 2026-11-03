import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { type JSX, useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { queryKeys } from "@/lib/api/query-keys";
import { promptFilterQuery, updatePromptFilter } from "@/lib/api/settings";
import type { PromptFilterConfig, PromptFilterRule } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useDraft } from "../lib/dirty";
import {
  isRegexRule,
  newRule,
  promptFilterBody,
  type RuleKind,
  regexFails,
  samePromptFilter,
} from "../lib/prompt-filter";
import { SECTION_ID } from "./sections";
import {
  Code,
  fillNodes,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  SwitchField,
  TOUCH_INPUT,
  useSectionSave,
} from "./settings-section";

type BuiltinKey = "filterClaudeCode" | "filterEnvNoise" | "filterStripBoundaries";

export function PromptFilterCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(promptFilterQuery());
  return (
    <SectionQuery id={SECTION_ID.promptFilter} query={query} title={t("promptFilter")}>
      {(config) => <PromptFilterForm config={config} />}
    </SectionQuery>
  );
}

function PromptFilterForm({ config }: { config: PromptFilterConfig }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const draft = useDraft<PromptFilterConfig>(
    {
      filterClaudeCode: config.filterClaudeCode === true,
      filterEnvNoise: config.filterEnvNoise === true,
      filterStripBoundaries: config.filterStripBoundaries === true,
      rules: config.rules ?? [],
    },
    samePromptFilter,
  );
  const { save, saving } = useSectionSave((body: PromptFilterConfig) => updatePromptFilter(body), {
    onSaved: (sent) => {
      draft.commit(sent);
      queryClient.setQueryData(queryKeys.settings.promptFilter(), sent);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.promptFilter() });
    },
  });

  const setBuiltin = (key: BuiltinKey, value: boolean) =>
    draft.set((prev) => ({ ...prev, [key]: value }));
  const setRule = (index: number, patch: Partial<PromptFilterRule>) =>
    draft.set((prev) => ({
      ...prev,
      rules: prev.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));
  const removeRule = (index: number) =>
    draft.set((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== index) }));
  // New rules go at the end (parity); rules are not reorderable.
  const addRule = (kind: RuleKind) =>
    draft.set((prev) => ({ ...prev, rules: [...prev.rules, newRule(kind, prev.rules)] }));

  const builtins: Array<{ key: BuiltinKey; hint: JSX.Element | string }> = [
    { key: "filterClaudeCode", hint: t("filterClaudeCodeHint") },
    { key: "filterEnvNoise", hint: t("filterEnvNoiseHint") },
    {
      key: "filterStripBoundaries",
      hint: (
        <>
          {fillNodes(t("filterStripBoundariesHint"), {
            start: <Code>--- SYSTEM PROMPT ---</Code>,
            end: <Code>--- END SYSTEM PROMPT ---</Code>,
          })}
        </>
      ),
    },
  ];

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
      hint={t("promptFilterHint")}
      id={SECTION_ID.promptFilter}
      onSubmit={() => save(promptFilterBody(draft.value))}
      title={t("promptFilter")}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4">
          <h3 className="font-medium text-sm">{t("builtinFilters")}</h3>
          {builtins.map(({ key, hint }) => (
            <SwitchField
              checked={draft.value[key]}
              hint={hint}
              key={key}
              label={t(key)}
              onCheckedChange={(value) => setBuiltin(key, value)}
            />
          ))}
        </div>

        <Separator />

        <div className="flex flex-col gap-3">
          <h3 className="font-medium text-sm">{t("customRules")}</h3>
          {draft.value.rules.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
              {t("promptFilter.noRules")}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {draft.value.rules.map((rule, index) => (
                <RuleCard
                  index={index}
                  // biome-ignore lint/suspicious/noArrayIndexKey: ids come from the server unchecked and may repeat; rules never reorder, so the index keeps keys unique.
                  key={`${rule.id}:${index}`}
                  onChange={(patch) => setRule(index, patch)}
                  onRemove={() => removeRule(index)}
                  rule={rule}
                />
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => addRule("regex")} size="sm" variant="outline">
              <PlusIcon aria-hidden="true" />
              {t("promptFilter.addRegex")}
            </Button>
            <Button onClick={() => addRule("lines-containing")} size="sm" variant="outline">
              <PlusIcon aria-hidden="true" />
              {t("promptFilter.addContains")}
            </Button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

function RuleCard({
  rule,
  index,
  onChange,
  onRemove,
}: {
  rule: PromptFilterRule;
  index: number;
  onChange: (patch: Partial<PromptFilterRule>) => void;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  const regex = isRegexRule(rule);
  const invalid = regex && regexFails(rule.match);
  const ruleLabel = t("promptFilter.ruleLabel", { n: index + 1 });
  const typeLabel = regex ? t("promptFilter.typeRegex") : t("promptFilter.typeContains");

  return (
    <li
      aria-label={ruleLabel}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-background p-3 transition-opacity",
        !rule.enabled && "opacity-60",
      )}
      data-rule-index={index}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Switch
          aria-label={t("promptFilter.enabled")}
          checked={rule.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
        <Input
          aria-label={t("promptFilter.name")}
          className={cn("min-w-0 flex-1", TOUCH_INPUT)}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder={t("promptFilter.unnamed")}
          value={rule.name}
        />
        <Badge className="hidden shrink-0 sm:inline-flex" variant="secondary">
          {typeLabel}
        </Badge>
        <Button
          aria-label={t("remove")}
          className="shrink-0"
          onClick={onRemove}
          size="icon-sm"
          title={t("remove")}
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      {/* On phones the type moves under the header so the name keeps its width. */}
      <Badge className="self-start sm:hidden" variant="secondary">
        {typeLabel}
      </Badge>
      <div className={cn("grid gap-3", regex && "sm:grid-cols-2")}>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label className="text-xs" htmlFor={`${id}-match`}>
            {t("promptFilter.match")}
          </Label>
          <Input
            aria-describedby={invalid ? `${id}-match-hint` : undefined}
            aria-invalid={invalid || undefined}
            className={cn("font-mono", TOUCH_INPUT)}
            id={`${id}-match`}
            onChange={(event) => onChange({ match: event.target.value })}
            placeholder={
              regex
                ? t("promptFilter.matchPlaceholderRegex")
                : t("promptFilter.matchPlaceholderContains")
            }
            spellCheck={false}
            value={rule.match}
          />
          {invalid ? (
            // A hint, not an error: the server stores the rule anyway and skips it at run time.
            <p className="text-warning-foreground text-xs" id={`${id}-match-hint`} role="status">
              {t("promptFilter.invalidRegex")}
            </p>
          ) : null}
        </div>
        {regex ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label className="text-xs" htmlFor={`${id}-replace`}>
              {t("promptFilter.replace")}
            </Label>
            <Input
              aria-describedby={`${id}-replace-hint`}
              className={cn("font-mono", TOUCH_INPUT)}
              id={`${id}-replace`}
              onChange={(event) => onChange({ replace: event.target.value })}
              spellCheck={false}
              value={rule.replace ?? ""}
            />
            <p className="text-muted-foreground text-xs" id={`${id}-replace-hint`}>
              {t("promptFilter.emptyRemove")}
            </p>
          </div>
        ) : null}
      </div>
    </li>
  );
}
