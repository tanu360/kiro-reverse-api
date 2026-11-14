import {
  CircleCheckIcon,
  CircleXIcon,
  PlayIcon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useId,
  useState,
} from "react";
import { ModelLogo } from "@/components/shared/model-logo";
import { MODEL_MAKERS } from "@/components/shared/model-logos";
import { Button } from "@/components/ui/button";
import { CommandHint } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { type TFunction, useT } from "@/lib/i18n";
import { modelOrigin } from "@/lib/model-maker";
import { cn } from "@/lib/utils";

/** What the picker shows of a model's latest run (the dialog's own run type fits it). */
export type PickerRun =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "ok"; seconds: string }
  | { kind: "err" };

/** The key the search row shows; a key name, the same in every language. */
const ESCAPE_KEY = "Esc";

/*
 * Clicks inside the picker never take the focus from the search field: the field holds the
 * keyboard (↑ ↓ Home End Enter), so after a click on an option, a chip or Clear the arrows still
 * move the highlight. The click itself still goes through.
 */
function keepSearchFocus(event: MouseEvent): void {
  event.preventDefault();
}

interface Family {
  key: string;
  name: string;
  models: string[];
}

/** The models by their maker, in the order the makers first appear; unknown names go last. */
function familiesOf(models: readonly string[], t: TFunction): Family[] {
  const byKey = new Map<string, Family>();
  for (const model of models) {
    const origin = modelOrigin(model);
    const key = origin ?? "other";
    let family = byKey.get(key);
    if (!family) {
      const name =
        origin === "kiro"
          ? t("test.family.kiro")
          : origin
            ? MODEL_MAKERS[origin].name
            : t("test.family.other");
      family = { key, name, models: [] };
      byKey.set(key, family);
    }
    family.models.push(model);
  }
  const families = [...byKey.values()];
  const other = families.findIndex((family) => family.key === "other");
  if (other >= 0) families.push(...families.splice(other, 1));
  return families;
}

/** A model's latest run at the end of its option: the time, Failed, Running or Queued. */
function RunHint({ run }: { run: PickerRun | undefined }): JSX.Element | null {
  const { t } = useT("accounts");
  if (!run) return null;
  if (run.kind === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-success-foreground tabular-nums">
        <HugeiconsIcon aria-hidden="true" className="size-3.5" icon={CircleCheckIcon} />
        {t("test.seconds", { seconds: run.seconds })}
      </span>
    );
  }
  if (run.kind === "err") {
    return (
      <span className="inline-flex items-center gap-1 text-destructive-foreground">
        <HugeiconsIcon aria-hidden="true" className="size-3.5" icon={CircleXIcon} />
        {t("test.status.failed")}
      </span>
    );
  }
  if (run.kind === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Spinner aria-hidden="true" className="size-3" />
        {t("test.status.running")}
      </span>
    );
  }
  return <span className="text-muted-foreground">{t("test.status.queued")}</span>;
}

/**
 * The tester's model picker, a palette hung under the request bar: a search row that also takes
 * a model name that is not cached, chips that narrow the list to one maker, the models grouped by
 * maker (each with its mark, its latest result and a check when picked), and a foot with the pick
 * count, Select all (the models in view), Clear and the run button. Only the list scrolls, with no
 * scrollbar, so the search row and the foot stay in sight. The search field drives the list from
 * the keyboard (↑ ↓ move, Enter picks), as a combobox over a multi-select listbox; clicks keep the
 * focus in it.
 */
export function TestModelPicker({
  models,
  picked,
  runs,
  onToggle,
  onSet,
  onAdd,
  onRun,
  count,
  canRun,
  searchRef,
}: {
  models: readonly string[];
  picked: ReadonlySet<string>;
  runs: Readonly<Record<string, PickerRun>>;
  onToggle: (model: string, checked: boolean) => void;
  /** Picks (or drops) several models at once: the models in view, or all of them. */
  onSet: (models: readonly string[], checked: boolean) => void;
  onAdd: (model: string) => void;
  onRun: () => void;
  /** How many picked models a run tests (the Test button's number). */
  count: number;
  canRun: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  const { t } = useT("accounts");
  const { t: tc } = useT();
  const listId = useId();
  const optionId = useId();
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const families = familiesOf(models, t);
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const shown = families
    .filter((group) => family === null || group.key === family)
    .map((group) => ({
      ...group,
      models: needle
        ? group.models.filter((model) => model.toLowerCase().includes(needle))
        : group.models,
    }))
    .filter((group) => group.models.length > 0);
  const canAdd = typed !== "" && !models.includes(typed);
  const inView = shown.flatMap((group) => group.models);
  const allInViewPicked = inView.every((model) => picked.has(model));
  // Every option in order, for the arrow keys: the shown models, then "Add" for a typed name.
  const options = [...inView, ...(canAdd ? [null] : [])];
  const activeIndex = Math.min(active, options.length - 1);
  const domId = (index: number) => `${optionId}-${index}`;

  // A new search or maker starts the highlight at the top again.
  const search = (value: string) => {
    setQuery(value);
    setActive(0);
  };
  const narrow = (key: string | null) => {
    setFamily(key);
    setActive(0);
  };
  /** Highlights an option from the keyboard and scrolls it into view (the pointer never scrolls). */
  const highlight = (next: number) => {
    setActive(next);
    document.getElementById(domId(next))?.scrollIntoView?.({ block: "nearest" });
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    if (option === null) {
      onAdd(typed);
      search("");
      return;
    }
    onToggle(option, !picked.has(option));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An IME still composing owns Enter and the arrows.
    if (event.nativeEvent.isComposing) return;
    const last = options.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (last < 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      highlight((activeIndex + step + options.length) % options.length);
    } else if ((event.key === "Home" || event.key === "End") && !query) {
      // With text in the field, Home and End move the caret instead.
      event.preventDefault();
      if (last >= 0) highlight(event.key === "Home" ? 0 : last);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  let index = -1;
  const option = (model: string) => {
    index += 1;
    const at = index;
    const selected = picked.has(model);
    return (
      <div
        aria-selected={selected}
        className={cn(
          "grid h-9 cursor-pointer grid-cols-[--spacing(4)_minmax(0,1fr)_auto_--spacing(4)] items-center gap-2.5 rounded-lg px-2 text-meta",
          selected && "bg-primary/6",
          at === activeIndex && (selected ? "bg-primary/10" : "bg-accent"),
        )}
        data-model={model}
        id={domId(at)}
        key={model}
        onClick={() => choose(at)}
        onKeyDown={onKeyDown}
        onMouseDown={keepSearchFocus}
        onPointerMove={() => setActive(at)}
        role="option"
        tabIndex={-1}
      >
        <ModelLogo model={model} />
        <span className="truncate font-mono text-foreground">{model}</span>
        <RunHint run={runs[model]} />
        {selected ? (
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4 text-primary"
            icon={Tick02Icon}
            strokeWidth={2.5}
          />
        ) : (
          <span />
        )}
      </div>
    );
  };

  return (
    // As tall as the room under the bar allows: the list gives way, the rows around it never do.
    <div className="flex max-h-[min(var(--available-height),30rem)] w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-border-subtle border-b ps-3.5 pe-3 text-muted-foreground">
        <HugeiconsIcon aria-hidden="true" className="size-4 shrink-0" icon={Search01Icon} />
        <input
          aria-activedescendant={activeIndex >= 0 ? domId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-label={t("test.searchModels")}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent p-0 text-foreground text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => search(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("test.searchModels")}
          ref={searchRef}
          role="combobox"
          spellCheck={false}
          value={query}
        />
        <Kbd aria-hidden="true" className="shrink-0 pointer-coarse:hidden">
          {ESCAPE_KEY}
        </Kbd>
      </div>

      {/* One maker at a time, once the list holds more than one. */}
      {families.length > 1 ? (
        <fieldset
          aria-label={t("test.familyFilter")}
          className="scrollbar-none scroll-fade-x m-0 flex min-w-0 shrink-0 gap-1.5 overflow-x-auto border-0 px-3 pt-2.5 pb-1"
        >
          {[{ key: null, name: t("test.allFamilies"), models }, ...families].map((group) => {
            const on = family === group.key;
            return (
              <button
                aria-pressed={on}
                className={cn(
                  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-meta focus-visible:focus-outline",
                  on
                    ? "bg-foreground text-background"
                    : "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent hover:text-foreground",
                )}
                key={group.key ?? "all"}
                onClick={() => narrow(group.key)}
                onMouseDown={keepSearchFocus}
                type="button"
              >
                {group.key ? <ModelLogo model={group.models[0]} /> : null}
                {group.name}
                <span
                  className={cn(
                    "tabular-nums",
                    on ? "opacity-80 dark:opacity-64" : "text-muted-foreground",
                  )}
                >
                  {group.models.length}
                </span>
              </button>
            );
          })}
        </fieldset>
      ) : null}

      <div
        aria-label={t("test.pickModels")}
        aria-multiselectable="true"
        className="scrollbar-none scroll-fade-y flex min-h-0 flex-col overflow-y-auto px-1.5 pt-1 pb-1.5"
        id={listId}
        role="listbox"
      >
        {shown.map((group) => (
          // A fieldset is the group role: the one child, besides options, a listbox may own.
          <fieldset aria-label={group.name} className="m-0 min-w-0 border-0 p-0" key={group.key}>
            <div className="px-2 pt-2.5 pb-1 text-meta text-muted-foreground">
              <span className="font-medium text-foreground">{group.name}</span>
              <span className="tabular-nums">{` · ${group.models.length}`}</span>
            </div>
            {group.models.map(option)}
          </fieldset>
        ))}
        {canAdd
          ? (() => {
              index += 1;
              const at = index;
              return (
                <div
                  aria-selected={false}
                  className={cn(
                    "mt-1 flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm",
                    at === activeIndex && "bg-accent",
                  )}
                  id={domId(at)}
                  onClick={() => choose(at)}
                  onKeyDown={onKeyDown}
                  onMouseDown={keepSearchFocus}
                  onPointerMove={() => setActive(at)}
                  role="option"
                  tabIndex={-1}
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                    icon={PlusSignIcon}
                  />
                  <span className="min-w-0 truncate">{t("test.addTyped", { model: typed })}</span>
                </div>
              );
            })()
          : null}
        {options.length === 0 ? (
          <p className="px-2 py-3 text-center text-muted-foreground text-sm">
            {t("test.noMatches")}
          </p>
        ) : null}
      </div>

      <div className="flex h-12 shrink-0 items-center gap-3 border-border-subtle border-t ps-3.5 pe-2 text-meta text-muted-foreground max-sm:ps-2">
        {/* Phones skip the count, which the Test button repeats, so the row fits in every language. */}
        <span className="shrink-0 tabular-nums max-sm:hidden">
          {t("test.pickedCount", { count })}
        </span>
        {/* The models in view: all of them, or one maker's, or what the search matched. */}
        <Button
          disabled={allInViewPicked}
          onClick={() => onSet(inView, true)}
          onMouseDown={keepSearchFocus}
          size="xs"
          variant="ghost"
        >
          {t("test.selectAll")}
        </Button>
        <Button
          disabled={picked.size === 0}
          onClick={() => onSet([...picked], false)}
          onMouseDown={keepSearchFocus}
          size="xs"
          variant="ghost"
        >
          {t("test.clearSelection")}
        </Button>
        {/*
          The key hints only while they fit (Portuguese and Vietnamese labels run long): after an
          empty first item they wrap, as one, onto a second line the row's height hides.
        */}
        <span className="flex h-5 min-w-0 flex-1 flex-wrap items-center justify-end overflow-hidden max-sm:hidden">
          <span aria-hidden="true" className="h-full" />
          <span className="flex shrink-0 items-center gap-3">
            <CommandHint keys={["↑", "↓"]} label={tc("shell.command.move")} />
            <CommandHint keys={["↵"]} label={t("test.keyPick")} />
          </span>
        </span>
        <Button className="max-sm:ms-auto" disabled={!canRun} onClick={onRun} size="xs">
          <HugeiconsIcon aria-hidden="true" icon={PlayIcon} />
          {t("test.runSelected", { count })}
        </Button>
      </div>
    </div>
  );
}
