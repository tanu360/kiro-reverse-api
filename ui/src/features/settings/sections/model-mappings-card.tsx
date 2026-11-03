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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { type JSX, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  SettingsSection,
  useSectionSave,
} from "./settings-section";

type FocusTarget = "key" | "value" | "up" | "down";

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
  const server = useMemo(() => rowsFromRules(data.mappings), [data.mappings]);
  const draft = useDraft<readonly MappingRow[]>(server, sameMappings);
  const rows = draft.value;
  const [errorRowId, setErrorRowId] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Inputs and move buttons by `${rowId}:${target}`, for focus after add, move and errors.
  const controls = useRef(new Map<string, HTMLElement>());
  const [pendingFocus, setPendingFocus] = useState<{ rowId: string; targets: FocusTarget[] }>();
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    setPendingFocus(undefined);
    for (const target of pendingFocus.targets) {
      const element = controls.current.get(`${pendingFocus.rowId}:${target}`);
      if (element && !(element as HTMLButtonElement).disabled) {
        element.focus();
        return;
      }
    }
  }, [pendingFocus]);

  const register = (rowId: string, target: FocusTarget) => (element: HTMLElement | null) => {
    if (element) controls.current.set(`${rowId}:${target}`, element);
    else controls.current.delete(`${rowId}:${target}`);
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
        const firstEmpty: FocusTarget[] = !row.key.trim()
          ? ["key"]
          : !row.value.trim()
            ? ["value"]
            : [];
        setPendingFocus({ rowId: row.id, targets: [...firstEmpty, "key"] });
      },
    },
  );

  const onSubmit = () => {
    clearError();
    const { mappings, rowIndexes } = prepareMappings(rows);
    save({ mappings, rowIndexes, rows });
  };

  const updateRow = (rowId: string, patch: Partial<Pick<MappingRow, "key" | "value">>) => {
    if (rowId === errorRowId) clearError();
    draft.set((prev) => prev.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  };

  const removeRow = (rowId: string) => {
    if (rowId === errorRowId) clearError();
    draft.set((prev) => prev.filter((row) => row.id !== rowId));
  };

  const move = (from: number, to: number, focus?: FocusTarget[]) => {
    const rowId = rows[from]?.id;
    draft.set((prev) => moveRow(prev, from, to));
    if (rowId && focus) setPendingFocus({ rowId, targets: focus });
  };

  // New rows go on top (parity) and take focus.
  const addRow = () => {
    const row: MappingRow = { id: newRowId(), key: "", value: "" };
    draft.set((prev) => [row, ...prev]);
    setPendingFocus({ rowId: row.id, targets: ["key"] });
  };

  // Local only until Save.
  const resetToDefaults = () => {
    clearError();
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
        <>
          <Button onClick={addRow} size="sm" variant="outline">
            <PlusIcon aria-hidden="true" />
            {t("modelMappings.add")}
          </Button>
          <Button onClick={resetToDefaults} size="sm" variant="outline">
            <RotateCcwIcon aria-hidden="true" />
            {t("modelMappings.reset")}
          </Button>
          <SaveButton dirty={draft.dirty} saving={saving} />
        </>
      }
      footer={
        <div className="flex w-full flex-col gap-1 text-muted-foreground text-xs">
          {draft.serverChanged ? <ServerChangedNotice onReload={reload} /> : null}
          <p>{t("modelMappings.emptyIgnored")}</p>
          <p>{t("modelMappings.resetNote")}</p>
        </div>
      }
      hint={t("modelMappingsHint")}
      id={SECTION_ID.modelMappings}
      onSubmit={onSubmit}
      title={t("modelMappings")}
    >
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
          {t("modelMappings.noRules")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div
            aria-hidden="true"
            className="hidden items-center gap-2 px-px font-medium text-muted-foreground text-xs sm:flex"
          >
            <span className="w-7 shrink-0" />
            <span className="min-w-0 flex-1">{t("modelMappings.match")}</span>
            <span className="w-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("modelMappings.target")}</span>
            <span className="w-[5.75rem] shrink-0" />
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
              items={rows.map((row) => row.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="flex flex-col gap-2">
                {rows.map((row, index) => (
                  <MappingRowItem
                    count={rows.length}
                    error={row.id === errorRowId}
                    index={index}
                    key={row.id}
                    onChange={(patch) => updateRow(row.id, patch)}
                    onMove={(to, focus) => move(index, to, focus)}
                    onRemove={() => removeRow(row.id)}
                    register={(target) => register(row.id, target)}
                    row={row}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </div>
      )}
      {serverError ? (
        <p className="mt-3 break-words text-destructive-foreground text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </SettingsSection>
  );
}

function MappingRowItem({
  row,
  index,
  count,
  error,
  onChange,
  onMove,
  onRemove,
  register,
}: {
  row: MappingRow;
  index: number;
  count: number;
  error: boolean;
  onChange: (patch: Partial<Pick<MappingRow, "key" | "value">>) => void;
  onMove: (to: number, focus: FocusTarget[]) => void;
  onRemove: () => void;
  register: (target: FocusTarget) => (element: HTMLElement | null) => void;
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
  } = useSortable({ id: row.id });
  const isFirst = index === 0;
  const isLast = index === count - 1;

  return (
    <li
      aria-label={t("modelMappings.rowLabel", { n: index + 1 })}
      className={cn(
        "relative flex items-start gap-2 rounded-lg bg-card sm:items-center",
        isDragging && "z-10 shadow-lg ring-1 ring-border",
        error && "rounded-lg ring-2 ring-destructive/60 ring-offset-2 ring-offset-card",
      )}
      data-error={error || undefined}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <Button
        aria-label={t("modelMappings.drag")}
        className="mt-0.5 shrink-0 cursor-grab touch-none active:cursor-grabbing sm:mt-0"
        ref={setActivatorNodeRef}
        size="icon-sm"
        title={t("modelMappings.drag")}
        variant="ghost"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon aria-hidden="true" />
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          aria-invalid={(error && !row.key.trim()) || undefined}
          aria-label={t("modelMappings.match")}
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => onChange({ key: event.target.value })}
          placeholder={t("modelMappings.matchPlaceholder")}
          ref={register("key")}
          spellCheck={false}
          value={row.key}
        />
        <ArrowRightIcon
          aria-hidden="true"
          className="hidden size-4 shrink-0 text-muted-foreground sm:block"
        />
        <Input
          aria-invalid={(error && !row.value.trim()) || undefined}
          aria-label={t("modelMappings.target")}
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => onChange({ value: event.target.value })}
          placeholder={t("modelMappings.targetPlaceholder")}
          ref={register("value")}
          spellCheck={false}
          value={row.value}
        />
      </div>
      <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
        <Button
          aria-label={t("modelMappings.moveUp")}
          disabled={isFirst}
          onClick={() => onMove(index - 1, ["up", "down"])}
          ref={register("up")}
          size="icon-sm"
          title={t("modelMappings.moveUp")}
          variant="ghost"
        >
          <ArrowUpIcon aria-hidden="true" />
        </Button>
        <Button
          aria-label={t("modelMappings.moveDown")}
          disabled={isLast}
          onClick={() => onMove(index + 1, ["down", "up"])}
          ref={register("down")}
          size="icon-sm"
          title={t("modelMappings.moveDown")}
          variant="ghost"
        >
          <ArrowDownIcon aria-hidden="true" />
        </Button>
        <Button
          aria-label={t("remove")}
          onClick={onRemove}
          size="icon-sm"
          title={t("remove")}
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}
