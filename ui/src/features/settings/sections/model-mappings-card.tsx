import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown02Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  Delete02Icon,
  EllipsisIcon,
  GripVerticalIcon,
  InformationCircleIcon,
  PencilEdit01Icon,
  PlusIcon,
  Search01Icon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ModelLogo } from "@/components/shared/model-logo";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { isApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/query-keys";
import { modelMappingsQuery, updateModelMappings } from "@/lib/api/settings";
import type { ModelMappingRule, ModelMappingsResponse } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useDraft } from "../lib/dirty";
import {
  localRowForServerIndex,
  type MappingRow,
  moveRow,
  newRowId,
  prepareMappings,
  rowsFromRules,
  sameMappings,
} from "../lib/model-mappings";
import { SECTION_ID } from "./sections";
import {
  SaveButton,
  SectionQuery,
  ServerChangedNotice,
  SettingsRow,
  SettingsSection,
  useSectionSave,
} from "./settings-section";

/** A list this long gets a filter field. */
const FILTER_FROM = 8;

/** The columns every row shares (a subgrid): grip, number, match, arrow, target, menu. */
const LIST_COLUMNS =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto]";
const ROW_GRID = "col-span-full grid grid-cols-subgrid items-center px-4 sm:px-5";

/** The mapping being added (`rowId` null) or edited; `session` remounts the form per open. */
interface EditorState {
  open: boolean;
  rowId: string | null;
  key: string;
  value: string;
  session: number;
}

interface SaveRequest {
  mappings: ModelMappingRule[];
  rowIndexes: number[];
  rows: readonly MappingRow[];
}

export function ModelMappingsCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(modelMappingsQuery());
  return (
    <SectionQuery id={SECTION_ID.modelMappings} query={query} title={t("modelMappings")}>
      {(data) => <ModelMappingsForm data={data} />}
    </SectionQuery>
  );
}

function ModelMappingsForm({ data }: { data: ModelMappingsResponse }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  // Rows of the last render: a server copy of the same rules keeps their ids, so a refetch
  // after Save does not remount the rows and drop focus.
  const rowsRef = useRef<readonly MappingRow[]>([]);
  const server = useMemo(() => rowsFromRules(data.mappings, rowsRef.current), [data.mappings]);
  const draft = useDraft<readonly MappingRow[]>(server, sameMappings);
  const rows = draft.value;
  rowsRef.current = rows;
  const [errorRowId, setErrorRowId] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Each row's menu button by row id, for focus after a delete and on a save error. A pending
  // null row id means Add mapping (after the last row is deleted).
  const menuButtons = useRef(new Map<string, HTMLElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const [pendingFocus, setPendingFocus] = useState<{ rowId: string | null }>();
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    setPendingFocus(undefined);
    if (pendingFocus.rowId === null) addButton.current?.focus();
    else menuButtons.current.get(pendingFocus.rowId)?.focus();
  }, [pendingFocus]);

  const register = (rowId: string) => (element: HTMLElement | null) => {
    if (element) menuButtons.current.set(rowId, element);
    else menuButtons.current.delete(rowId);
  };

  const clearError = () => {
    setErrorRowId(null);
    setServerError(null);
  };

  const { save, saving } = useSectionSave(
    ({ mappings }: SaveRequest) => updateModelMappings({ mappings }),
    {
      onSaved: ({ mappings, rowIndexes, rows: sentFrom }) => {
        // The local list becomes the sent list (trimmed, blank rows gone). The server lowercases
        // keys; the refetch then shows its copy.
        draft.commit(mappings.map((rule, i) => ({ id: sentFrom[rowIndexes[i]].id, ...rule })));
        queryClient.setQueryData<ModelMappingsResponse>(
          queryKeys.settings.modelMappings(),
          (old) => (old ? { ...old, mappings } : old),
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.modelMappings() });
      },
      onFailed: (error, { rowIndexes, rows: sentFrom }) => {
        if (!isApiError(error) || error.status !== 400) return;
        const local = localRowForServerIndex(rowIndexes, error.index);
        if (local === null) return;
        const row = sentFrom[local];
        setErrorRowId(row.id);
        setServerError(error.serverMessage);
        setFilter("");
        setPendingFocus({ rowId: row.id });
      },
    },
  );

  const onSubmit = () => {
    clearError();
    const { mappings, rowIndexes } = prepareMappings(rows);
    save({ mappings, rowIndexes, rows });
  };

  // Focus goes to the next row's menu, the previous row's when the last row goes, and Add
  // mapping when the list is empty, so it never drops to the page.
  const removeRow = (rowId: string) => {
    if (rowId === errorRowId) clearError();
    const index = rows.findIndex((row) => row.id === rowId);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    draft.set((prev) => prev.filter((row) => row.id !== rowId));
    setPendingFocus({ rowId: neighbour?.id ?? null });
  };

  // The menu hands focus back to its button, which moves with its row.
  const move = (from: number, to: number) => {
    draft.set((prev) => moveRow(prev, from, to));
  };

  // Adding and editing happen in a dialog; Apply writes the draft, and Save sends it.
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    rowId: null,
    key: "",
    value: "",
    session: 0,
  });
  const openEditor = (row: MappingRow | null) =>
    setEditor((prev) => ({
      open: true,
      rowId: row?.id ?? null,
      key: row?.key ?? "",
      value: row?.value ?? "",
      session: prev.session + 1,
    }));
  // New rows go on top (parity).
  const applyEditor = (key: string, value: string) => {
    const { rowId } = editor;
    if (rowId === null) {
      draft.set((prev) => [{ id: newRowId(), key, value }, ...prev]);
    } else {
      if (rowId === errorRowId) clearError();
      draft.set((prev) => prev.map((row) => (row.id === rowId ? { ...row, key, value } : row)));
    }
    setEditor((prev) => ({ ...prev, open: false }));
  };

  // A long list can be filtered by either side; reordering waits until the filter is cleared.
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        !needle ||
        row.key.toLowerCase().includes(needle) ||
        row.value.toLowerCase().includes(needle),
    );

  // Local only until Save.
  const resetToDefaults = () => {
    clearError();
    setFilter("");
    draft.set(rowsFromRules(data.defaults));
  };

  const reload = () => {
    clearError();
    draft.reload();
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const position = (id: UniqueIdentifier | undefined) =>
    id === undefined ? 0 : rows.findIndex((row) => row.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("modelMappings.dragStart", { from: position(active.id) }),
    onDragOver: ({ active, over }) =>
      over
        ? t("modelMappings.dragOver", { from: position(active.id), to: position(over.id) })
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? t("modelMappings.dragEnd", { from: position(active.id), to: position(over.id) })
        : t("modelMappings.dragCancel", { from: position(active.id) }),
    onDragCancel: ({ active }) => t("modelMappings.dragCancel", { from: position(active.id) }),
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(position(active.id) - 1, position(over.id) - 1);
  };

  return (
    <SettingsSection
      actions={
        // Beside the title on a narrow page; under the description once the heading has a column.
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => openEditor(null)} ref={addButton} size="sm" variant="outline">
            <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
            {t("modelMappings.add")}
          </Button>
          <Button onClick={resetToDefaults} size="sm" variant="outline">
            <HugeiconsIcon icon={Undo02Icon} aria-hidden="true" />
            {t("modelMappings.reset")}
          </Button>
        </div>
      }
      badge={
        <Badge size="sm" tone="neutral">
          {rows.length}
        </Badge>
      }
      // Save sits in the footer, as on every other card.
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1 text-muted-foreground text-xs">
            {draft.serverChanged ? <ServerChangedNotice onReload={reload} /> : null}
            <p>{t("modelMappings.resetNote")}</p>
          </div>
          <SaveButton dirty={draft.dirty} saving={saving} />
        </div>
      }
      hint={t("modelMappingsHint")}
      id={SECTION_ID.modelMappings}
      onSubmit={onSubmit}
      rows
      title={t("modelMappings")}
    >
      {rows.length > FILTER_FROM ? (
        <SettingsRow className="py-3">
          <InputGroup className="sm:max-w-xs">
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t("modelMappings.filter")}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("modelMappings.filter")}
              spellCheck={false}
              type="search"
              value={filter}
            />
          </InputGroup>
        </SettingsRow>
      ) : null}

      {rows.length === 0 ? (
        <SettingsRow>
          <p className="text-center text-muted-foreground text-sm">{t("modelMappings.noRules")}</p>
        </SettingsRow>
      ) : shown.length === 0 ? (
        <SettingsRow>
          <p className="text-center text-muted-foreground text-sm">
            {t("modelMappings.noMatches", { filter: filter.trim() })}
          </p>
        </SettingsRow>
      ) : (
        // One grid for the column labels and every row, so the columns line up down the list.
        <div className={cn(LIST_COLUMNS, "pt-2")}>
          <div
            aria-hidden="true"
            className={cn(
              ROW_GRID,
              "hidden pb-1 font-medium text-muted-foreground text-xs sm:grid",
            )}
          >
            <span />
            <span className="text-end">#</span>
            <span>{t("modelMappings.match")}</span>
            <span />
            <span>{t("modelMappings.target")}</span>
            <span />
          </div>
          <DndContext
            accessibility={{
              announcements,
              screenReaderInstructions: { draggable: t("modelMappings.dragInstructions") },
            }}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            sensors={sensors}
          >
            <SortableContext
              items={shown.map(({ row }) => row.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="col-span-full grid grid-cols-subgrid [&>li+li]:border-border/50 [&>li+li]:border-t">
                {shown.map(({ row, index }) => (
                  <MappingRowItem
                    count={rows.length}
                    error={row.id === errorRowId ? (serverError ?? "") : null}
                    filtering={needle !== ""}
                    index={index}
                    key={row.id}
                    onDelete={() => removeRow(row.id)}
                    onEdit={() => openEditor(row)}
                    onMove={(to) => move(index, to)}
                    register={register(row.id)}
                    row={row}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setEditor((prev) => ({ ...prev, open: false }));
        }}
        open={editor.open}
      >
        <MappingEditor
          initialKey={editor.key}
          initialValue={editor.value}
          isNew={editor.rowId === null}
          key={editor.session}
          onApply={applyEditor}
        />
      </Dialog>
    </SettingsSection>
  );
}

/**
 * One mapping as a row of the card: its drag grip, its place in the order (the first match
 * wins), what it matches and what that becomes, and its menu (Edit, Move up, Move down, Delete).
 * On phones the target sits under the match.
 */
function MappingRowItem({
  row,
  index,
  count,
  error,
  filtering,
  onEdit,
  onMove,
  onDelete,
  register,
}: {
  row: MappingRow;
  index: number;
  count: number;
  /** The server's reason when this row stopped the save; null otherwise. */
  error: string | null;
  /** While the list is filtered, rows cannot be reordered. */
  filtering: boolean;
  onEdit: () => void;
  onMove: (to: number) => void;
  onDelete: () => void;
  register: (element: HTMLElement | null) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.id,
    disabled: filtering,
    attributes: { roleDescription: t("modelMappings.roleDescription") },
  });
  const n = index + 1;

  return (
    <li
      aria-label={t("modelMappings.rowLabel", { n })}
      className={cn(
        ROW_GRID,
        "relative py-1",
        // Opaque while dragged, so it covers the rows it passes.
        // A barely-there lift: an opaque fill and a hairline, no heavy shadow.
        isDragging && "z-10 rounded-lg bg-background shadow-xs outline-1 outline-border/60",
        error !== null && "bg-destructive/6",
      )}
      data-error={error !== null || undefined}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {filtering ? (
        <span aria-hidden="true" className="size-8 sm:size-7" />
      ) : (
        <Button
          aria-label={t("modelMappings.drag")}
          className="cursor-grab touch-none active:cursor-grabbing"
          ref={setActivatorNodeRef}
          size="icon-sm"
          title={t("modelMappings.drag")}
          variant="quiet"
          {...attributes}
          {...listeners}
        >
          <HugeiconsIcon icon={GripVerticalIcon} aria-hidden="true" />
        </Button>
      )}
      <span className="hidden text-end text-muted-foreground text-xs sm:block">{n}</span>
      {/* One cell on phones (match over target), three columns from sm. */}
      <div className="flex min-w-0 flex-col gap-0.5 sm:contents">
        {/* Each name with the mark of the company behind it. */}
        <span className="flex min-w-0 items-center gap-2">
          <ModelLogo model={row.key} />
          <code className="truncate text-foreground text-sm" title={row.key} translate="no">
            {row.key}
          </code>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 sm:contents">
          <HugeiconsIcon
            icon={ArrowRight02Icon}
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground sm:size-4"
          />
          <span className="flex min-w-0 items-center gap-2">
            <ModelLogo model={row.value} />
            <code
              className="truncate text-muted-foreground text-sm sm:text-foreground"
              title={row.value}
              translate="no"
            >
              {row.value}
            </code>
          </span>
        </span>
      </div>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={t("modelMappings.rowActions", { n })}
              className="size-10 md:size-8"
              ref={register}
              size="icon"
              variant="quiet"
            />
          }
        >
          <HugeiconsIcon icon={EllipsisIcon} aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-44">
          <MenuItem onClick={onEdit}>
            <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
            {t("modelMappings.edit")}
          </MenuItem>
          <MenuItem disabled={filtering || index === 0} onClick={() => onMove(index - 1)}>
            <HugeiconsIcon icon={ArrowUp02Icon} aria-hidden="true" />
            {t("modelMappings.moveUp")}
          </MenuItem>
          <MenuItem disabled={filtering || index === count - 1} onClick={() => onMove(index + 1)}>
            <HugeiconsIcon icon={ArrowDown02Icon} aria-hidden="true" />
            {t("modelMappings.moveDown")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={onDelete} variant="destructive">
            <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
            {t("modelMappings.delete")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {error ? (
        <p
          className="col-span-full pt-1 pb-1 text-destructive-foreground text-xs sm:col-start-3"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The mapping editor: the text to look for in the client's model name and the Kiro model ID it
 * becomes, side by side. Both are needed. Apply hands them back to the draft.
 */
function MappingEditor({
  initialKey,
  initialValue,
  isNew,
  onApply,
}: {
  initialKey: string;
  initialValue: string;
  isNew: boolean;
  onApply: (key: string, value: string) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  const [key, setKey] = useState(initialKey);
  const [value, setValue] = useState(initialValue);
  const ready = key.trim() !== "" && value.trim() !== "";

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
          if (ready) onApply(key.trim(), value.trim());
        }}
      >
        <DialogHeader>
          <DialogTitle>{isNew ? t("modelMappings.add") : t("modelMappings.edit")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end sm:gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={`${id}-key`}>{t("modelMappings.match")}</Label>
              {/* The mark follows the name as it is typed. */}
              <InputGroup>
                <InputGroupAddon>
                  <ModelLogo model={key || t("modelMappings.matchPlaceholder")} />
                </InputGroupAddon>
                <InputGroupInput
                  autoComplete="off"
                  id={`${id}-key`}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={t("modelMappings.matchPlaceholder")}
                  spellCheck={false}
                  value={key}
                />
              </InputGroup>
            </div>
            <HugeiconsIcon
              icon={ArrowRight02Icon}
              aria-hidden="true"
              className="mb-2 hidden size-4 text-muted-foreground sm:block"
            />
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={`${id}-value`}>{t("modelMappings.target")}</Label>
              <InputGroup>
                <InputGroupAddon>
                  <ModelLogo model={value || t("modelMappings.targetPlaceholder")} />
                </InputGroupAddon>
                <InputGroupInput
                  autoComplete="off"
                  id={`${id}-value`}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={t("modelMappings.targetPlaceholder")}
                  spellCheck={false}
                  value={value}
                />
              </InputGroup>
            </div>
          </div>
          <ul className="flex flex-col gap-2 text-muted-foreground text-xs leading-normal">
            <li className="flex gap-2">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0"
              />
              <span className="text-pretty">{t("modelMappings.matchHint")}</span>
            </li>
            <li className="flex gap-2">
              <HugeiconsIcon
                icon={ArrowRight02Icon}
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0"
              />
              <span className="text-pretty">{t("modelMappings.targetHint")}</span>
            </li>
          </ul>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <Button disabled={!ready} type="submit">
            {isNew ? t("modelMappings.add") : t("modelMappings.apply")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
