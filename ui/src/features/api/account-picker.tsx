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
import { tagKey } from "@/features/accounts/account-metadata";
import { accountsQuery } from "@/lib/api/accounts";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { type ApiKeyAccountScope, MAX_KEY_TAGS } from "./api-key-form";

const SCOPES: readonly ApiKeyAccountScope[] = ["all", "selected"];

/** One tag the picker offers: the first spelling seen, and how many accounts carry it. */
interface TagOption {
  tag: string;
  count: number;
}

/** Every tag on the accounts, case-insensitively once, most used first, then by name. */
export function tagOptions(accounts: readonly Account[]): TagOption[] {
  const byKey = new Map<string, TagOption>();
  for (const account of accounts) {
    for (const tag of account.tags ?? []) {
      const option = byKey.get(tagKey(tag));
      if (option) option.count++;
      else byKey.set(tagKey(tag), { tag, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The accounts a scope reaches: the picked ids plus every account carrying a picked tag. */
export function scopedAccountIds(
  accounts: readonly Account[],
  ids: readonly string[],
  tags: readonly string[],
): Set<string> {
  const out = new Set(ids);
  const keys = new Set(tags.map(tagKey));
  for (const account of accounts) {
    if ((account.tags ?? []).some((tag) => keys.has(tagKey(tag)))) out.add(account.id);
  }
  return out;
}

/**
 * Which accounts a key may use: every account, or the ones picked here. The list searches what
 * it shows (the email as privacy mode displays it, the nickname, the id), so under privacy a
 * search never matches the hidden part of an address. Picks of accounts deleted since stay as
 * "Removed account" rows until unchecked: they match nothing, and dropping them silently could
 * empty the list, which would mean every account. Until the list has loaded no pick counts as
 * removed, so a slow or failed load shows its state instead of every pick as removed.
 *
 * Tags pick accounts too: every account carrying a picked tag joins the picked ones, now and
 * whenever an account is tagged later. A picked tag no account carries stays listed with a
 * warning, as such a key gets no account at all.
 */
export function AccountPicker({
  scope,
  selected,
  tags = [],
  onScopeChange,
  onSelectedChange,
  onTagsChange,
  invalid,
  searchRef,
}: {
  scope: ApiKeyAccountScope;
  selected: readonly string[];
  /** Picked account tags. */
  tags?: readonly string[];
  onScopeChange: (scope: ApiKeyAccountScope) => void;
  onSelectedChange: (ids: string[]) => void;
  onTagsChange?: (tags: string[]) => void;
  /** "Only selected" with nothing picked. */
  invalid: boolean;
  /** Where focus goes when the picks are invalid. */
  searchRef?: Ref<HTMLInputElement>;
}): JSX.Element {
  const { t } = useT("api");
  const { t: ta } = useT("accounts");
  const { t: tc } = useT();
  const accountName = useAccountName();
  const mask = useMaskText();
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

  const options = useMemo(() => tagOptions(list), [list]);
  const pickedTags = new Set(tags.map(tagKey));
  const strayTags = loaded
    ? tags.filter((tag) => !options.some((option) => tagKey(option.tag) === tagKey(tag)))
    : [];
  const tagRows: TagOption[] = [...options, ...strayTags.map((tag) => ({ tag, count: 0 }))];
  const toggleTag = (tag: string) => {
    if (!onTagsChange) return;
    const key = tagKey(tag);
    if (pickedTags.has(key)) onTagsChange(tags.filter((x) => tagKey(x) !== key));
    else if (tags.length < MAX_KEY_TAGS) onTagsChange([...tags, tag]);
  };
  const reached = scopedAccountIds(list, selected, tags);
  const reachedKnown = [...reached].filter((id) => known.has(id)).length;

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
          {onTagsChange && tagRows.length > 0 ? (
            <fieldset className="flex min-w-0 flex-col gap-1.5">
              <legend className="mb-1.5 text-muted-foreground text-xs">
                {t("form.accountTags")}
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {tagRows.map((option) => {
                  const id = `${baseId}-tag-${tagKey(option.tag)}`;
                  const checked = pickedTags.has(tagKey(option.tag));
                  return (
                    <Label
                      className="min-w-0"
                      htmlFor={id}
                      key={tagKey(option.tag)}
                      variant="option"
                    >
                      <Checkbox
                        checked={checked}
                        disabled={!checked && tags.length >= MAX_KEY_TAGS}
                        id={id}
                        onCheckedChange={() => toggleTag(option.tag)}
                      />
                      <span className="min-w-0 truncate">{mask(option.tag)}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {option.count > 0
                          ? t("form.accountTagCount", { n: option.count })
                          : t("form.accountTagNone")}
                      </span>
                    </Label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
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
              {tags.length > 0
                ? t("form.accountsReachedCount", { n: reachedKnown, total: list.length })
                : t("form.accountsSelectedCount", {
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
