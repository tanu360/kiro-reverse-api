import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheckIcon,
  CircleOffIcon,
  EllipsisIcon,
  GaugeIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { CopyButton } from "@/components/shared/copy-button";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
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

  const list = keys.data ?? [];
  const editingId = dialog.open && dialog.target.mode === "edit" ? dialog.target.apiKey.id : null;

  // The key being edited was deleted elsewhere: nothing is left to save.
  useEffect(() => {
    if (editingId && keys.data && !keys.data.some((k) => k.id === editingId)) {
      setDialog((prev) => ({ ...prev, open: false }));
    }
  }, [editingId, keys.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });

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
        ? `${t("keys.confirmDeleteBody")} ${t("keys.lockoutWarning")}`
        : t("keys.confirmDeleteBody"),
      confirmLabel: t("common:actions.delete"),
      variant: "danger",
    });
    if (ok) remove.mutate(apiKey);
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
      cell: actions,
    },
  ];

  const headerActions = (
    <>
      <Button disabled={keys.isFetching} onClick={() => void keys.refetch()} variant="outline">
        <RefreshCwIcon aria-hidden="true" className={cn(keys.isFetching && "animate-spin")} />
        {t("common:actions.refresh")}
      </Button>
      <Button onClick={openCreate}>
        <PlusIcon aria-hidden="true" />
        {t("keys.create")}
      </Button>
    </>
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
          columns={columns}
          data={list}
          emptyState={
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
          }
          getRowId={(apiKey) => apiKey.id}
          loading={keys.isPending}
          renderMobileCard={(apiKey) => <KeyCard actions={actions(apiKey)} apiKey={apiKey} />}
        />
      )}
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
        <Badge variant="success">
          <CircleCheckIcon aria-hidden="true" />
          {t("common:status.enabled")}
        </Badge>
      ) : (
        <Badge variant="secondary">
          <CircleOffIcon aria-hidden="true" />
          {t("common:status.disabled")}
        </Badge>
      )}
      {limited ? (
        <Tooltip>
          <TooltipTrigger
            render={<button className={badgeVariants({ variant: "warning" })} type="button" />}
          >
            <GaugeIcon aria-hidden="true" />
            {t("keys.limitReached")}
          </TooltipTrigger>
          <TooltipPopup className="max-w-64">{t("keys.limitReachedHint")}</TooltipPopup>
        </Tooltip>
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
}: {
  apiKey: ApiKey;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onReset: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { t } = useT("api");
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={t("keys.rowActions", { name: keyName(apiKey, t) })}
            className="size-10 md:size-8"
            disabled={busy}
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
        <MenuItem onClick={onToggle}>
          {apiKey.enabled ? <PowerOffIcon aria-hidden="true" /> : <PowerIcon aria-hidden="true" />}
          {apiKey.enabled ? t("common:actions.disable") : t("common:actions.enable")}
        </MenuItem>
        <MenuItem onClick={onReset}>
          <RotateCcwIcon aria-hidden="true" />
          {t("keys.resetUsage")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onDelete} variant="destructive">
          <Trash2Icon aria-hidden="true" />
          {t("common:actions.delete")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function KeyCard({ apiKey, actions }: { apiKey: ApiKey; actions: JSX.Element }): JSX.Element {
  const { t, lang } = useT("api");
  return (
    <Card className="gap-3 p-4">
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
