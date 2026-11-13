import {
  Alert02Icon,
  Delete02Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  Pulse01Icon,
  Wifi01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { RelativeTime } from "@/components/shared/relative-time";
import { SettingsEmptyRow, SettingsRow, SwitchField } from "@/components/shared/settings-rows";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { SECTION_ID } from "@/features/settings/sections/sections";
import { SectionQuery, SettingsGroup } from "@/features/settings/sections/settings-section";
import {
  checkAllPoolProxies,
  checkPoolProxy,
  type PoolProxy,
  type ProxyPoolSettingsPatch,
  type ProxyPoolView,
  proxyPoolQuery,
  removePoolProxy,
  updateProxyPoolSettings,
} from "@/lib/api/proxy-pool";
import { queryKeys } from "@/lib/api/query-keys";
import { formatDuration, formatDurationMs } from "@/lib/format";
import { fillNodes, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { proxyFailureSentence } from "./lib/pool-failure";
import { intervalOptions, poolErrorMessage, proxyName, statusLook } from "./lib/pool-model";
import { ProxyEditor } from "./proxy-pool-editor";

/** Settings card for the outbound proxy pool: its switches, the health check and the proxies. */
export function ProxyPoolCard(): JSX.Element {
  const { t } = useT("proxy-pool");
  const query = useQuery(proxyPoolQuery());
  return (
    <SectionQuery id={SECTION_ID.proxyPool} query={query} title={t("card.title")}>
      {(view) => <ProxyPoolPanel view={view} />}
    </SectionQuery>
  );
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/** The interval select; the row's label and description go to its trigger. */
function IntervalSelect({
  value,
  onChange,
  disabled,
  ...aria
}: AriaProps & {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
}): JSX.Element {
  const { t, lang } = useT("proxy-pool");
  // {interval} reads "5 minutes", "1 hour" or "1 day".
  const items = intervalOptions(value).map((minutes) => ({
    value: String(minutes),
    label:
      minutes === 0
        ? t("card.intervalOff")
        : t("card.intervalEvery", { interval: formatDuration(minutes * 60, lang, "long") }),
  }));
  return (
    <Select
      disabled={disabled}
      items={items}
      onValueChange={(next) => {
        if (next !== null && next !== undefined) onChange(Number(next));
      }}
      value={String(value)}
    >
      <SelectTrigger {...aria}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * The pool's settings save as they change (a switch or the interval), like the other system
 * switches; each proxy is added, edited, tested or removed on its own, at once.
 */
function ProxyPoolPanel({ view }: { view: ProxyPoolView }): JSX.Element {
  const { t } = useT("proxy-pool");
  // Proxy logins are often e-mail addresses: privacy mode masks them wherever a name shows.
  const mask = useMaskText();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [pending, setPending] = useState<ProxyPoolSettingsPatch | null>(null);
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  // `session` remounts the form on each open, so it starts from the saved proxy.
  const [editor, setEditor] = useState<{ open: boolean; session: number; proxy?: PoolProxy }>({
    open: false,
    session: 0,
  });

  const store = (next: ProxyPoolView) => {
    queryClient.setQueryData(queryKeys.settings.proxyPool(), next);
  };
  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.settings.proxyPool() });
  };

  const settings = useMutation({
    mutationFn: updateProxyPoolSettings,
    onMutate: (patch) => setPending(patch),
    onSuccess: (next) => {
      store(next);
      toast.success(t("settings:saved"));
    },
    onError: (error) => {
      toast.error(t("settings:saveFailed", { reason: poolErrorMessage(error, t) }));
    },
    onSettled: () => setPending(null),
  });
  const saveSettings = (patch: ProxyPoolSettingsPatch) => {
    if (!settings.isPending) settings.mutate(patch);
  };

  const checkAll = useMutation({
    mutationFn: checkAllPoolProxies,
    onSuccess: (next) => {
      store(next);
      toast.success(t("card.checkAllDone"));
    },
    onError: (error) => toast.error(poolErrorMessage(error, t)),
  });

  const test = async (proxy: PoolProxy) => {
    setTesting((prev) => new Set(prev).add(proxy.id));
    try {
      const { proxy: checked } = await checkPoolProxy(proxy.id);
      const name = mask(proxyName(checked));
      if (checked.health.status === "ok") {
        toast.success(t("card.testOk", { name }));
      } else {
        const { errorCode, errorStatus } = checked.health;
        toast.error(
          t("card.testFailed", { name, error: proxyFailureSentence(errorCode, errorStatus, t) }),
        );
      }
    } catch (error) {
      toast.error(poolErrorMessage(error, t));
    } finally {
      setTesting((prev) => {
        const next = new Set(prev);
        next.delete(proxy.id);
        return next;
      });
      refetch();
    }
  };

  const remove = async (proxy: PoolProxy) => {
    const name = mask(proxyName(proxy));
    const last = view.mode === "on" && view.proxies.length === 1;
    const confirmed = await confirm({
      title: t("card.removeTitle"),
      description: last ? t("card.removeLastBody", { name }) : t("card.removeBody", { name }),
      confirmLabel: t("actions.remove"),
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await removePoolProxy(proxy.id);
      toast.success(t("card.removed"));
    } catch (error) {
      toast.error(poolErrorMessage(error, t));
    }
    refetch();
  };

  const on = (pending?.mode ?? view.mode) === "on";
  const fallback = pending?.directFallback ?? view.directFallback;
  const interval = pending?.checkIntervalMin ?? view.checkIntervalMin;
  const empty = view.proxies.length === 0;
  const openEditor = (proxy?: PoolProxy) =>
    setEditor((prev) => ({ open: true, session: prev.session + 1, proxy }));

  return (
    <SettingsGroup
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => openEditor()} size="sm" variant="secondary">
            <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" />
            {t("card.add")}
          </Button>
          {empty ? null : (
            <Button
              loading={checkAll.isPending}
              onClick={() => checkAll.mutate()}
              size="sm"
              variant="secondary"
            >
              <HugeiconsIcon icon={Pulse01Icon} aria-hidden="true" />
              {t("card.checkAll")}
            </Button>
          )}
        </div>
      }
      badge={
        <Badge size="sm" tone="neutral">
          {view.proxies.length}
        </Badge>
      }
      description={t("card.hint")}
      id={SECTION_ID.proxyPool}
      title={t("card.title")}
    >
      <SwitchField
        checked={on}
        description={empty && !on ? t("card.modeNeedsProxy") : t("card.modeHint")}
        disabled={empty && !on}
        onCheckedChange={(checked) => saveSettings({ mode: checked ? "on" : "off" })}
        title={t("card.modeTitle")}
      >
        {on && empty ? (
          <Alert role="status" size="sm" variant="warning">
            <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
            <AlertDescription>{t("card.emptyOnWarning")}</AlertDescription>
          </Alert>
        ) : null}
      </SwitchField>
      <SwitchField
        checked={fallback}
        description={t("card.fallbackHint")}
        onCheckedChange={(directFallback) => saveSettings({ directFallback })}
        title={t("card.fallbackTitle")}
      />
      <SettingsRow
        control={
          <IntervalSelect
            onChange={(checkIntervalMin) => saveSettings({ checkIntervalMin })}
            value={interval}
          />
        }
        description={t("card.intervalHint")}
        title={t("card.intervalTitle")}
      />

      {empty ? (
        <SettingsEmptyRow>{t("card.empty")}</SettingsEmptyRow>
      ) : (
        view.proxies.map((proxy) => (
          <ProxyRow
            key={proxy.id}
            onEdit={() => openEditor(proxy)}
            onRemove={() => void remove(proxy)}
            onTest={() => void test(proxy)}
            proxy={proxy}
            testing={testing.has(proxy.id)}
          />
        ))
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setEditor((prev) => ({ ...prev, open: false }));
        }}
        open={editor.open}
      >
        <ProxyEditor
          key={editor.session}
          onSaved={() => {
            setEditor((prev) => ({ ...prev, open: false }));
            refetch();
          }}
          proxy={editor.proxy}
        />
      </Dialog>
    </SettingsGroup>
  );
}

/** One proxy: its name and status, then its address, sign-in, last check, latency and load. */
function ProxyRow({
  proxy,
  testing,
  onTest,
  onEdit,
  onRemove,
}: {
  proxy: PoolProxy;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { t, lang } = useT("proxy-pool");
  const mask = useMaskText();
  const look = statusLook(proxy.health.status);
  const { checkedAt, latencyMs, lastError, errorCode, errorStatus } = proxy.health;
  return (
    <SettingsRow
      control={
        // A group named by the row; under the text on a narrow row, at its end on a wide one.
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2 @xl/settings-row:justify-end">
          <Button loading={testing} onClick={onTest} size="sm" variant="secondary">
            <HugeiconsIcon icon={Wifi01Icon} aria-hidden="true" />
            {t("actions.test")}
          </Button>
          <Button onClick={onEdit} size="sm" variant="secondary">
            <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
            {t("common:actions.edit")}
          </Button>
          <Button onClick={onRemove} size="sm" variant="danger">
            <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
            {t("actions.remove")}
          </Button>
        </fieldset>
      }
      controlWidth="actions"
      description={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {proxy.label ? (
            <span className="wrap-anywhere font-mono" translate="no">
              {proxy.url}
            </span>
          ) : null}
          {proxy.username ? (
            <span>{t("card.signsInAs", { user: mask(proxy.username) })}</span>
          ) : null}
          <span>
            {checkedAt
              ? fillNodes(t("card.checkedAt"), {
                  time: <RelativeTime value={Math.floor(checkedAt / 1000)} />,
                })
              : t("card.notChecked")}
          </span>
          {proxy.health.status === "ok" && latencyMs ? (
            <span className="tabular-nums">{formatDurationMs(latencyMs, true, lang)}</span>
          ) : null}
          <span className="tabular-nums">{t("card.accounts", { count: proxy.accounts })}</span>
        </span>
      }
      status={
        <Badge dot size="sm" tone={look.tone}>
          {t(look.key)}
        </Badge>
      }
      title={
        proxy.label ? (
          mask(proxy.label)
        ) : (
          // A long host wraps at its dots and colon first, mid-label only when it must.
          <span className="wrap-anywhere font-mono text-meta" translate="no">
            {proxy.url}
          </span>
        )
      }
    >
      {proxy.health.status === "failed" && lastError ? (
        // A short sentence in the viewer's language; the server's own text in the tooltip.
        <p className="wrap-anywhere text-destructive-foreground text-xs">
          <Tooltip>
            <TooltipTrigger render={<span />}>
              {t("card.lastError", { error: proxyFailureSentence(errorCode, errorStatus, t) })}
            </TooltipTrigger>
            <TooltipPopup>{mask(lastError)}</TooltipPopup>
          </Tooltip>
        </p>
      ) : null}
    </SettingsRow>
  );
}
