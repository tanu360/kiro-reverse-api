import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type Ref, useId, useState } from "react";
import { ChoiceCard, ChoiceList } from "@/components/shared/choice-card";
import { ErrorState } from "@/components/shared/error-state";
import { ModelLogo } from "@/components/shared/model-logo";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { keyModelsQuery } from "@/lib/api/api-keys";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { MAX_KEY_MODELS } from "./api-key-form";

const lower = (model: string) => model.toLowerCase();

interface ModelPicksProps {
  selected: readonly string[];
  onSelectedChange: (models: string[]) => void;
  /** "Only selected models" with nothing ticked, or too many. */
  invalid?: string;
  /** Where focus goes when the picks are invalid. */
  searchRef?: Ref<HTMLInputElement>;
}

/**
 * Which models a key may call: every model, or the ticked ones. The list is what the server
 * offers (GET /models: the accounts' models, then auto); a ticked name it no longer offers stays
 * listed, ticked, until unticked, so editing a key never drops one silently. Names compare
 * case-insensitively, as the server's check does. At most MAX_KEY_MODELS can be ticked.
 */
export function ModelPicks({
  selected,
  onSelectedChange,
  invalid,
  searchRef,
}: ModelPicksProps): JSX.Element {
  const { t, lang } = useT("api");
  const { t: tc } = useT();
  const models = useQuery(keyModelsQuery());
  const [query, setQuery] = useState("");
  const baseId = useId();
  const errorId = `${baseId}-error`;
  const offered = models.data ?? [];
  const picked = new Set(selected.map(lower));
  const known = new Set(offered.map(lower));
  const rows = [...offered, ...selected.filter((model) => !known.has(lower(model)))];
  const needle = query.trim().toLowerCase();
  const visible = needle ? rows.filter((model) => lower(model).includes(needle)) : rows;

  const toggle = (model: string) => {
    if (picked.has(lower(model))) {
      onSelectedChange(selected.filter((x) => lower(x) !== lower(model)));
    } else if (selected.length < MAX_KEY_MODELS) {
      onSelectedChange([...selected, model]);
    }
  };

  const list =
    models.data === undefined ? (
      models.isError ? (
        <ErrorState
          compact
          error={models.error}
          onRetry={() => void models.refetch()}
          retrying={models.isFetching}
          title={t("form.modelsLoadFailed")}
        />
      ) : (
        <p className="py-4 text-center text-muted-foreground text-sm">{tc("state.loading")}</p>
      )
    ) : visible.length > 0 ? (
      <ChoiceList aria-label={t("form.allowedModels")} scroll>
        {visible.map((model) => {
          const checked = picked.has(lower(model));
          return (
            <ChoiceCard
              control={(id) => (
                <Checkbox
                  checked={checked}
                  disabled={!checked && selected.length >= MAX_KEY_MODELS}
                  id={id}
                  onCheckedChange={() => toggle(model)}
                />
              )}
              key={lower(model)}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <ModelLogo model={model} />
                  <span className="min-w-0 truncate">{model}</span>
                </span>
              }
              variant="row"
            />
          );
        })}
      </ChoiceList>
    ) : (
      <p className="py-4 text-center text-muted-foreground text-sm">{tc("state.noMatches")}</p>
    );

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <InputGroup>
        <InputGroupAddon>
          <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid ? true : undefined}
          aria-label={t("form.modelsSearch")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("form.modelsSearch")}
          ref={searchRef}
          spellCheck={false}
          type="search"
          value={query}
        />
      </InputGroup>
      {/* Under the search, which takes focus on the error, so it is in view on a phone. */}
      {invalid ? (
        <p className="text-destructive-foreground text-xs leading-normal" id={errorId} role="alert">
          {invalid}
        </p>
      ) : null}
      {list}
      {models.data !== undefined ? (
        <p aria-live="polite" className="text-muted-foreground text-xs tabular-nums">
          {t("form.accountsSelectedCount", {
            n: formatNumber(selected.length, lang),
            total: formatNumber(rows.length, lang),
          })}
        </p>
      ) : null}
    </div>
  );
}
