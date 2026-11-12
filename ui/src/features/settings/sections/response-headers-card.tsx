import {
  Delete02Icon,
  EllipsisVerticalIcon,
  PencilEdit01Icon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useLayoutEffect, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
import { SETTINGS_ROW_X, SettingsEmptyRow } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, isApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/query-keys";
import {
  type ResponseHeaderRule,
  type ResponseHeadersResponse,
  responseHeadersQuery,
  updateResponseHeaders,
} from "@/lib/api/response-headers";
import { type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useDraft } from "../lib/dirty";
import {
  headerNameProblem,
  headerProblem,
  headerValueProblem,
  insertVariable,
  isResponseHeaderErrorCode,
  MAX_HEADER_VALUE_BYTES,
  MAX_RESPONSE_HEADERS,
  normalizeHeaders,
  problemMessage,
  RESPONSE_HEADER_VARIABLES,
  type ResponseHeaderVariable,
  sameResponseHeaders,
  trimHeaderText,
} from "../lib/response-headers";
import { SECTION_ID } from "./sections";
import {
  fillNodes,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  useSectionSave,
} from "./settings-section";

/** HTTP syntax, the same in every language. */
const EXAMPLE_NAME = "X-Request-Id";
const EXAMPLE_VALUE = "{request_id}";

/** The header being added (`index` null) or edited; `session` remounts the form per open. */
interface EditorState {
  open: boolean;
  index: number | null;
  rule: ResponseHeaderRule;
  session: number;
}

/** A row the server refused on Save, with its translated reason. */
interface RowError {
  index: number;
  message: string;
}

const NEW_RULE: ResponseHeaderRule = { name: "", value: "", enabled: true };

export function ResponseHeadersCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(responseHeadersQuery());
  return (
    <SectionQuery id={SECTION_ID.responseHeaders} query={query} title={t("responseHeaders")}>
      {(data) => <ResponseHeadersForm data={data} />}
    </SectionQuery>
  );
}

/**
 * A server 400 for one of this card's codes, with the reason in the reader's language, so the
 * save toast shows it translated; the row index stays on the error.
 */
function localizedSaveError(error: unknown, t: TFunction): unknown {
  if (!isApiError(error) || typeof error.body !== "object" || error.body === null) return error;
  const { code, ...params } = error.body as Record<string, unknown>;
  if (!isResponseHeaderErrorCode(code)) return error;
  const fields = Object.fromEntries(
    Object.entries(params).filter(([, value]) => ["string", "number"].includes(typeof value)),
  ) as Record<string, string | number>;
  const message = problemMessage({ code, params: fields }, t);
  return new ApiError({
    status: error.status,
    serverMessage: message,
    body: { error: message, index: error.index },
    index: error.index,
  });
}

function ResponseHeadersForm({ data }: { data: ResponseHeadersResponse }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const max = data.max || MAX_RESPONSE_HEADERS;
  const draft = useDraft<ResponseHeaderRule[]>(data.headers, sameResponseHeaders);
  const rows = draft.value;
  const [rowError, setRowError] = useState<RowError | null>(null);

  // Each row's menu button, for focus after a delete and on a save error; null means Add header.
  const menuButtons = useRef(new Map<number, HTMLElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const [pendingFocus, setPendingFocus] = useState<{ index: number | null }>();
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    setPendingFocus(undefined);
    if (pendingFocus.index === null) addButton.current?.focus();
    else menuButtons.current.get(pendingFocus.index)?.focus();
  }, [pendingFocus]);
  const register = (index: number) => (element: HTMLElement | null) => {
    if (element) menuButtons.current.set(index, element);
    else menuButtons.current.delete(index);
  };

  const { save, saving } = useSectionSave(
    async (headers: ResponseHeaderRule[]) => {
      try {
        return await updateResponseHeaders({ headers });
      } catch (error) {
        throw localizedSaveError(error, t);
      }
    },
    {
      onSaved: (headers) => {
        draft.commit(headers);
        queryClient.setQueryData<ResponseHeadersResponse>(
          queryKeys.settings.responseHeaders(),
          (old) => (old ? { ...old, headers } : old),
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.responseHeaders() });
      },
      onFailed: (error) => {
        if (!isApiError(error) || error.status !== 400) return;
        if (error.index === null || error.index < 0 || error.index >= rows.length) return;
        setRowError({ index: error.index, message: error.serverMessage });
        setPendingFocus({ index: error.index });
      },
    },
  );

  const setRow = (index: number, patch: Partial<ResponseHeaderRule>) =>
    draft.set((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  // Focus goes to the next row's menu, the previous row's when the last row goes, and Add header
  // when the list is empty, so it never drops to the page.
  const removeRow = (index: number) => {
    setRowError(null);
    draft.set((prev) => prev.filter((_, i) => i !== index));
    const next = index < rows.length - 1 ? index : index - 1;
    setPendingFocus({ index: next >= 0 ? next : null });
  };

  // Headers are added and edited in a dialog; Apply writes the draft, and Save sends it. New
  // headers go at the end, the order they are sent in.
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    index: null,
    rule: NEW_RULE,
    session: 0,
  });
  const openEditor = (index: number | null) =>
    setEditor((prev) => ({
      open: true,
      index,
      rule: (index === null ? undefined : rows[index]) ?? NEW_RULE,
      session: prev.session + 1,
    }));
  const applyEditor = (rule: ResponseHeaderRule) => {
    const { index } = editor;
    if (index !== null && rowError?.index === index) setRowError(null);
    draft.set((prev) =>
      index === null ? [...prev, rule] : prev.map((current, i) => (i === index ? rule : current)),
    );
    setEditor((prev) => ({ ...prev, open: false }));
  };

  const full = rows.length >= max;
  const on = rows.filter((rule) => rule.enabled).length;
  const reload = () => {
    setRowError(null);
    draft.reload();
  };

  return (
    <SettingsSection
      actions={
        // Dimmed but focusable at the limit; the footer says why.
        <Button
          aria-disabled={full || undefined}
          onClick={() => {
            if (!full) openEditor(null);
          }}
          ref={addButton}
          size="sm"
          variant="secondary"
        >
          <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" />
          {t("responseHeaders.add")}
        </Button>
      }
      badge={
        <Badge size="sm" tone={rows.length > 0 && on === rows.length ? "success" : "neutral"}>
          <span aria-hidden="true">
            {on}/{rows.length}
          </span>
          <span className="sr-only">
            {t("responseHeaders.onCount", { on, total: rows.length })}
          </span>
        </Badge>
      }
      footer={
        <SaveFooter
          dirty={draft.dirty}
          note={full ? t("responseHeaders.limit", { max }) : undefined}
          onReload={reload}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      hint={t("responseHeadersHint")}
      id={SECTION_ID.responseHeaders}
      learnMore={fillNodes(t("responseHeaders.timing"), { account: <Code>{"{account_id}"}</Code> })}
      onSubmit={() => {
        setRowError(null);
        save(normalizeHeaders(rows));
      }}
      title={t("responseHeaders")}
    >
      {rows.length === 0 ? (
        <SettingsEmptyRow>
          {fillNodes(t("responseHeaders.empty"), {
            example: (
              <Code>
                {EXAMPLE_NAME}: {EXAMPLE_VALUE}
              </Code>
            ),
          })}
        </SettingsEmptyRow>
      ) : (
        <ol className="[&>li+li]:border-border-subtle [&>li+li]:border-t">
          {rows.map((rule, index) => (
            <HeaderRow
              error={rowError?.index === index ? rowError.message : null}
              index={index}
              // Names are unique once saved; the index keeps a draft's repeat apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own
              key={index}
              onDelete={() => removeRow(index)}
              onEdit={() => openEditor(index)}
              onToggle={(enabled) => setRow(index, { enabled })}
              register={register(index)}
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
        <HeaderEditor
          isNew={editor.index === null}
          key={editor.session}
          onApply={applyEditor}
          others={rows.filter((_, i) => i !== editor.index)}
          rule={editor.rule}
        />
      </Dialog>
    </SettingsSection>
  );
}

/** One header as a row: its name and value template in mono, its menu and its switch. */
function HeaderRow({
  rule,
  index,
  error,
  onToggle,
  onEdit,
  onDelete,
  register,
}: {
  rule: ResponseHeaderRule;
  index: number;
  /** The server's reason when this row stopped the save; null otherwise. */
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  register: (element: HTMLElement | null) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const name = rule.name;
  return (
    <li
      aria-label={t("responseHeaders.rowLabel", { n: index + 1 })}
      className={cn(
        SETTINGS_ROW_X,
        "flex flex-col gap-1 py-4",
        error !== null && "bg-error-surface",
      )}
      data-error={error !== null || undefined}
    >
      <div className="flex items-center gap-x-4 sm:gap-x-8">
        {/* A header that is off dims its text; its menu and switch stay at full strength. */}
        <div className={cn("flex min-w-0 flex-1 flex-col gap-1", !rule.enabled && "opacity-64")}>
          <code className="truncate font-medium text-foreground text-sm" translate="no">
            {name}
          </code>
          <code className="truncate text-muted-foreground text-xs" translate="no">
            {rule.value}
          </code>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={t("responseHeaders.rowActions", { name })}
                  ref={register}
                  size="icon-sm"
                  variant="quiet"
                />
              }
            >
              <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
                {t("responseHeaders.edit")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={onDelete} variant="destructive">
                <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
                {t("responseHeaders.delete")}
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Switch
            aria-label={t("responseHeaders.enabledFor", { name })}
            checked={rule.enabled}
            onCheckedChange={onToggle}
          />
        </div>
      </div>
      {error ? (
        <p className="text-destructive-foreground text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The header editor: its name and its value, with a chip per variable that puts `{name}` at the
 * caret. Apply stays off while either field would be refused; a field shows its problem once it
 * has text, so a new header does not open on errors.
 */
function HeaderEditor({
  rule: initial,
  others,
  isNew,
  onApply,
}: {
  rule: ResponseHeaderRule;
  others: readonly ResponseHeaderRule[];
  isNew: boolean;
  onApply: (rule: ResponseHeaderRule) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState(initial.value);
  const valueInput = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState<number | null>(null);

  // A chip moves focus back to the value and the caret past what it put in.
  useLayoutEffect(() => {
    if (caret === null) return;
    const input = valueInput.current;
    input?.focus();
    input?.setSelectionRange(caret, caret);
    setCaret(null);
  }, [caret]);

  const problem = headerProblem({ name, value }, others);
  const nameProblem =
    name === ""
      ? null
      : (headerNameProblem(name) ??
        (problem?.code === "response_header_name_duplicate" ? problem : null));
  const valueProblem = value === "" ? null : headerValueProblem(value, trimHeaderText(name));
  const ready = problem === null;

  const insert = (variable: ResponseHeaderVariable) => {
    const input = valueInput.current;
    const next = insertVariable(
      value,
      input?.selectionStart ?? null,
      input?.selectionEnd ?? null,
      variable,
    );
    setValue(next.value);
    setCaret(next.caret);
  };

  return (
    <DialogPopup size="xl">
      <form
        className="flex min-h-0 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // The dialog is portalled but still inside the card's form in React: keep this submit
          // from saving the card.
          event.stopPropagation();
          if (ready) {
            onApply({
              name: trimHeaderText(name),
              value: trimHeaderText(value),
              enabled: initial.enabled,
            });
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{isNew ? t("responseHeaders.add") : t("responseHeaders.edit")}</DialogTitle>
          <DialogDescription>{t("responseHeaders.editorDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <Field className="min-w-0 items-stretch" invalid={nameProblem !== null}>
            <FieldLabel>{t("responseHeaders.name")}</FieldLabel>
            <Input
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              placeholder={EXAMPLE_NAME}
              spellCheck={false}
              value={name}
              variant="code"
            />
            {nameProblem ? (
              <FieldError match>{problemMessage(nameProblem, t)}</FieldError>
            ) : (
              <FieldDescription className="text-pretty">
                {t("responseHeaders.nameHint")}
              </FieldDescription>
            )}
          </Field>
          <Field className="min-w-0 items-stretch" invalid={valueProblem !== null}>
            <FieldLabel>{t("responseHeaders.value")}</FieldLabel>
            <Input
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
              placeholder={EXAMPLE_VALUE}
              ref={valueInput}
              spellCheck={false}
              value={value}
              variant="code"
            />
            {valueProblem ? (
              <FieldError match>{problemMessage(valueProblem, t)}</FieldError>
            ) : (
              <FieldDescription className="text-pretty">
                {t("responseHeaders.valueHint", { max: MAX_HEADER_VALUE_BYTES })}
              </FieldDescription>
            )}
          </Field>
          <Fieldset className="flex min-w-0 flex-col gap-2">
            <FieldsetLegend>{t("responseHeaders.variables")}</FieldsetLegend>
            <div className="flex flex-wrap gap-2">
              {RESPONSE_HEADER_VARIABLES.map((variable) => (
                <Tooltip key={variable}>
                  <TooltipTrigger
                    render={
                      <Button
                        onClick={() => insert(variable)}
                        size="xs"
                        translate="no"
                        type="button"
                        variant="outline"
                      />
                    }
                  >
                    {`{${variable}}`}
                  </TooltipTrigger>
                  <TooltipPopup>{t(`responseHeaders.var.${variable}`)}</TooltipPopup>
                </Tooltip>
              ))}
            </div>
          </Fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <Button disabled={!ready} type="submit">
            <HugeiconsIcon icon={isNew ? PlusSignIcon : Tick02Icon} aria-hidden="true" />
            {isNew ? t("responseHeaders.add") : t("responseHeaders.apply")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
