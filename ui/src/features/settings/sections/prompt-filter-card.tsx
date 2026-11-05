import {
  ArrowRight02Icon,
  Delete02Icon,
  EllipsisIcon,
  PencilEdit01Icon,
  PlusIcon,
  RegexIcon,
  TextSearchIcon,
  TriangleAlertIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ROW_DESCRIPTION,
  SaveFooter,
  SETTINGS_ROW_X,
  SectionQuery,
  SettingsRow,
  SettingsSection,
  SwitchField,
  TOUCH_INPUT,
  useSectionSave,
} from "./settings-section";

type BuiltinKey = "filterClaudeCode" | "filterEnvNoise" | "filterStripBoundaries";

const BUILTIN_KEYS: readonly BuiltinKey[] = [
  "filterClaudeCode",
  "filterEnvNoise",
  "filterStripBoundaries",
];

/** The two kinds, in the order the editor offers them, with the short names its select shows. */
const RULE_KINDS: ReadonlyArray<{ kind: RuleKind; icon: IconSvgElement; labelKey: string }> = [
  { kind: "lines-containing", icon: TextSearchIcon, labelKey: "promptFilter.kindContains" },
  { kind: "regex", icon: RegexIcon, labelKey: "promptFilter.kindRegex" },
];

/** The rule being edited: `index` is null for a new one. `session` remounts the form per open. */
interface EditorState {
  open: boolean;
  index: number | null;
  rule: PromptFilterRule;
  session: number;
}

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
  const rules = draft.value.rules;
  const setRule = (index: number, patch: Partial<PromptFilterRule>) =>
    draft.set((prev) => ({
      ...prev,
      rules: prev.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));
  // Removing a rule removes its menu button; focus goes on to Add rule.
  const addButton = useRef<HTMLButtonElement>(null);
  const removeRule = (index: number) => {
    draft.set((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== index) }));
    addButton.current?.focus();
  };

  // Every built-in filter and rule at once; the switch is on only when all of them are.
  const total = BUILTIN_KEYS.length + rules.length;
  const on =
    BUILTIN_KEYS.filter((key) => draft.value[key]).length +
    rules.filter((rule) => rule.enabled).length;
  const setAll = (enabled: boolean) =>
    draft.set((prev) => ({
      ...prev,
      filterClaudeCode: enabled,
      filterEnvNoise: enabled,
      filterStripBoundaries: enabled,
      rules: prev.rules.map((rule) => (rule.enabled === enabled ? rule : { ...rule, enabled })),
    }));
  const allId = useId();

  // Rules are added and edited in a dialog; Apply writes the draft, and Save sends it. New rules
  // go at the end (parity); rules are not reorderable.
  const [editor, setEditor] = useState<EditorState>(() => ({
    open: false,
    index: null,
    rule: newRule("lines-containing", rules),
    session: 0,
  }));
  const openEditor = (index: number | null) =>
    setEditor((prev) => ({
      open: true,
      index,
      rule: (index === null ? undefined : rules[index]) ?? newRule("lines-containing", rules),
      session: prev.session + 1,
    }));
  const applyEditor = (rule: PromptFilterRule) => {
    const { index } = editor;
    draft.set((prev) => ({
      ...prev,
      rules:
        index === null
          ? [...prev.rules, rule]
          : prev.rules.map((current, i) => (i === index ? rule : current)),
    }));
    setEditor((prev) => ({ ...prev, open: false }));
  };

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
      actions={
        <Switch
          aria-describedby={allId}
          aria-label={t("promptFilter.all")}
          checked={on === total}
          onCheckedChange={setAll}
        />
      }
      badge={
        // Green when every filter is on, red when none is, plain in between.
        <Badge
          id={allId}
          size="sm"
          tone={on === total ? "success" : on === 0 ? "destructive" : "neutral"}
        >
          <span aria-hidden="true">
            {on}/{total}
          </span>
          <span className="sr-only">{t("promptFilter.onCount", { on, total })}</span>
        </Badge>
      }
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
      rows
      title={t("promptFilter")}
    >
      {builtins.map(({ key, hint }) => (
        <SettingsRow key={key}>
          <SwitchField
            checked={draft.value[key]}
            hint={hint}
            label={t(key)}
            onCheckedChange={(value) => setBuiltin(key, value)}
          />
        </SettingsRow>
      ))}

      <SettingsRow className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <div className="flex min-h-5 items-center gap-2">
            <h3 className="font-medium text-foreground text-sm">{t("customRules")}</h3>
            <Badge size="sm" tone="neutral">
              {rules.length}
            </Badge>
          </div>
          <p className={ROW_DESCRIPTION}>
            {fillNodes(t("customRulesHint"), { group: <Code>$1</Code> })}
          </p>
        </div>
        <Button onClick={() => openEditor(null)} ref={addButton} size="sm" variant="outline">
          <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
          {t("promptFilter.addRule")}
        </Button>
      </SettingsRow>

      {/* Each rule is a row of the card, laid out as the built-in rows above. */}
      {rules.length === 0 ? (
        <SettingsRow>
          <p className="text-center text-muted-foreground text-sm">{t("promptFilter.noRules")}</p>
        </SettingsRow>
      ) : (
        <ol className="[&>li+li]:border-border/50 [&>li+li]:border-t">
          {rules.map((rule, index) => (
            <RuleRow
              index={index}
              // biome-ignore lint/suspicious/noArrayIndexKey: ids come from the server unchecked and may repeat; rules never reorder, so the index keeps keys unique.
              key={`${rule.id}:${index}`}
              onDelete={() => removeRule(index)}
              onEdit={() => openEditor(index)}
              onToggle={(enabled) => setRule(index, { enabled })}
              rule={rule}
            />
          ))}
        </ol>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setEditor((prev) => ({ ...prev, open: false }));
        }}
        open={editor.open}
      >
        <RuleEditor
          isNew={editor.index === null}
          key={editor.session}
          onApply={applyEditor}
          rule={editor.rule}
        />
      </Dialog>
    </SettingsSection>
  );
}

/**
 * One custom rule as a settings row, like the built-in rows: the name with its type pill and,
 * as the row's description, what it matches and what that becomes; the row's menu (Edit, Delete)
 * and its switch at the end.
 */
function RuleRow({
  rule,
  index,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: PromptFilterRule;
  index: number;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { t } = useT("settings");
  const regex = isRegexRule(rule);
  const invalid = regex && regexFails(rule.match);
  const name = rule.name.trim() || t("promptFilter.unnamed");

  return (
    <li
      aria-label={t("promptFilter.ruleLabel", { n: index + 1 })}
      className={cn(SETTINGS_ROW_X, "flex items-center gap-x-4 py-4 sm:gap-x-8")}
      data-rule-index={index}
    >
      {/* A rule that is off dims its text; its menu and switch stay at full strength. */}
      <div className={cn("flex min-w-0 flex-1 flex-col gap-1", !rule.enabled && "opacity-60")}>
        {/* A long name wraps (two lines at most) and the pill follows it, onto a line of its own if need be. */}
        <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "line-clamp-2 min-w-0 font-medium text-sm [overflow-wrap:anywhere]",
              rule.name.trim() ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {name}
          </span>
          <Badge
            icon={regex ? RegexIcon : TextSearchIcon}
            iconStyle="line"
            size="sm"
            tone={regex ? "primary" : "warning"}
          >
            {regex ? t("promptFilter.typeRegex") : t("promptFilter.typeContains")}
          </Badge>
        </div>
        <RuleSummary rule={rule} />
        {invalid ? (
          // A hint, not an error: the server stores the rule anyway and skips it at run time.
          <p className="flex items-center gap-1.5 text-warning-foreground text-xs">
            <HugeiconsIcon
              icon={TriangleAlertIcon}
              aria-hidden="true"
              className="size-3.5 shrink-0"
            />
            {t("promptFilter.invalidRegex")}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label={t("promptFilter.ruleActions", { name })}
                className="size-10 md:size-8"
                size="icon"
                variant="quiet"
              />
            }
          >
            <HugeiconsIcon icon={EllipsisIcon} aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onEdit}>
              <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
              {t("promptFilter.editRule")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={onDelete} variant="destructive">
              <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
              {t("promptFilter.deleteRule")}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Switch
          aria-label={t("promptFilter.enabled")}
          checked={rule.enabled}
          onCheckedChange={onToggle}
        />
      </div>
    </li>
  );
}

/** "match → result" in one line: the replacement, or what happens when there is none. */
function RuleSummary({ rule }: { rule: PromptFilterRule }): JSX.Element {
  const { t } = useT("settings");
  const regex = isRegexRule(rule);
  const replace = regex ? (rule.replace ?? "") : "";
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      {/* Both sides shrink with their length, so neither one is squeezed to nothing. */}
      <code className="min-w-0 truncate">{rule.match}</code>
      <HugeiconsIcon icon={ArrowRight02Icon} aria-hidden="true" className="size-3 shrink-0" />
      {replace ? (
        <code className="min-w-0 truncate">{replace}</code>
      ) : (
        <span className="min-w-0 truncate">
          {regex ? t("promptFilter.deletesMatch") : t("promptFilter.removesLine")}
        </span>
      )}
    </p>
  );
}

/**
 * The rule editor: name, kind, what to match and, for a regex, the replacement. It edits a copy;
 * Apply hands it back (into the card's draft, which Save sends). A rule needs something to match:
 * an empty line filter would drop every line.
 */
function RuleEditor({
  rule: initial,
  isNew,
  onApply,
}: {
  rule: PromptFilterRule;
  isNew: boolean;
  onApply: (rule: PromptFilterRule) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  const [rule, setRule] = useState(initial);
  const set = (patch: Partial<PromptFilterRule>) => setRule((prev) => ({ ...prev, ...patch }));
  const regex = isRegexRule(rule);
  const invalid = regex && rule.match !== "" && regexFails(rule.match);
  const ready = rule.match.trim() !== "";

  return (
    <DialogPopup className="sm:max-w-xl">
      <form
        className="flex min-h-0 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // The dialog is portalled but still inside the card's form in React: keep this submit
          // from saving the card.
          event.stopPropagation();
          if (ready) onApply(rule);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {isNew ? t("promptFilter.addRule") : t("promptFilter.editRule")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          {/* Name (2/3) and type (1/3) side by side, form fields of one height; stacked on phones.
              A third leaves the type list, which is exactly as wide as its field, room for each
              option's icon, label and check mark. */}
          <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] sm:gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={`${id}-name`}>{t("promptFilter.name")}</Label>
              <Input
                className={TOUCH_INPUT}
                id={`${id}-name`}
                onChange={(event) => set({ name: event.target.value })}
                placeholder={t("promptFilter.unnamed")}
                value={rule.name}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <Label id={`${id}-type`}>{t("promptFilter.type")}</Label>
              <Select
                items={RULE_KINDS.map(({ kind, labelKey }) => ({
                  value: kind,
                  label: t(labelKey),
                }))}
                onValueChange={(next) => {
                  if (next) set({ type: next as RuleKind });
                }}
                value={regex ? "regex" : "lines-containing"}
              >
                {/* A third of the row: the label alone, the icons stay in the list. */}
                <SelectTrigger aria-labelledby={`${id}-type`} className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {RULE_KINDS.map(({ kind, icon, labelKey }) => (
                    <SelectItem key={kind} value={kind}>
                      <HugeiconsIcon icon={icon} aria-hidden="true" />
                      {t(labelKey)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-match`}>{t("promptFilter.match")}</Label>
            <Input
              aria-describedby={`${id}-match-hint`}
              aria-invalid={invalid || undefined}
              className={TOUCH_INPUT}
              id={`${id}-match`}
              onChange={(event) => set({ match: event.target.value })}
              placeholder={
                regex
                  ? t("promptFilter.matchPlaceholderRegex")
                  : t("promptFilter.matchPlaceholderContains")
              }
              spellCheck={false}
              value={rule.match}
            />
            {invalid ? (
              <p
                className="flex items-center gap-1.5 text-warning-foreground text-xs"
                id={`${id}-match-hint`}
                role="status"
              >
                <HugeiconsIcon
                  icon={TriangleAlertIcon}
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
                {t("promptFilter.invalidRegex")}
              </p>
            ) : (
              <p className={ROW_DESCRIPTION} id={`${id}-match-hint`}>
                {regex ? t("promptFilter.matchHintRegex") : t("promptFilter.matchHintContains")}
              </p>
            )}
          </div>
          {regex ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-replace`}>{t("promptFilter.replace")}</Label>
              <Input
                aria-describedby={`${id}-replace-hint`}
                className={TOUCH_INPUT}
                id={`${id}-replace`}
                onChange={(event) => set({ replace: event.target.value })}
                spellCheck={false}
                value={rule.replace ?? ""}
              />
              <p className={ROW_DESCRIPTION} id={`${id}-replace-hint`}>
                {fillNodes(t("promptFilter.replaceHint"), { group: <Code>$1</Code> })}
              </p>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <Button disabled={!ready} type="submit">
            {isNew ? t("promptFilter.addRule") : t("promptFilter.apply")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
