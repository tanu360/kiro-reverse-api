import {
  AlertCircleIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  Delete02Icon,
  EllipsisVerticalIcon,
  KeyRoundIcon,
  PencilEdit01Icon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
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
import { useElementWidth } from "@/hooks/use-element-width";
import {
  apiKeysQuery,
  deleteApiKey,
  getApiKey,
  resetApiKeyUsage,
  updateApiKey,
} from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { settingsQuery } from "@/lib/api/settings";
import type { ApiKey } from "@/lib/api/types";
import { formatCredits, formatNumber, formatRelativeTime } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isLimitReached, wouldLockOutClients } from "./api-key-form";
import { type ApiKeyDialogTarget, ApiKeyFormDialog } from "./api-key-form-dialog";
import { CreatedKeyPanel } from "./created-key-panel";

/**
 * The keys turn into cards below DataTable's `cardsBelow="4xl"` (a 56rem container: the table
 * needs about 850 px), two to a row from 42rem. Script only needs the same width for the page
 * size: ten cards a page, twenty-five table rows.
 */
const CARDS_BELOW_PX = 896;
/*
 * The one-column card grid is an implicit track sized to its widest card's content, so a long
 * key name pushes every card past the panel. A shrinkable track until CARD_GRID_CLASS sets one.
 */
const CARD_TRACK = "[&_[data-slot=data-table-cards]>ul]:auto-cols-fr";
const CARD_PAGE_SIZE = 10;
const TABLE_PAGE_SIZE = 25;

interface DialogState {
  open: boolean;
  target: ApiKeyDialogTarget;
  /** Bumped on every opening so the dialog remounts with fresh values. */
  session: number;
}

function keyName(apiKey: ApiKey, t: TFunction): string {
  return apiKey.name || t("keys.unnamed");
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
  const [createdKey, setCreatedKey] = useState<string | null>(null);
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
        title: t("keys.confirmDisableTitle"),
        description: t("keys.lockoutWarning"),
        confirmLabel: t("common:actions.disable"),
        variant: "danger",
      });
      if (!ok) return;
    }
    toggle.mutate(apiKey);
  };

  const onDelete = async (apiKey: ApiKey) => {
    const lockout = wouldLockOutClients(list, apiKey.id, requireApiKey);
    const ok = await confirm({
      title: t("keys.confirmDeleteTitle"),
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
    (remove.isPending && remove.variables?.id) ||
    null;

  const actions = (apiKey: ApiKey) => (
    <KeyActions
      apiKey={apiKey}
      busy={busyId === apiKey.id}
      editing={editingId === apiKey.id}
      onDelete={() => void onDelete(apiKey)}
      onEdit={() => openEdit(apiKey)}
      onReset={() => reset.mutate(apiKey)}
      onToggle={() => void onToggle(apiKey)}
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
          {keyName(apiKey, t)}
        </TruncatedText>
      ),
    },
    {
      id: "key",
      header: t("keys.key"),
      cell: (apiKey) => <MaskedKey apiKey={apiKey} />,
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
      badge={<KeyStatus apiKey={apiKey} />}
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
        <span className={cn(!apiKey.name && "text-muted-foreground")}>{keyName(apiKey, t)}</span>
      }
    >
      <KeyUsage apiKey={apiKey} />
    </ListCard>
  );

  const headerActions = (
    <>
      <RefreshButton fetching={keys.isFetching} onRefresh={() => void keys.refetch()} />
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
        <Button onClick={openCreate} variant="outline">
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
          <CreatedKeyPanel apiKey={createdKey} onDismiss={() => setCreatedKey(null)} />
        </CardPanel>
      ) : null}
      <div className={cn("min-w-0", CARD_TRACK)} ref={bodyRef}>
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
            renderCard={renderCard}
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
    </SectionCard>
  );
}

function MaskedKey({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  const { t } = useT("api");
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Code>{apiKey.keyMasked}</Code>
      <CopyButton
        label={t("keys.copyKey", { name: keyName(apiKey, t) })}
        size="icon-sm"
        value={() => fetchSecret(apiKey.id)}
        variant="quiet"
      />
    </span>
  );
}

function KeyStatus({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  const { t } = useT("api");
  const limited = isLimitReached(apiKey);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {apiKey.enabled ? (
        <Badge icon={CircleCheckIcon} tone="success">
          {t("common:status.enabled")}
        </Badge>
      ) : (
        <Badge icon={CircleSlashIcon} tone="neutral">
          {t("common:status.disabled")}
        </Badge>
      )}
      {limited ? (
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
            {t("keys.limitReachedHint")}
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
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

function KeyUsage({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  const { t, lang } = useT("api");
  const tokenLimit = apiKey.tokenLimit ?? 0;
  const creditLimit = apiKey.creditLimit ?? 0;
  if (!tokenLimit && !creditLimit) {
    return <span className="text-muted-foreground text-sm">{t("common:unlimited")}</span>;
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
    </div>
  );
}

function KeyActions({
  apiKey,
  busy,
  editing,
  onEdit,
  onToggle,
  onReset,
  onDelete,
  triggerRef,
}: {
  apiKey: ApiKey;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onReset: () => void;
  onDelete: () => void;
  triggerRef: (element: HTMLButtonElement | null) => (() => void) | undefined;
}): JSX.Element {
  const { t } = useT("api");
  // The trigger stays enabled while the row is busy: disabling it would drop keyboard focus
  // to <body> right after a menu action. The actions themselves wait instead.
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={busy || undefined}
            aria-label={t("keys.rowActions", { name: keyName(apiKey, t) })}
            ref={triggerRef}
            size="icon"
            variant="quiet"
          />
        }
      >
        <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end">
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
