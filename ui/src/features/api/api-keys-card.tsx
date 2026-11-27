import {
  AlertCircleIcon,
  ArrowReloadHorizontalIcon,
  ChartLineData02Icon,
  CircleCheckIcon,
  CircleSlashIcon,
  Clock01Icon,
  Delete02Icon,
  EllipsisVerticalIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PencilEdit01Icon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  Route01Icon,
  Tag01Icon,
  Undo02Icon,
  UsersIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ActionError } from "@/components/shared/action-error";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { CopyButton } from "@/components/shared/copy-button";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { ListCard } from "@/components/shared/list-card";
import { RefreshButton } from "@/components/shared/page-header";
import { RelativeTime } from "@/components/shared/relative-time";
import { SectionCard } from "@/components/shared/section-card";
import { TruncatedText } from "@/components/shared/truncated-text";
import { UnlimitedMark } from "@/components/shared/unlimited-mark";
import { Badge, BadgeIcon, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardPanel } from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ROUTING_MODE_LABEL } from "@/features/accounts/use-routing-mode";
import { announce } from "@/lib/announce";
import {
  apiKeysQuery,
  deleteApiKey,
  getApiKey,
  regenerateApiKey,
  resetApiKeyUsage,
  updateApiKey,
} from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { settingsQuery } from "@/lib/api/settings";
import type { ApiKey } from "@/lib/api/types";
import {
  formatCredits,
  formatFraction,
  formatItems,
  formatNumber,
  formatRelativeTime,
} from "@/lib/format";
import { fillNodes, type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import {
  flooredShare,
  isKeyExpired,
  LIMIT_TONE_TEXT,
  limitReachedReason,
  limitTone,
  wouldLockOutClients,
} from "./api-key-form";
import { type ApiKeyDialogTarget, ApiKeyFormDialog } from "./api-key-form-dialog";
import { CreatedKeyPanel } from "./created-key-panel";
import { keyEntryRef } from "./key-usage-model";
import { ApiKeyUsageSheet } from "./key-usage-sheet";

/**
 * Narrower tables drop the columns the usage sheet also shows, as the accounts table drops Last
 * used first: Last used shows from a 1190 px table (74.375rem), Successful requests from 1100 px
 * (68.75rem). Container queries, not a measured width, so the first paint already has the right
 * columns. The name keeps about 180 px either way.
 */
const LAST_USED_CELL = "hidden @[74.375rem]/data-table:table-cell";
const REQUESTS_CELL = "hidden @[68.75rem]/data-table:table-cell";
/**
 * Ten keys a page, as cards (below DataTable's `cardsBelow="4xl"`, a 56rem container: the table,
 * its narrow columns gone, needs about 900 px) or as the table, so the card stays about a screen
 * tall either way.
 */
const PAGE_SIZE = 10;

interface DialogState {
  open: boolean;
  target: ApiKeyDialogTarget;
  /** Bumped on every opening so the dialog remounts with fresh values. */
  session: number;
}

/** A row action that can fail; its failure shows above the table until retried or closed. */
type KeyAction = "toggle" | "reset" | "regenerate" | "remove";

interface KeyFailure {
  action: KeyAction;
  /** The key as it was when the action started (toggle's direction comes from it). */
  apiKey: ApiKey;
  error: unknown;
}

/** The key's name, with any e-mail in it masked in privacy mode, as Usage by key shows it. */
function keyName(apiKey: ApiKey, t: TFunction, mask: (text?: string) => string): string {
  return apiKey.name ? mask(apiKey.name) : t("keys.unnamed");
}

/** Whether Reset usage would change anything: it zeroes these four (config ResetApiKeyUsage). */
function hasUsage(apiKey: ApiKey): boolean {
  return (
    apiKey.tokensUsed > 0 ||
    apiKey.creditsUsed > 0 ||
    apiKey.requestsCount > 0 ||
    (apiKey.successfulCalls ?? 0) > 0
  );
}

/** The full secret is fetched on demand for each copy and never cached. */
function fetchSecret(id: string): Promise<string> {
  return getApiKey(id).then((detail) => detail.key);
}

/** Shown, not inside the layout CSS hides (the table and the cards are both rendered). */
function isShown(element: HTMLElement): boolean {
  return typeof element.checkVisibility === "function" ? element.checkVisibility() : true;
}

export function ApiKeysCard(): JSX.Element {
  const { t, lang } = useT("api");
  const mask = useMaskText();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const keys = useQuery(apiKeysQuery());
  const settings = useQuery(settingsQuery());
  const requireApiKey = settings.data?.requireApiKey ?? false;
  const [dialog, setDialog] = useState<DialogState>({
    open: false,
    target: { mode: "create" },
    session: 0,
  });
  // The full secret from the last create or regenerate, shown once.
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  // The key whose usage chart is open; kept while the sheet closes, a new session per opening.
  const [usageFor, setUsageFor] = useState<{
    apiKey: ApiKey;
    open: boolean;
    session: number;
  } | null>(null);
  const [page, setPage] = useState(1);
  // The last row action that failed, shown at the top of the card.
  const [failure, setFailure] = useState<KeyFailure | null>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  // Row menu triggers by key id (one in the table, one in the cards), so focus can land on a
  // neighbour when a row goes away.
  const triggers = useRef(new Map<string, Set<HTMLButtonElement>>());
  const focusAfterDelete = useRef<{ id: string; order: string[] } | null>(null);
  const triggerRef = useCallback(
    (id: string) => (element: HTMLButtonElement | null) => {
      if (!element) return;
      const set = triggers.current.get(id) ?? new Set<HTMLButtonElement>();
      set.add(element);
      triggers.current.set(id, set);
      return () => {
        set.delete(element);
        if (set.size === 0) triggers.current.delete(id);
      };
    },
    [],
  );

  const list = keys.data ?? [];
  const editingId = dialog.open && dialog.target.mode === "edit" ? dialog.target.apiKey.id : null;
  const pageSize = PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = list.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const disabledCount = list.filter((apiKey) => !apiKey.enabled).length;
  // A failure about a key deleted since (in another tab) has nothing left to retry: it goes.
  const shownFailure =
    failure && list.some((apiKey) => apiKey.id === failure.apiKey.id) ? failure : null;

  // The key being edited was deleted elsewhere: nothing is left to save.
  useEffect(() => {
    if (editingId && keys.data && !keys.data.some((k) => k.id === editingId)) {
      setDialog((prev) => ({ ...prev, open: false }));
    }
  }, [editingId, keys.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });

  // After a delete the row and its focused menu trigger are gone: focus the next row's trigger,
  // else the previous one, else Create API key.
  useEffect(() => {
    const pending = focusAfterDelete.current;
    if (!pending || !keys.data || keys.data.some((k) => k.id === pending.id)) return;
    focusAfterDelete.current = null;
    // Focus is lost (on <body>), or still in the closing confirm, which would drop it next.
    const active = document.activeElement;
    const lost = !active || active === document.body || active.closest('[role="alertdialog"]');
    if (!lost) return;
    const index = pending.order.indexOf(pending.id);
    const candidates = [
      ...pending.order.slice(index + 1),
      ...pending.order.slice(0, index).reverse(),
    ];
    for (const id of candidates) {
      const shown = [...(triggers.current.get(id) ?? [])].find(isShown);
      if (shown) {
        shown.focus();
        return;
      }
    }
    createRef.current?.focus();
  }, [keys.data]);

  /*
   * The row shows the result itself (the status pill, the usage, the row going away, the new-key
   * panel), a screen reader hears it, and a failure shows in the card (KeyFailure).
   * Each stays pending until the list is refetched, so the pill never flips back for a moment.
   */
  const toggle = useMutation({
    mutationFn: (apiKey: ApiKey) => updateApiKey(apiKey.id, { enabled: !apiKey.enabled }),
    onMutate: () => setFailure(null),
    onSuccess: (_result, apiKey) => {
      announce(apiKey.enabled ? t("keys.disabled") : t("keys.enabled"));
    },
    onError: (error, apiKey) => setFailure({ action: "toggle", apiKey, error }),
    onSettled: invalidate,
  });

  const reset = useMutation({
    mutationFn: (apiKey: ApiKey) => resetApiKeyUsage(apiKey.id),
    onMutate: () => setFailure(null),
    onSuccess: (_result, apiKey) => {
      announce(
        apiKey.enabled
          ? t("keys.usageReset")
          : t("common:text.joinSentences", {
              first: t("keys.usageReset"),
              second: t("keys.usageResetDisabledHint"),
            }),
      );
    },
    onError: (error, apiKey) => setFailure({ action: "reset", apiKey, error }),
    onSettled: invalidate,
  });

  const regenerate = useMutation({
    mutationFn: (apiKey: ApiKey) => regenerateApiKey(apiKey.id),
    onMutate: () => setFailure(null),
    // The new-key panel is an alert: it is read out as it appears.
    onSuccess: (result) => setCreatedKey(result.key),
    onError: (error, apiKey) => setFailure({ action: "regenerate", apiKey, error }),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (apiKey: ApiKey) => deleteApiKey(apiKey.id),
    onMutate: () => setFailure(null),
    onSuccess: () => announce(t("keys.deleted")),
    onError: (error, apiKey) => {
      focusAfterDelete.current = null;
      setFailure({ action: "remove", apiKey, error });
    },
    onSettled: invalidate,
  });

  /** Focus the key's row menu (the table's or the card's, whichever shows), else Create. */
  const focusRow = (id: string) => {
    const shown = [...(triggers.current.get(id) ?? [])].find(isShown);
    (shown ?? createRef.current)?.focus();
  };

  // Try again runs the same action on the same key, without asking again: it was confirmed. The
  // notice goes, so focus moves to the key's row first.
  const retry = ({ action, apiKey }: KeyFailure) => {
    focusRow(apiKey.id);
    if (action === "toggle") toggle.mutate(apiKey);
    else if (action === "reset") reset.mutate(apiKey);
    else if (action === "regenerate") {
      setCreatedKey(null);
      regenerate.mutate(apiKey);
    } else {
      focusAfterDelete.current = { id: apiKey.id, order: list.map((k) => k.id) };
      remove.mutate(apiKey);
    }
  };

  const dismissFailure = (current: KeyFailure) => {
    setFailure(null);
    focusRow(current.apiKey.id);
  };

  // While a toggle or reset runs, its row says so where the result will show.
  const toggling = toggle.isPending ? toggle.variables : undefined;
  const resettingId = reset.isPending ? reset.variables?.id : undefined;
  const togglingText = (apiKey: ApiKey): string | null =>
    toggling?.id === apiKey.id
      ? toggling.enabled
        ? t("keys.disabling")
        : t("keys.enabling")
      : null;

  const openCreate = () => {
    setCreatedKey(null);
    setDialog((prev) => ({ open: true, target: { mode: "create" }, session: prev.session + 1 }));
  };

  const openEdit = (apiKey: ApiKey) => {
    setCreatedKey(null);
    setDialog((prev) => ({
      open: true,
      target: { mode: "edit", apiKey },
      session: prev.session + 1,
    }));
  };

  // Enable and disable never ask. The last enabled key while keys are required cannot be
  // disabled or deleted (409 api_key_lockout): its menu does not offer either.
  const onToggle = (apiKey: ApiKey) => {
    toggle.mutate(apiKey);
  };

  // The old value stops working at once, so it always asks.
  const onRegenerate = async (apiKey: ApiKey) => {
    const ok = await confirm({
      title: t("keys.confirmRegenerateTitle", { name: keyName(apiKey, t, mask) }),
      description: t("keys.confirmRegenerateBody"),
      confirmLabel: t("keys.regenerate"),
      variant: "danger",
    });
    if (!ok) return;
    setCreatedKey(null);
    regenerate.mutate(apiKey);
  };

  const onDelete = async (apiKey: ApiKey) => {
    const ok = await confirm({
      title: t("keys.confirmDeleteTitle", { name: keyName(apiKey, t, mask) }),
      description: t("keys.confirmDeleteBody"),
      confirmLabel: t("common:actions.delete"),
      variant: "danger",
    });
    if (!ok) return;
    focusAfterDelete.current = { id: apiKey.id, order: list.map((k) => k.id) };
    remove.mutate(apiKey);
  };

  const busyId =
    (toggle.isPending && toggle.variables?.id) ||
    (reset.isPending && reset.variables?.id) ||
    (regenerate.isPending && regenerate.variables?.id) ||
    (remove.isPending && remove.variables?.id) ||
    null;

  const actions = (apiKey: ApiKey) => (
    <KeyActions
      apiKey={apiKey}
      busy={busyId === apiKey.id}
      editing={editingId === apiKey.id}
      lastEnabledKey={wouldLockOutClients(list, apiKey.id, requireApiKey)}
      onDelete={() => void onDelete(apiKey)}
      onEdit={() => openEdit(apiKey)}
      onRegenerate={() => void onRegenerate(apiKey)}
      onReset={() => reset.mutate(apiKey)}
      onToggle={() => onToggle(apiKey)}
      onUsage={() =>
        setUsageFor((current) => ({ apiKey, open: true, session: (current?.session ?? 0) + 1 }))
      }
      triggerRef={triggerRef(apiKey.id)}
    />
  );

  const columns: DataTableColumn<ApiKey>[] = [
    {
      id: "name",
      header: t("keys.name"),
      // Takes the width the other columns leave and cuts a long name, so the table never
      // scrolls sideways (w-full with max-w-0 lets the cell shrink below its text).
      className: "w-full max-w-0",
      // The name over its access settings (one muted line), like an account over its plan.
      cell: (apiKey) => (
        <span className="flex min-w-0 flex-col items-start gap-1">
          <TruncatedText
            className={cn("max-w-full font-medium", !apiKey.name && "text-muted-foreground")}
          >
            {keyName(apiKey, t, mask)}
          </TruncatedText>
          <KeyAccessLine apiKey={apiKey} />
        </span>
      ),
    },
    {
      id: "key",
      header: t("keys.key"),
      // Fills the cell, so every copy button lines up at the column's end.
      cell: (apiKey) => <MaskedKey apiKey={apiKey} fill />,
    },
    {
      id: "status",
      header: t("keys.status"),
      cell: (apiKey) => {
        const pending = togglingText(apiKey);
        return pending ? <PendingBadge text={pending} /> : <KeyStatePill apiKey={apiKey} />;
      },
    },
    // One column per limit, each one plain line: used / limit and the share. While its usage is
    // reset, Tokens says so and the other two fade.
    {
      id: "tokens",
      header: t("keys.tokens"),
      cell: (apiKey) =>
        resettingId === apiKey.id ? (
          <PendingText text={t("keys.resetting")} />
        ) : (
          <KeyMeasure
            format={(value) => formatNumber(value, lang)}
            limit={apiKey.tokenLimit ?? 0}
            measure="tokens"
            used={apiKey.tokensUsed}
          />
        ),
    },
    {
      id: "credits",
      header: t("keys.credits"),
      cell: (apiKey) => (
        <KeyMeasure
          fading={resettingId === apiKey.id}
          format={(value) => formatCredits(value, 2, lang)}
          limit={apiKey.creditLimit ?? 0}
          measure="credits"
          used={apiKey.creditsUsed}
        />
      ),
    },
    {
      id: "calls",
      header: t("keys.calls"),
      cell: (apiKey) => (
        <KeyMeasure
          fading={resettingId === apiKey.id}
          format={(value) => formatNumber(value, lang)}
          limit={apiKey.callLimit ?? 0}
          measure="calls"
          used={apiKey.successfulCalls ?? 0}
        />
      ),
    },
    {
      id: "requests",
      header: t("keys.requests"),
      align: "end",
      className: REQUESTS_CELL,
      headerClassName: REQUESTS_CELL,
      cell: (apiKey) => formatNumber(apiKey.requestsCount, lang),
    },
    {
      id: "lastUsed",
      header: t("keys.lastUsed"),
      className: LAST_USED_CELL,
      headerClassName: LAST_USED_CELL,
      // Muted and short ("5m ago"), as in the accounts table; the full date is a tooltip.
      cell: (apiKey) => (
        <span className="text-muted-foreground">
          <RelativeTime style="narrow" value={apiKey.lastUsedAt} />
        </span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">{t("common:table.actions")}</span>,
      align: "end",
      width: "1%",
      // Pinned, so the row menu stays in reach while a narrow table scrolls sideways.
      sticky: "end",
      cell: actions,
    },
  ];

  const renderCard = (apiKey: ApiKey) => {
    const pending = togglingText(apiKey);
    return (
      <ListCard
        action={actions(apiKey)}
        badge={pending ? <PendingBadge text={pending} /> : <StatusBadge apiKey={apiKey} />}
        footer={<MaskedKey apiKey={apiKey} />}
        meta={
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            <span className="tabular-nums">
              {t("keys.requestsCount", {
                count: apiKey.requestsCount,
                n: formatNumber(apiKey.requestsCount, lang),
              })}
            </span>
            <span>
              {/* A live relative time, with the full date and time as its tooltip. */}
              {apiKey.lastUsedAt
                ? fillNodes(t("keys.lastUsedLabel"), {
                    time: <RelativeTime value={apiKey.lastUsedAt} />,
                  })
                : t("keys.neverUsed")}
            </span>
          </span>
        }
        title={
          // The same cut as the Name column: a clipped name keeps its full text in a tooltip.
          <TruncatedText className={cn(!apiKey.name && "text-muted-foreground")}>
            {keyName(apiKey, t, mask)}
          </TruncatedText>
        }
      >
        {/* The limit badge sits in the body, so the title keeps the header width beside one badge. */}
        <div className="flex flex-col items-start gap-2">
          {/* On a phone the badges share lines, wrapping as the card narrows, not one a line. */}
          <div className="flex flex-col items-start gap-2 empty:hidden max-sm:flex-row max-sm:flex-wrap max-sm:items-center max-sm:gap-1.5">
            <AccessBadges apiKey={apiKey} />
          </div>
          {resettingId === apiKey.id ? (
            <PendingText text={t("keys.resetting")} />
          ) : (
            <KeyUsage apiKey={apiKey} labelled />
          )}
        </div>
      </ListCard>
    );
  };

  const headerActions = (
    // The primary action at the page's button size, as Add account.
    <Button onClick={openCreate} ref={createRef}>
      <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
      {t("keys.create")}
    </Button>
  );
  const headerRefresh = (
    <RefreshButton
      // The first load shows the table's skeleton, so it spins only over rows on screen.
      fetching={keys.isFetching && !keys.isPending}
      onRefresh={() => void keys.refetch()}
      variant="icon"
    />
  );

  // The header keeps the one primary Create; the empty state offers the same as an outline.
  const emptyState = (
    <EmptyState
      action={
        <Button onClick={openCreate} size="sm" variant="secondary">
          <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
          {t("keys.create")}
        </Button>
      }
      description={t("keys.emptyBody")}
      icon={KeyRoundIcon}
      inCard
      title={t("keys.emptyTitle")}
    />
  );

  const meta =
    list.length === 0
      ? undefined
      : disabledCount > 0
        ? t("keys.metaDisabled", {
            total: formatNumber(list.length, lang),
            disabled: formatNumber(disabledCount, lang),
          })
        : formatNumber(list.length, lang);

  return (
    <SectionCard
      actions={headerActions}
      cornerAction={headerRefresh}
      // Clips the last row's hover tint to the card's rounded corners.
      className="overflow-hidden"
      description={
        // A key sent straight to the proxy, not through the link, is ignored then (proxy/auth.go).
        settings.data?.requireApiKey === false
          ? t("common:text.joinSentences", {
              first: t("keys.description"),
              second: t("keys.linkOnly"),
            })
          : t("keys.description")
      }
      footer={
        list.length > pageSize ? (
          <DataTablePagination
            onPageChange={setPage}
            page={currentPage}
            pageSize={pageSize}
            total={list.length}
          />
        ) : undefined
      }
      icon={KeyRoundIcon}
      id="api-keys"
      meta={meta}
      slim
      title={t("keys.title")}
    >
      {shownFailure ? (
        <CardPanel>
          <ActionError
            error={shownFailure.error}
            onDismiss={() => dismissFailure(shownFailure)}
            onRetry={() => retry(shownFailure)}
          />
        </CardPanel>
      ) : null}
      {createdKey ? (
        <CardPanel>
          <CreatedKeyPanel
            apiKey={createdKey}
            onDismiss={() => {
              setCreatedKey(null);
              // Dismiss goes with the panel; keep focus on the card instead of the page.
              createRef.current?.focus();
            }}
          />
        </CardPanel>
      ) : null}
      <div className="min-w-0">
        {keys.isError ? (
          <ErrorState
            compact
            error={keys.error}
            onRetry={() => void keys.refetch()}
            title={t("keys.loadFailed")}
          />
        ) : (
          <DataTable
            caption={t("keys.caption")}
            cardLayout="grid"
            cardsBelow="4xl"
            columns={columns}
            data={pageRows}
            emptyState={emptyState}
            getRowId={(apiKey) => apiKey.id}
            inset
            loading={keys.isPending}
            // A row opens the key's usage sheet, as an account row opens its details.
            onRowClick={(apiKey) =>
              setUsageFor((current) => ({
                apiKey,
                open: true,
                session: (current?.session ?? 0) + 1,
              }))
            }
            renderCard={renderCard}
            rowLabel={(apiKey) => t("usage.open", { name: keyName(apiKey, t, mask) })}
          />
        )}
      </div>
      <ApiKeyFormDialog
        key={dialog.session}
        onCreated={setCreatedKey}
        onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
        open={dialog.open}
        target={dialog.target}
      />
      {usageFor ? (
        <ApiKeyUsageSheet
          entryRef={keyEntryRef(usageFor.apiKey.id)}
          identity={{
            kind: "key",
            name: usageFor.apiKey.name,
            keyMasked: usageFor.apiKey.keyMasked,
          }}
          key={usageFor.session}
          onOpenChange={(open) => setUsageFor((current) => (current ? { ...current, open } : null))}
          open={usageFor.open}
        />
      ) : null}
    </SectionCard>
  );
}

/** `fill` spreads it across a table cell (copy button at the end); inline in a card footer. */
function MaskedKey({ apiKey, fill = false }: { apiKey: ApiKey; fill?: boolean }): JSX.Element {
  const { t } = useT("api");
  const mask = useMaskText();
  return (
    <span
      className={cn(
        "min-w-0 items-center gap-1",
        fill ? "flex w-full justify-between" : "inline-flex",
      )}
    >
      <TruncatedText className="font-mono text-meta">{apiKey.keyMasked}</TruncatedText>
      <CopyButton
        label={t("keys.copyKey", { name: keyName(apiKey, t, mask) })}
        size="icon"
        value={() => fetchSecret(apiKey.id)}
        variant="quiet"
      />
    </span>
  );
}

/** The key's state and access badges, shared with the usage sheet. */
export function KeyStatus({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge apiKey={apiKey} />
      <AccessBadges apiKey={apiKey} />
    </span>
  );
}

/** An expiry this close shows as a badge, so nobody is surprised by the 401. */
const EXPIRY_SOON_SEC = 7 * 86_400;

interface AccessItem {
  id: string;
  icon?: typeof Clock01Icon;
  text: string;
  /** The tags item, the one that may cut: the others keep their few words. */
  cuts?: boolean;
}

/**
 * The key's access settings: an expiry within a week, the account binding (ids and tags), the
 * model list, the RPM limit and an own routing mode; none for a plain key.
 */
function useAccessItems(apiKey: ApiKey): AccessItem[] {
  const { t, lang } = useT("api");
  const mask = useMaskText();
  const bound = apiKey.accountIds?.length ?? 0;
  const tags = apiKey.accountTags ?? [];
  const models = apiKey.allowedModels ?? [];
  const rpm = apiKey.rpmLimit ?? 0;
  const mode = apiKey.routingMode && apiKey.routingMode !== "inherit" ? apiKey.routingMode : null;
  const now = Date.now() / 1000;
  const expiresAt = apiKey.expiresAt ?? 0;
  const expiresSoon = expiresAt > now && expiresAt - now < EXPIRY_SOON_SEC;
  const items: AccessItem[] = [];
  if (expiresSoon) {
    items.push({
      id: "expiry",
      icon: Clock01Icon,
      text: t("keys.expiresSoon", { relative: formatRelativeTime(expiresAt, lang) }),
    });
  }
  if (bound > 0) {
    items.push({
      id: "accounts",
      icon: UsersIcon,
      text: t("keys.boundAccounts", { count: bound, n: formatNumber(bound, lang) }),
    });
  }
  if (tags.length > 0) {
    // The tags themselves: they say more than a count, and there are at most 10.
    items.push({
      id: "tags",
      icon: Tag01Icon,
      text: formatItems(
        tags.map((tag) => mask(tag)),
        lang,
      ),
      cuts: true,
    });
  }
  if (models.length > 0) {
    items.push({
      id: "models",
      text: t("keys.allowedModels", { count: models.length, n: formatNumber(models.length, lang) }),
    });
  }
  if (rpm > 0) {
    items.push({
      id: "rpm",
      icon: ZapIcon,
      text: t("keys.rpmLimit", { n: formatNumber(rpm, lang) }),
    });
  }
  if (mode) items.push({ id: "routing", icon: Route01Icon, text: t(ROUTING_MODE_LABEL[mode]) });
  return items;
}

/** A reached limit, then the access settings as badges (the usage sheet); nothing for a plain key. */
function AccessBadges({ apiKey }: { apiKey: ApiKey }): JSX.Element | null {
  const reason = limitReachedReason(apiKey);
  const items = useAccessItems(apiKey);
  if (!reason && items.length === 0) return null;
  return (
    <>
      {reason ? <LimitBadge reason={reason} /> : null}
      {items.map(({ id, icon, text, cuts }) => (
        <Badge icon={icon} key={id} tone="neutral">
          {cuts ? <span className="max-w-40 truncate">{text}</span> : text}
        </Badge>
      ))}
    </>
  );
}

/**
 * The access settings as one muted 12 px line under the key's name in the table, each with its
 * badge icon; the tags cut first. Nothing for a plain key.
 */
function KeyAccessLine({ apiKey }: { apiKey: ApiKey }): JSX.Element | null {
  const items = useAccessItems(apiKey);
  if (items.length === 0) return null;
  return (
    <span className="flex w-full min-w-0 items-center gap-x-2.5 overflow-hidden whitespace-nowrap text-meta text-muted-foreground leading-tight">
      {items.map(({ id, icon, text, cuts }) => (
        <span
          className={cn("inline-flex items-center gap-1", cuts ? "min-w-0" : "shrink-0")}
          key={id}
        >
          {icon ? (
            <HugeiconsIcon aria-hidden="true" className="size-3 shrink-0" icon={icon} />
          ) : null}
          {cuts ? <span className="truncate">{text}</span> : text}
        </span>
      ))}
    </span>
  );
}

/**
 * The table's one status pill, naming what blocks the key in the order the proxy checks it:
 * disabled, expired, then a limit. A disabled key reads Limit reached only when a token or credit
 * limit turned it off (an admin's switch or a used-up call limit keep Disabled); an expired key
 * reads Expired whatever its limits; an enabled key at a limit reads Limit reached (the proxy
 * answers 429), else Enabled.
 */
function KeyStatePill({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  const reason = limitReachedReason(apiKey);
  if (!apiKey.enabled) {
    return reason === "disabled" ? <LimitBadge reason={reason} /> : <StatusBadge apiKey={apiKey} />;
  }
  if (isKeyExpired(apiKey)) return <StatusBadge apiKey={apiKey} />;
  return reason ? <LimitBadge reason={reason} /> : <StatusBadge apiKey={apiKey} />;
}

/** Enabled, Disabled, or Expired for an enabled key past its expiry (clients get 401). */
function StatusBadge({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  const { t } = useT("api");
  if (!apiKey.enabled) {
    return (
      <Badge icon={CircleSlashIcon} tone="neutral">
        {t("common:status.disabled")}
      </Badge>
    );
  }
  if (isKeyExpired(apiKey)) {
    return (
      <Badge data-status="expired" icon={Clock01Icon} tone="warning">
        {t("keys.expired")}
      </Badge>
    );
  }
  return (
    <Badge icon={CircleCheckIcon} tone="success">
      {t("common:status.enabled")}
    </Badge>
  );
}

function LimitBadge({ reason }: { reason: "disabled" | "calls" }): JSX.Element {
  const { t } = useT("api");
  return (
    // A popover, not a tooltip: a tap opens it too, so touch users can read the hint.
    <Popover>
      <PopoverTrigger
        closeDelay={100}
        delay={200}
        openOnHover
        // Red, as a used-up limit's figures are in every table and card.
        render={<button className={badgeVariants({ tone: "destructive" })} type="button" />}
      >
        <BadgeIcon icon={AlertCircleIcon} />
        {t("keys.limitReached")}
      </PopoverTrigger>
      <PopoverPopup className="max-w-64" tooltipStyle>
        {reason === "calls" ? t("keys.callLimitReachedHint") : t("keys.limitReachedHint")}
      </PopoverPopup>
    </Popover>
  );
}

function UsageLine({
  label,
  used,
  limit,
  format,
  meterLabel,
}: {
  label: string;
  used: number;
  limit: number;
  format: (value: number) => string;
  meterLabel: string;
}): JSX.Element {
  const tone = limitTone(used, limit);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-baseline gap-1.5 whitespace-nowrap text-xs tabular-nums">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn(LIMIT_TONE_TEXT[tone])}>
          {format(used)} / {limit > 0 ? format(limit) : <UnlimitedMark />}
        </span>
      </span>
      {limit > 0 ? (
        <Meter
          aria-label={meterLabel}
          className="w-28"
          max={limit}
          min={0}
          value={Math.min(used, limit)}
        >
          <MeterTrack>
            <MeterIndicator tone={tone} />
          </MeterTrack>
        </Meter>
      ) : null}
    </div>
  );
}

/**
 * The key's limits as meters, or the infinity sign when it has none. `labelled` names that sign
 * "Limits" in the UsageLine style, for a card, where no Usage column header says what it is.
 */
function KeyUsage({
  apiKey,
  labelled = false,
}: {
  apiKey: ApiKey;
  labelled?: boolean;
}): JSX.Element {
  const { t, lang } = useT("api");
  const tokenLimit = apiKey.tokenLimit ?? 0;
  const creditLimit = apiKey.creditLimit ?? 0;
  const callLimit = apiKey.callLimit ?? 0;
  const successfulCalls = apiKey.successfulCalls ?? 0;
  if (!tokenLimit && !creditLimit && !callLimit) {
    // The UsageLine size, so the column (and a card's body) never jumps from 12 to 14 px.
    return (
      <span
        className="flex items-baseline gap-1.5 text-muted-foreground text-xs"
        data-slot="key-usage-unlimited"
      >
        {/* The space keeps "Limits Unlimited" two words for a screen reader; flex hides it. */}
        {labelled ? <span>{t("usage.limits")}</span> : null}
        {labelled ? " " : null}
        <UnlimitedMark className={labelled ? "text-foreground" : undefined} />
      </span>
    );
  }
  const tokens = (value: number) => formatNumber(value, lang);
  const credits = (value: number) => formatCredits(value, 2, lang);
  return (
    <div className="flex flex-col gap-2">
      <UsageLine
        format={tokens}
        label={t("keys.tokens")}
        limit={tokenLimit}
        meterLabel={t("keys.tokensUsage", {
          used: tokens(apiKey.tokensUsed),
          limit: tokens(tokenLimit),
        })}
        used={apiKey.tokensUsed}
      />
      <UsageLine
        format={credits}
        label={t("keys.credits")}
        limit={creditLimit}
        meterLabel={t("keys.creditsUsage", {
          used: credits(apiKey.creditsUsed),
          limit: credits(creditLimit),
        })}
        used={apiKey.creditsUsed}
      />
      <UsageLine
        format={tokens}
        label={t("keys.calls")}
        limit={callLimit}
        meterLabel={t("keys.callsUsage", {
          used: tokens(successfulCalls),
          limit: tokens(callLimit),
        })}
        used={successfulCalls}
      />
    </div>
  );
}

/** A status pill while the key is turned on or off: a spinning ring and "Disabling…". */
function PendingBadge({ text }: { text: string }): JSX.Element {
  return (
    <Badge data-status="pending" tone="neutral">
      <PendingIcon />
      {text}
    </Badge>
  );
}

/** The usage's place while it is reset: a spinning ring and "Resetting…", muted 12 px. */
function PendingText({ text }: { text: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-meta text-muted-foreground">
      <PendingIcon className="size-3.5" />
      {text}
    </span>
  );
}

/** The spinning ring, hidden from a screen reader: the text beside it says what runs. */
function PendingIcon({ className }: { className?: string }): JSX.Element {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className={cn("animate-spin", className)}
      data-badge-icon="line"
      icon={LoaderCircleIcon}
    />
  );
}

/**
 * One limit in its own table column, plain text on one line: the used amount in semibold over a
 * muted limit, then the share in purple; from 75 % the amounts and share turn amber, and red once
 * used up (limitTone, as in Usage by key). Without a limit, the used amount over the infinity sign.
 * `fading` dims it while the key's usage is reset.
 */
function KeyMeasure({
  measure,
  used,
  limit,
  format,
  fading = false,
}: {
  measure: "tokens" | "credits" | "calls";
  used: number;
  limit: number;
  format: (value: number) => string;
  fading?: boolean;
}): JSX.Element {
  const tone = limitTone(used, limit);
  const toned = LIMIT_TONE_TEXT[tone];
  return (
    <span
      className={cn(
        "whitespace-nowrap text-meta tabular-nums transition-opacity",
        toned,
        fading && "opacity-50",
      )}
      data-measure={measure}
      data-tone={tone}
    >
      <span className="font-semibold">{format(used)}</span>
      <span className={cn(!toned && "text-muted-foreground")}>
        {" / "}
        {limit > 0 ? format(limit) : <UnlimitedMark />}
      </span>
      {limit > 0 ? (
        <>
          {" "}
          <span className={cn("ms-1 font-medium", !toned && "text-info-foreground")}>
            {/* Floored, so a key short of its limit never reads 100%. */}
            {formatFraction(flooredShare(used, limit), 0)}
          </span>
        </>
      ) : null}
    </span>
  );
}

function KeyActions({
  apiKey,
  busy,
  editing,
  lastEnabledKey,
  onEdit,
  onToggle,
  onRegenerate,
  onReset,
  onDelete,
  onUsage,
  triggerRef,
}: {
  apiKey: ApiKey;
  busy: boolean;
  editing: boolean;
  /** The last enabled key while keys are required: the server refuses to disable or delete it. */
  lastEnabledKey: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onRegenerate: () => void;
  onReset: () => void;
  onDelete: () => void;
  onUsage: () => void;
  triggerRef: (element: HTMLButtonElement | null) => (() => void) | undefined;
}): JSX.Element {
  const { t } = useT("api");
  const mask = useMaskText();
  // The trigger stays enabled while the row is busy: disabling it would drop keyboard focus
  // to <body> right after a menu action. The actions themselves wait instead.
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={busy || undefined}
            aria-label={t("keys.rowActions", { name: keyName(apiKey, t, mask) })}
            ref={triggerRef}
            size="icon"
            variant="quiet"
          />
        }
      >
        {/* While one of its actions runs (a delete, a new value), the row's menu spins. */}
        <HugeiconsIcon
          aria-hidden="true"
          className={cn(busy && "animate-spin")}
          icon={busy ? LoaderCircleIcon : EllipsisVerticalIcon}
        />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={onUsage}>
          <HugeiconsIcon icon={ChartLineData02Icon} aria-hidden="true" />
          {t("usage.view")}
        </MenuItem>
        <MenuItem disabled={editing} onClick={onEdit}>
          <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
          {t("common:actions.edit")}
        </MenuItem>
        <MenuItem disabled={busy || lastEnabledKey} onClick={onToggle}>
          {apiKey.enabled ? (
            <HugeiconsIcon icon={PowerOffIcon} aria-hidden="true" />
          ) : (
            <HugeiconsIcon icon={PowerIcon} aria-hidden="true" />
          )}
          <MenuItemLabel reason={lastEnabledKey ? t("keys.lastEnabledKey") : undefined}>
            {apiKey.enabled ? t("common:actions.disable") : t("common:actions.enable")}
          </MenuItemLabel>
        </MenuItem>
        <MenuItem disabled={busy} onClick={onRegenerate}>
          <HugeiconsIcon icon={ArrowReloadHorizontalIcon} aria-hidden="true" />
          {t("keys.regenerate")}
        </MenuItem>
        <MenuItem disabled={busy || !hasUsage(apiKey)} onClick={onReset}>
          <HugeiconsIcon icon={Undo02Icon} aria-hidden="true" />
          <MenuItemLabel reason={hasUsage(apiKey) ? undefined : t("keys.nothingToReset")}>
            {t("keys.resetUsage")}
          </MenuItemLabel>
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={busy || lastEnabledKey} onClick={onDelete} variant="destructive">
          <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
          <MenuItemLabel reason={lastEnabledKey ? t("keys.lastEnabledKey") : undefined}>
            {t("common:actions.delete")}
          </MenuItemLabel>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** A menu item's label, with the reason under it when the item is off. */
function MenuItemLabel({
  children,
  reason,
}: {
  children: ReactNode;
  reason?: string;
}): JSX.Element {
  if (!reason) return <>{children}</>;
  return (
    <span className="flex min-w-0 flex-col">
      <span>{children}</span> <span className="text-muted-foreground text-xs">{reason}</span>
    </span>
  );
}
