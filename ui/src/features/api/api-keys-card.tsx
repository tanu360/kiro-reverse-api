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
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
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
import { Badge, BadgeIcon, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardPanel } from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ROUTING_MODE_LABEL } from "@/features/accounts/use-routing-mode";
import { useElementWidth } from "@/hooks/use-element-width";
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
import { formatCredits, formatNumber, formatRelativeTime } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { toast, toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isKeyExpired, limitReachedReason, wouldLockOutClients } from "./api-key-form";
import { type ApiKeyDialogTarget, ApiKeyFormDialog } from "./api-key-form-dialog";
import { CreatedKeyPanel } from "./created-key-panel";
import { keyEntryRef } from "./key-usage-model";
import { ApiKeyUsageSheet } from "./key-usage-sheet";

/**
 * The keys turn into cards below DataTable's `cardsBelow="4xl"` (a 56rem container: the table
 * needs about 850 px), two to a row from 42rem. Ten keys a page in either layout, so the card
 * stays about a screen tall.
 */
const CARDS_BELOW_PX = 896;
const CARD_PAGE_SIZE = 10;
const TABLE_PAGE_SIZE = 10;

interface DialogState {
  open: boolean;
  target: ApiKeyDialogTarget;
  /** Bumped on every opening so the dialog remounts with fresh values. */
  session: number;
}

/** The key's name, with any e-mail in it masked in privacy mode, as Usage by key shows it. */
function keyName(apiKey: ApiKey, t: TFunction, mask: (text?: string) => string): string {
  return apiKey.name ? mask(apiKey.name) : t("keys.unnamed");
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
  const [createdKey, setCreatedKey] = useState<{ key: string; regenerated: boolean } | null>(null);
  // The key whose usage chart is open; kept while the sheet closes, a new session per opening.
  const [usageFor, setUsageFor] = useState<{
    apiKey: ApiKey;
    open: boolean;
    session: number;
  } | null>(null);
  const [page, setPage] = useState(1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(bodyRef);
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
  const pageSize = width > 0 && width < CARDS_BELOW_PX ? CARD_PAGE_SIZE : TABLE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = list.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const disabledCount = list.filter((apiKey) => !apiKey.enabled).length;

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

  const toggle = useMutation({
    mutationFn: (apiKey: ApiKey) => updateApiKey(apiKey.id, { enabled: !apiKey.enabled }),
    onSuccess: (_result, apiKey) => {
      toast.success(apiKey.enabled ? t("keys.disabled") : t("keys.enabled"));
    },
    onError: (error) => {
      toastError(error, t);
    },
    onSettled: invalidate,
  });

  const reset = useMutation({
    mutationFn: (apiKey: ApiKey) => resetApiKeyUsage(apiKey.id),
    onSuccess: (_result, apiKey) => {
      toast.success(t("keys.usageReset"), {
        description: apiKey.enabled ? undefined : t("keys.usageResetDisabledHint"),
      });
    },
    onError: (error) => {
      toastError(error, t);
    },
    onSettled: invalidate,
  });

  const regenerate = useMutation({
    mutationFn: (apiKey: ApiKey) => regenerateApiKey(apiKey.id),
    onSuccess: (result) => {
      setCreatedKey({ key: result.key, regenerated: true });
      toast.success(t("keys.regenerated"));
    },
    onError: (error) => {
      toastError(error, t);
    },
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (apiKey: ApiKey) => deleteApiKey(apiKey.id),
    onSuccess: () => {
      toast.success(t("keys.deleted"));
    },
    onError: (error) => {
      focusAfterDelete.current = null;
      toastError(error, t);
    },
    onSettled: invalidate,
  });

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

  // Enable and disable never ask (parity), except when disabling locks every client out.
  const onToggle = async (apiKey: ApiKey) => {
    if (apiKey.enabled && wouldLockOutClients(list, apiKey.id, requireApiKey)) {
      const ok = await confirm({
        title: t("keys.confirmDisableTitle", { name: keyName(apiKey, t, mask) }),
        description: t("keys.lockoutWarning"),
        confirmLabel: t("common:actions.disable"),
        variant: "danger",
      });
      if (!ok) return;
    }
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
    const lockout = wouldLockOutClients(list, apiKey.id, requireApiKey);
    const ok = await confirm({
      title: t("keys.confirmDeleteTitle", { name: keyName(apiKey, t, mask) }),
      description: lockout
        ? t("common:text.joinSentences", {
            first: t("keys.confirmDeleteBody"),
            second: t("keys.lockoutWarning"),
          })
        : t("keys.confirmDeleteBody"),
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
      onDelete={() => void onDelete(apiKey)}
      onEdit={() => openEdit(apiKey)}
      onRegenerate={() => void onRegenerate(apiKey)}
      onReset={() => reset.mutate(apiKey)}
      onToggle={() => void onToggle(apiKey)}
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
      cell: (apiKey) => (
        <TruncatedText className={cn("font-medium", !apiKey.name && "text-muted-foreground")}>
          {keyName(apiKey, t, mask)}
        </TruncatedText>
      ),
    },
    {
      id: "key",
      header: t("keys.key"),
      // Fills the cell, so every copy button lines up at the column's end.
      cell: (apiKey) => <MaskedKey apiKey={apiKey} fill />,
    },
    { id: "status", header: t("keys.status"), cell: (apiKey) => <KeyStatus apiKey={apiKey} /> },
    { id: "usage", header: t("keys.usage"), cell: (apiKey) => <KeyUsage apiKey={apiKey} /> },
    {
      id: "requests",
      header: t("keys.requests"),
      align: "end",
      cell: (apiKey) => formatNumber(apiKey.requestsCount, lang),
    },
    {
      id: "lastUsed",
      header: t("keys.lastUsed"),
      cell: (apiKey) => <RelativeTime value={apiKey.lastUsedAt} />,
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

  const renderCard = (apiKey: ApiKey) => (
    <ListCard
      action={actions(apiKey)}
      badge={<StatusBadge apiKey={apiKey} />}
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
            {apiKey.lastUsedAt
              ? t("keys.lastUsedLabel", { time: formatRelativeTime(apiKey.lastUsedAt, lang) })
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
        <AccessBadges apiKey={apiKey} />
        <KeyUsage apiKey={apiKey} />
      </div>
    </ListCard>
  );

  const headerActions = (
    <>
      <RefreshButton
        fetching={keys.isFetching}
        onRefresh={() => void keys.refetch()}
        variant="icon"
      />
      {/* The primary action at the page's button size, as Add account. */}
      <Button onClick={openCreate} ref={createRef}>
        <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
        {t("keys.create")}
      </Button>
    </>
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
      // Clips the last row's hover tint to the card's rounded corners.
      className="overflow-hidden"
      description={t("keys.description")}
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
      {createdKey ? (
        <CardPanel>
          <CreatedKeyPanel
            apiKey={createdKey.key}
            onDismiss={() => setCreatedKey(null)}
            regenerated={createdKey.regenerated}
          />
        </CardPanel>
      ) : null}
      <div className="min-w-0" ref={bodyRef}>
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
        onCreated={(key) => setCreatedKey({ key, regenerated: false })}
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

/**
 * A reached limit, the account binding (ids and tags), the model list, the RPM limit, an own
 * routing mode and an expiry within a week; nothing for a plain key.
 */
function AccessBadges({ apiKey }: { apiKey: ApiKey }): JSX.Element | null {
  const { t, lang } = useT("api");
  const mask = useMaskText();
  const reason = limitReachedReason(apiKey);
  const bound = apiKey.accountIds?.length ?? 0;
  const tags = apiKey.accountTags ?? [];
  const models = apiKey.allowedModels ?? [];
  const rpm = apiKey.rpmLimit ?? 0;
  const mode = apiKey.routingMode && apiKey.routingMode !== "inherit" ? apiKey.routingMode : null;
  const now = Date.now() / 1000;
  const expiresAt = apiKey.expiresAt ?? 0;
  const expiresSoon = expiresAt > now && expiresAt - now < EXPIRY_SOON_SEC;
  if (
    !reason &&
    bound === 0 &&
    tags.length === 0 &&
    models.length === 0 &&
    !rpm &&
    !mode &&
    !expiresSoon
  ) {
    return null;
  }
  return (
    <>
      {reason ? <LimitBadge reason={reason} /> : null}
      {expiresSoon ? (
        <Badge icon={Clock01Icon} tone="neutral">
          {t("keys.expiresSoon", { relative: formatRelativeTime(expiresAt, lang) })}
        </Badge>
      ) : null}
      {bound > 0 ? (
        <Badge icon={UsersIcon} tone="neutral">
          {t("keys.boundAccounts", { count: bound, n: formatNumber(bound, lang) })}
        </Badge>
      ) : null}
      {tags.length > 0 ? (
        <Badge icon={Tag01Icon} tone="neutral">
          {/* The tags themselves: they say more than a count, and there are at most 10. */}
          <span className="max-w-40 truncate">{tags.map((tag) => mask(tag)).join(", ")}</span>
        </Badge>
      ) : null}
      {models.length > 0 ? (
        <Badge tone="neutral">
          {t("keys.allowedModels", { count: models.length, n: formatNumber(models.length, lang) })}
        </Badge>
      ) : null}
      {rpm > 0 ? (
        <Badge icon={ZapIcon} tone="neutral">
          {t("keys.rpmLimit", { n: formatNumber(rpm, lang) })}
        </Badge>
      ) : null}
      {mode ? (
        <Badge icon={Route01Icon} tone="neutral">
          {t(ROUTING_MODE_LABEL[mode])}
        </Badge>
      ) : null}
    </>
  );
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
        render={<button className={badgeVariants({ tone: "warning" })} type="button" />}
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
  const { t } = useT("api");
  const reached = limit > 0 && used >= limit;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-baseline gap-1.5 whitespace-nowrap text-xs tabular-nums">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn(reached && "text-warning-foreground")}>
          {format(used)} / {limit > 0 ? format(limit) : t("common:unlimited")}
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
            <MeterIndicator tone={reached ? "warning" : "default"} />
          </MeterTrack>
        </Meter>
      ) : null}
    </div>
  );
}

/** The key's limits as meters, or Unlimited; shared with the usage sheet. */
export function KeyUsage({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  const { t, lang } = useT("api");
  const tokenLimit = apiKey.tokenLimit ?? 0;
  const creditLimit = apiKey.creditLimit ?? 0;
  const callLimit = apiKey.callLimit ?? 0;
  const successfulCalls = apiKey.successfulCalls ?? 0;
  if (!tokenLimit && !creditLimit && !callLimit) {
    // The UsageLine size, so the column (and a card's body) never jumps from 12 to 14 px.
    return <span className="text-muted-foreground text-xs">{t("common:unlimited")}</span>;
  }
  const tokens = (value: number) => formatNumber(value, lang);
  const credits = (value: number) => formatCredits(value);
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

function KeyActions({
  apiKey,
  busy,
  editing,
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
        <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
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
        <MenuItem disabled={busy} onClick={onToggle}>
          {apiKey.enabled ? (
            <HugeiconsIcon icon={PowerOffIcon} aria-hidden="true" />
          ) : (
            <HugeiconsIcon icon={PowerIcon} aria-hidden="true" />
          )}
          {apiKey.enabled ? t("common:actions.disable") : t("common:actions.enable")}
        </MenuItem>
        <MenuItem disabled={busy} onClick={onRegenerate}>
          <HugeiconsIcon icon={ArrowReloadHorizontalIcon} aria-hidden="true" />
          {t("keys.regenerate")}
        </MenuItem>
        <MenuItem disabled={busy} onClick={onReset}>
          <HugeiconsIcon icon={Undo02Icon} aria-hidden="true" />
          {t("keys.resetUsage")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={busy} onClick={onDelete} variant="destructive">
          <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
          {t("common:actions.delete")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
