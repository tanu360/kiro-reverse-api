import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type Ref, useId, useMemo, useState } from "react";
import { ChoiceCard, ChoiceList } from "@/components/shared/choice-card";
import { ErrorState } from "@/components/shared/error-state";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldHint } from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { accountMeta, useAccountName } from "@/features/accounts/account-cells";
import { accountsQuery } from "@/lib/api/accounts";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import type { ApiKeyAccountScope } from "./api-key-form";

const SCOPES: readonly ApiKeyAccountScope[] = ["all", "selected"];

/**
 * Which accounts a key may use: every account, or the ones picked here. The list searches what
 * it shows (the email as privacy mode displays it, the nickname, the id), so under privacy a
 * search never matches the hidden part of an address. Picks of accounts deleted since stay as
 * "Removed account" rows until unchecked: they match nothing, and dropping them silently could
 * empty the list, which would mean every account. Until the list has loaded no pick counts as
 * removed, so a slow or failed load shows its state instead of every pick as removed.
 */
export function AccountPicker({
  scope,
  selected,
  onScopeChange,
  onSelectedChange,
  invalid,
  searchRef,
}: {
  scope: ApiKeyAccountScope;
  selected: readonly string[];
  onScopeChange: (scope: ApiKeyAccountScope) => void;
  onSelectedChange: (ids: string[]) => void;
  /** "Only selected" with nothing picked. */
  invalid: boolean;
  /** Where focus goes when the picks are invalid. */
  searchRef?: Ref<HTMLInputElement>;
}): JSX.Element {
  const { t } = useT("api");
  const { t: ta } = useT("accounts");
  const { t: tc } = useT();
  const accountName = useAccountName();
  const accounts = useQuery(accountsQuery());
  const [query, setQuery] = useState("");
  const baseId = useId();
  const errorId = `${baseId}-error`;
  const loaded = accounts.data !== undefined;
  const list = accounts.data ?? [];

  const picked = useMemo(() => new Set(selected), [selected]);
  const known = useMemo(() => new Set(list.map((account) => account.id)), [list]);
  const removed = loaded ? selected.filter((id) => !known.has(id)) : [];
  const needle = query.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(needle);
  const visible = needle
    ? list.filter(
        (account) =>
          matches(accountName(account).text) || matches(account.nickname) || matches(account.id),
      )
    : list;
  const visibleRemoved = needle ? removed.filter(matches) : removed;

  const toggle = (id: string) =>
    onSelectedChange(picked.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const description = (account: Account) =>
    [accountMeta(account, ta), account.enabled ? "" : t("form.accountsDisabled")]
      .filter(Boolean)
      .join(" · ");

  const rows = !loaded ? (
    accounts.isError ? (
      <ErrorState
        compact
        error={accounts.error}
        onRetry={() => void accounts.refetch()}
        retrying={accounts.isFetching}
        title={t("form.accountsLoadFailed")}
      />
    ) : (
      <p className="py-4 text-center text-muted-foreground text-sm">{tc("state.loading")}</p>
    )
  ) : visible.length + visibleRemoved.length > 0 ? (
    <ChoiceList aria-label={t("form.accounts")} scroll>
      {visible.map((account) => {
        const name = accountName(account);
        return (
          <ChoiceCard
            control={(id) => (
              <Checkbox
                checked={picked.has(account.id)}
                id={id}
                onCheckedChange={() => toggle(account.id)}
              />
            )}
            description={description(account) || undefined}
            key={account.id}
            title={
              <span className={name.mono ? "font-mono text-meta" : undefined}>{name.text}</span>
            }
            variant="row"
          />
        );
      })}
      {visibleRemoved.map((id) => (
        <ChoiceCard
          control={(controlId) => (
            <Checkbox checked id={controlId} onCheckedChange={() => toggle(id)} />
          )}
          key={id}
          title={t("form.accountsRemoved")}
          variant="row"
        >
          <span className="break-all font-mono text-meta text-muted-foreground">{id}</span>
        </ChoiceCard>
      ))}
    </ChoiceList>
  ) : (
    <p className="py-4 text-center text-muted-foreground text-sm">
      {list.length === 0 && removed.length === 0 ? t("form.accountsEmpty") : tc("state.noMatches")}
    </p>
  );

  return (
    <Fieldset className="flex min-w-0 flex-col gap-3">
      <FieldsetLegend>{t("form.accounts")}</FieldsetLegend>
      {/* The option rows are 40 px tall (44 px on touch), so they need no gap between them. */}
      <RadioGroup
        aria-label={t("form.accounts")}
        className="gap-0"
        onValueChange={(value) => onScopeChange(value as ApiKeyAccountScope)}
        value={scope}
      >
        {SCOPES.map((value) => (
          <Label className="self-start" htmlFor={`${baseId}-${value}`} key={value} variant="option">
            <Radio id={`${baseId}-${value}`} value={value} />
            {value === "all" ? t("form.accountsAll") : t("form.accountsSelected")}
          </Label>
        ))}
      </RadioGroup>
      {scope === "selected" ? (
        <div className="flex min-w-0 flex-col gap-2">
          <InputGroup>
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-describedby={invalid ? errorId : undefined}
              aria-invalid={invalid || undefined}
              aria-label={t("form.accountsSearch")}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("form.accountsSearch")}
              ref={searchRef}
              type="search"
              value={query}
            />
          </InputGroup>
          {/* Under the search, which takes focus on the error, so it is in view on a phone. */}
          {invalid ? (
            <p
              className="text-destructive-foreground text-xs leading-normal"
              id={errorId}
              role="alert"
            >
              {t("form.accountsRequired")}
            </p>
          ) : null}
          {rows}
          {loaded ? (
            <p aria-live="polite" className="text-muted-foreground text-xs tabular-nums">
              {t("form.accountsSelectedCount", {
                n: selected.length,
                total: list.length + removed.length,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      <FieldHint>{t("form.accountsHint")}</FieldHint>
    </Fieldset>
  );
}
