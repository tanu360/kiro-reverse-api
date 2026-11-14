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
import { InfoHint } from "@/components/shared/info-hint";
import { RelativeTime } from "@/components/shared/relative-time";
import {
  SETTINGS_ROW_X,
  SettingsEmptyRow,
  SettingsRow,
  SwitchField,
} from "@/components/shared/settings-rows";
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
import { Switch } from "@/components/ui/switch";
import { SECTION_ID } from "@/features/settings/sections/sections";
import { SectionQuery, SettingsGroup } from "@/features/settings/sections/settings-section";
import {
  adoptDetectedProxy,
  checkAllPoolProxies,
  checkDetectedProxy,
  checkPoolProxy,
  type DetectedProxy,
  type PoolProxy,
  type ProxyPoolSettingsPatch,
  type ProxyPoolView,
  proxyPoolQuery,
  removePoolProxy,
  setPoolProxyEnabled,
  updateProxyPoolSettings,
} from "@/lib/api/proxy-pool";
import { queryKeys } from "@/lib/api/query-keys";
import { formatDuration, formatDurationMs } from "@/lib/format";
import { fillNodes, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { proxyFailureSentence } from "./lib/pool-failure";
import {
  countChips,
  intervalOptions,
  poolErrorMessage,
  proxyName,
  stateLook,
} from "./lib/pool-model";
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
      if (checked.health.status === "ok" && !checked.health.failures) {
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

  const [switching, setSwitching] = useState<ReadonlySet<string>>(new Set());
  const toggle = async (proxy: PoolProxy, enabled: boolean) => {
    setSwitching((prev) => new Set(prev).add(proxy.id));
    try {
      await setPoolProxyEnabled(proxy.id, enabled);
      const name = mask(proxyName(proxy));
      toast.success(enabled ? t("card.switchedOn", { name }) : t("card.switchedOff", { name }));
    } catch (error) {
      toast.error(poolErrorMessage(error, t));
    } finally {
      setSwitching((prev) => {
        const next = new Set(prev);
        next.delete(proxy.id);
        return next;
      });
      refetch();
    }
  };

  const testDetected = async (proxy: DetectedProxy) => {
    setTesting((prev) => new Set(prev).add(proxy.id));
    try {
      const { detected } = await checkDetectedProxy(proxy.id);
      const name = mask(proxy.url);
      if (detected.health.status === "ok" && !detected.health.failures) {
        toast.success(t("card.testOk", { name }));
      } else {
        const { errorCode, errorStatus } = detected.health;
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

  const adopt = async (proxy: DetectedProxy) => {
    const confirmed = await confirm({
      title: t("detected.adoptTitle"),
      description: t("detected.adoptBody", { name: mask(proxy.url) }),
      confirmLabel: t("detected.adopt"),
    });
    if (!confirmed) return;
    try {
      await adoptDetectedProxy(proxy.id);
      toast.success(t("detected.adopted", { name: mask(proxy.url) }));
    } catch (error) {
      toast.error(poolErrorMessage(error, t));
    }
    refetch();
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
  const anyProxy = !empty || view.detected.length > 0;
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
          {anyProxy ? (
            <Button
              loading={checkAll.isPending}
              onClick={() => checkAll.mutate()}
              size="sm"
              variant="secondary"
            >
              <HugeiconsIcon icon={Pulse01Icon} aria-hidden="true" />
              {t("card.checkAll")}
            </Button>
          ) : null}
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

      {anyProxy ? <CountsRow view={view} /> : null}

      {empty ? (
        <SettingsEmptyRow>{t("card.empty")}</SettingsEmptyRow>
      ) : (
        view.proxies.map((proxy) => (
          <ProxyRow
            key={proxy.id}
            maxFailures={view.maxFailures}
            onEdit={() => openEditor(proxy)}
            onRemove={() => void remove(proxy)}
            onTest={() => void test(proxy)}
            onToggle={(enabled) => void toggle(proxy, enabled)}
            proxy={proxy}
            switching={switching.has(proxy.id)}
            testing={testing.has(proxy.id)}
          />
        ))
      )}

      {view.detected.length > 0 ? (
        <>
          <SettingsRow
            description={t("detected.hint")}
            status={
              <Badge size="sm" tone="neutral">
                {view.detected.length}
              </Badge>
            }
            title={t("detected.title")}
          />
          {view.detected.map((proxy) => (
            <DetectedRow
              key={proxy.id}
              onAdopt={() => void adopt(proxy)}
              onTest={() => void testDetected(proxy)}
              proxy={proxy}
              testing={testing.has(proxy.id)}
            />
          ))}
        </>
      ) : null}

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

/** The proxies in each state: healthy always, the others when there are any. */
function CountsRow({ view }: { view: ProxyPoolView }): JSX.Element {
  const { t } = useT("proxy-pool");
  return (
    <p
      className={`${SETTINGS_ROW_X} flex flex-wrap items-center gap-2 py-3`}
      data-slot="settings-row"
    >
      <span className="sr-only">{t("counts.label")}</span>
      {countChips(view.counts).map((chip) => (
        <Badge dot key={chip.key} size="sm" tone={chip.tone}>
          {t(chip.key, { count: chip.count })}
        </Badge>
      ))}
    </p>
  );
}

/** The last check's time and latency, the same on pool and detected rows. */
function CheckFacts({ proxy }: { proxy: PoolProxy | DetectedProxy }): JSX.Element {
  const { t, lang } = useT("proxy-pool");
  const { checkedAt, latencyMs } = proxy.health;
  return (
    <>
      <span>
        {checkedAt
          ? fillNodes(t("card.checkedAt"), {
              time: <RelativeTime value={Math.floor(checkedAt / 1000)} />,
            })
          : t("card.notChecked")}
      </span>
      {proxy.state === "healthy" && latencyMs ? (
        <span className="tabular-nums">{formatDurationMs(latencyMs, true, lang)}</span>
      ) : null}
    </>
  );
}

/**
 * Why a proxy is not plainly healthy: how many failures in a row it has (and that the next ones
 * take it out), that it was taken out, or that it is switched off; with the last error behind
 * Details, which opens below so the sentence stays readable on a phone.
 */
function StateNote({
  proxy,
  maxFailures,
}: {
  proxy: PoolProxy | DetectedProxy;
  maxFailures?: number;
}): JSX.Element | null {
  const { t } = useT("proxy-pool");
  const mask = useMaskText();
  const { lastError, errorCode, errorStatus, failures = 0 } = proxy.health;
  if (proxy.state === "off") {
    return <p className="text-muted-foreground text-xs">{t("card.offNote")}</p>;
  }
  if (proxy.state !== "unhealthy" && proxy.state !== "auto_disabled") return null;
  let lead: string;
  if (proxy.state === "auto_disabled") lead = t("card.autoDisabledNote", { max: maxFailures ?? 3 });
  else if (maxFailures !== undefined)
    lead = t("card.strikesNote", { count: failures, max: maxFailures });
  else lead = t("detected.failingNote", { count: failures });
  const tone =
    proxy.state === "auto_disabled" ? "text-destructive-foreground" : "text-warning-foreground";
  return (
    <p className={`wrap-anywhere text-xs ${tone}`}>
      {lead}
      {lastError ? (
        <>
          {" "}
          {t("card.lastError", { error: proxyFailureSentence(errorCode, errorStatus, t) })}{" "}
          <InfoHint hint={mask(lastError)} side="bottom">
            {t("card.lastErrorDetails")}
          </InfoHint>
        </>
      ) : null}
    </p>
  );
}

/**
 * One proxy: its name and state, then its address, sign-in, last check, latency and load. The
 * switch takes it out of the pool without removing it.
 */
function ProxyRow({
  proxy,
  maxFailures,
  testing,
  switching,
  onTest,
  onToggle,
  onEdit,
  onRemove,
}: {
  proxy: PoolProxy;
  maxFailures: number;
  testing: boolean;
  switching: boolean;
  onTest: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useT("proxy-pool");
  const mask = useMaskText();
  const look = stateLook(proxy.state);
  const name = mask(proxyName(proxy));
  return (
    <SettingsRow
      control={
        // A group named by the row; under the text on a narrow row, at its end on a wide one.
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2 @xl/settings-row:justify-end">
          <Switch
            aria-label={t("card.switchLabel", { name })}
            checked={proxy.enabled}
            disabled={switching}
            onCheckedChange={(next) => onToggle(next)}
          />
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
          <CheckFacts proxy={proxy} />
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
      <StateNote maxFailures={maxFailures} proxy={proxy} />
    </SettingsRow>
  );
}

/**
 * A proxy in use outside the pool: the global proxy or accounts' own. Checked like a pool proxy
 * and never shared; one without a sign-in can join the pool, one with a sign-in never does.
 */
function DetectedRow({
  proxy,
  testing,
  onTest,
  onAdopt,
}: {
  proxy: DetectedProxy;
  testing: boolean;
  onTest: () => void;
  onAdopt: () => void;
}): JSX.Element {
  const { t } = useT("proxy-pool");
  const mask = useMaskText();
  const look = stateLook(proxy.state);
  const accounts = proxy.accountIds.length;
  return (
    <SettingsRow
      control={
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2 @xl/settings-row:justify-end">
          <Button loading={testing} onClick={onTest} size="sm" variant="secondary">
            <HugeiconsIcon icon={Wifi01Icon} aria-hidden="true" />
            {t("actions.test")}
          </Button>
          {proxy.canAdopt ? (
            <Button onClick={onAdopt} size="sm" variant="secondary">
              <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" />
              {t("detected.adopt")}
            </Button>
          ) : null}
        </fieldset>
      }
      controlWidth="actions"
      description={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {proxy.global ? <span>{t("detected.global")}</span> : null}
          {accounts > 0 ? <span>{t("detected.ownOf", { count: accounts })}</span> : null}
          {proxy.username ? (
            <span>{t("card.signsInAs", { user: mask(proxy.username) })}</span>
          ) : null}
          <CheckFacts proxy={proxy} />
          {proxy.inPool ? <span>{t("detected.inPool")}</span> : null}
          {proxy.username || proxy.hasPassword ? <span>{t("detected.notShared")}</span> : null}
        </span>
      }
      status={
        <span className="flex flex-wrap items-center gap-2">
          <Badge dot size="sm" tone={look.tone}>
            {t(look.key)}
          </Badge>
          <Badge size="sm" tone="primary">
            {t("detected.badge")}
          </Badge>
        </span>
      }
      title={
        <span className="wrap-anywhere font-mono text-meta" translate="no">
          {proxy.url}
        </span>
      }
    >
      <StateNote proxy={proxy} />
    </SettingsRow>
  );
}
