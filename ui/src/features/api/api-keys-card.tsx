import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  EllipsisIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { CopyButton } from "@/components/shared/copy-button";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Badge, BadgeIcon, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
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
import {
  EMPTY,
  formatCredits,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
} from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isLimitReached, wouldLockOutClients } from "./api-key-form";
import { type ApiKeyDialogTarget, ApiKeyFormDialog } from "./api-key-form-dialog";
import { CreatedKeyPanel } from "./created-key-panel";
import { useElementWidth } from "./use-element-size";

/**
 * Below this content width (px) the keys render as cards. The table needs about 850 px, so
 * the switch follows the card's own width (sidebar open or not), not the viewport.
 */
export const KEYS_TABLE_MIN_WIDTH = 880;
// The actions column stays in view while a narrow table scrolls sideways.
const STICKY_END = "sticky right-0 z-[1] bg-card";

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

export function ApiKeysCard(): JSX.Element {
  const { t } = useT("api");
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
  const layoutRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(layoutRef);
  const asCards = width > 0 && width < KEYS_TABLE_MIN_WIDTH;
  const createRef = useRef<HTMLButtonElement>(null);
  // Row menu triggers by key id, so focus can land on a neighbour when a row goes away.
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterDelete = useRef<{ id: string; order: string[] } | null>(null);
  const triggerRef = useCallback(
    (id: string) => (element: HTMLButtonElement | null) => {
      if (element) triggers.current.set(id, element);
      else triggers.current.delete(id);
    },
    [],
  );

  const list = keys.data ?? [];
  const editingId = dialog.open && dialog.target.mode === "edit" ? dialog.target.apiKey.id : null;

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
    const remaining = new Set(keys.data.map((k) => k.id));
    const index = pending.order.indexOf(pending.id);
    const next = [
      ...pending.order.slice(index + 1),
      ...pending.order.slice(0, index).reverse(),
    ].find((id) => remaining.has(id));
    const target = next ? triggers.current.get(next) : undefined;
    (target ?? createRef.current)?.focus();
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
      cell: (apiKey) => (
        <span className={cn("font-medium", !apiKey.name && "text-muted-foreground")}>
          {keyName(apiKey, t)}
        </span>
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
      cell: (apiKey) => <span className="tabular-nums">{formatNumber(apiKey.requestsCount)}</span>,
    },
    { id: "lastUsed", header: t("keys.lastUsed"), cell: (apiKey) => <LastUsed apiKey={apiKey} /> },
    {
      id: "actions",
      header: <span className="sr-only">{t("common:table.actions")}</span>,
      align: "end",
      width: "1%",
      className: STICKY_END,
      headerClassName: STICKY_END,
      cell: actions,
    },
  ];

  const headerActions = (
    <>
      <Button disabled={keys.isFetching} onClick={() => void keys.refetch()} variant="outline">
        <RefreshCwIcon aria-hidden="true" className={cn(keys.isFetching && "animate-spin")} />
        {t("common:actions.refresh")}
      </Button>
      <Button onClick={openCreate} ref={createRef}>
        <PlusIcon aria-hidden="true" />
        {t("keys.create")}
      </Button>
    </>
  );

  const emptyState = (
    <EmptyState
      action={
        <Button onClick={openCreate}>
          <PlusIcon aria-hidden="true" />
          {t("keys.create")}
        </Button>
      }
      description={t("keys.emptyBody")}
      icon={KeyRoundIcon}
      title={t("keys.emptyTitle")}
      variant="compact"
    />
  );

  return (
    <SectionCard
      actions={headerActions}
      description={t("keys.description")}
      id="api-keys"
      title={t("keys.title")}
    >
      {createdKey ? (
        <CreatedKeyPanel apiKey={createdKey} onDismiss={() => setCreatedKey(null)} />
      ) : null}
      <div className="min-w-0" ref={layoutRef}>
        {keys.isError ? (
          <ErrorState
            compact
            error={keys.error}
            onRetry={() => void keys.refetch()}
            title={t("keys.loadFailed")}
          />
        ) : asCards ? (
          <KeyCardList
            caption={t("keys.caption")}
            emptyState={emptyState}
            items={list.map((apiKey) => ({
              id: apiKey.id,
              card: <KeyCard actions={actions(apiKey)} apiKey={apiKey} />,
            }))}
            loading={keys.isPending}
          />
        ) : (
          <DataTable
            caption={t("keys.caption")}
            columns={columns}
            data={list}
            emptyState={emptyState}
            getRowId={(apiKey) => apiKey.id}
            loading={keys.isPending}
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
    <span className="inline-flex items-center gap-1">
      <code className="whitespace-nowrap font-mono text-xs">{apiKey.keyMasked}</code>
      <CopyButton
        label={t("keys.copyKey", { name: keyName(apiKey, t) })}
        value={() => fetchSecret(apiKey.id)}
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
            render={
              <button
                className={cn(
                  badgeVariants({ tone: "warning" }),
                  "pointer-coarse:after:min-h-10 pointer-coarse:after:min-w-10",
                )}
                type="button"
              />
            }
          >
            <BadgeIcon icon={CircleAlertIcon} />
            {t("keys.limitReached")}
          </PopoverTrigger>
          <PopoverPopup className="max-w-64 text-sm" tooltipStyle>
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
      <span className="flex items-baseline gap-1.5 whitespace-nowrap text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("tabular-nums", reached && "text-warning-foreground")}>
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
          <MeterTrack className="h-1 rounded-full">
            <MeterIndicator className={cn("rounded-full", reached && "bg-warning")} />
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

function LastUsed({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  const { lang } = useT("api");
  if (!apiKey.lastUsedAt) return <span className="text-muted-foreground">{EMPTY}</span>;
  const absolute = formatDateTime(apiKey.lastUsedAt, lang);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            className="whitespace-nowrap"
            dateTime={new Date(apiKey.lastUsedAt * 1000).toISOString()}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the tooltip.
            tabIndex={0}
          />
        }
      >
        {formatRelativeTime(apiKey.lastUsedAt, lang)}
      </TooltipTrigger>
      <TooltipPopup>{absolute}</TooltipPopup>
    </Tooltip>
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
  triggerRef: (element: HTMLButtonElement | null) => void;
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
            className="size-10 md:size-8"
            ref={triggerRef}
            size="icon"
            variant="ghost"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-44">
        <MenuItem disabled={editing} onClick={onEdit}>
          <PencilIcon aria-hidden="true" />
          {t("common:actions.edit")}
        </MenuItem>
        <MenuItem disabled={busy} onClick={onToggle}>
          {apiKey.enabled ? <PowerOffIcon aria-hidden="true" /> : <PowerIcon aria-hidden="true" />}
          {apiKey.enabled ? t("common:actions.disable") : t("common:actions.enable")}
        </MenuItem>
        <MenuItem disabled={busy} onClick={onReset}>
          <RotateCcwIcon aria-hidden="true" />
          {t("keys.resetUsage")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={busy} onClick={onDelete} variant="destructive">
          <Trash2Icon aria-hidden="true" />
          {t("common:actions.delete")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** The keys as a card list, used while the card is too narrow for the table. */
function KeyCardList({
  caption,
  items,
  loading,
  emptyState,
}: {
  caption: string;
  items: Array<{ id: string; card: ReactNode }>;
  loading: boolean;
  emptyState: ReactNode;
}): JSX.Element {
  const grid = "grid grid-cols-1 gap-2 @2xl:grid-cols-2";
  if (loading && items.length === 0) {
    return (
      <div aria-busy="true" className={grid}>
        {Array.from({ length: 3 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cards never reorder.
          <Skeleton className="h-36 w-full rounded-xl" key={index} />
        ))}
      </div>
    );
  }
  if (items.length === 0) return <>{emptyState}</>;
  return (
    <ul aria-label={caption} className={grid} data-testid="api-key-cards">
      {items.map((item) => (
        <li className="min-w-0" key={item.id}>
          {item.card}
        </li>
      ))}
    </ul>
  );
}

function KeyCard({ apiKey, actions }: { apiKey: ApiKey; actions: JSX.Element }): JSX.Element {
  const { t, lang } = useT("api");
  return (
    <Card className="h-full gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={cn("truncate font-medium", !apiKey.name && "text-muted-foreground")}>
            {keyName(apiKey, t)}
          </span>
          <KeyStatus apiKey={apiKey} />
        </div>
        {actions}
      </div>
      <MaskedKey apiKey={apiKey} />
      <KeyUsage apiKey={apiKey} />
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
        <span>
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
      </p>
    </Card>
  );
}
