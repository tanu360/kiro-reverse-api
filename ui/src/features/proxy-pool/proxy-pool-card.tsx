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
import { type JSX, memo, type Ref, useEffect, useMemo, useRef, useState } from "react";
import { ActionError } from "@/components/shared/action-error";
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
import { CardPanel } from "@/components/ui/card";
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
import { announce } from "@/lib/announce";
import {
  adoptDetectedProxy,
  checkAllPoolProxies,
  checkDetectedProxy,
  checkPoolProxy,
  type DetectedProxy,
  type PoolProxy,
  type PoolProxyHealth,
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
  triggerRef,
  ...aria
}: AriaProps & {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
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
      <SelectTrigger ref={triggerRef} {...aria}>
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

/** A row action whose control can take focus back: `data-proxy` and `data-action` on it. */
type RowAction = "switch" | "test" | "remove" | "adopt";

/** The row's control for `action`, if it is on screen. */
function rowControl(id: string, action: RowAction): HTMLElement | null {
  const card = document.getElementById(SECTION_ID.proxyPool);
  const controls = card?.querySelectorAll<HTMLElement>(`[data-action="${action}"]`) ?? [];
  return [...controls].find((control) => control.dataset.proxy === id) ?? null;
}

/** The last action that failed, shown at the top of the card until retried or closed. */
interface PoolFailure {
  error: unknown;
  /** Runs the same action again; a confirmed one does not ask again. */
  retry: () => void;
  /** Where focus goes as the notice goes: the control that ran the action. */
  focus: () => void;
  /** Nothing is left to run again: its row is gone (or already in the pool). */
  moot?: (view: ProxyPoolView) => boolean;
}

/** A request's result, or its error, so the row can be read again before either shows. */
type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function attempt<T>(request: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await request() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Whether the view still has a pool or detected row with this id. */
function hasRow(view: ProxyPoolView, id: string): boolean {
  return (
    view.proxies.some((item) => item.id === id) || view.detected.some((item) => item.id === id)
  );
}

/** Where focus goes once the view shows a result that took the focused control. */
interface Refocus {
  done: (view: ProxyPoolView) => boolean;
  focus: () => void;
}

/** A copy of `set` with `id` in it or out of it. */
function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * The pool's settings save as they change (a switch or the interval), like the other system
 * switches; each proxy is added, edited, tested or removed on its own, at once.
 *
 * No toasts: a row shows its own result (its state, last check and error, the row going away),
 * its control spins meanwhile, a screen reader hears the result, and a failure shows at the top
 * of the card. Each row stays pending until the pool is read again, so nothing flips back for a
 * moment; a failure shows only then, so its Try again never runs beside the first try.
 */
function ProxyPoolPanel({ view }: { view: ProxyPoolView }): JSX.Element {
  const { t } = useT("proxy-pool");
  // Proxy logins are often e-mail addresses: privacy mode masks them wherever a name shows.
  const mask = useMaskText();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [pending, setPending] = useState<ProxyPoolSettingsPatch | null>(null);
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  // Proxy id -> the state its switch is moving to.
  const [switching, setSwitching] = useState<ReadonlyMap<string, boolean>>(new Map());
  // Proxies being removed, or added to the pool from the detected ones.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<PoolFailure | null>(null);
  // `session` remounts the form on each open, so it starts from the saved proxy.
  const [editor, setEditor] = useState<{ open: boolean; session: number; proxy?: PoolProxy }>({
    open: false,
    session: 0,
  });
  const addRef = useRef<HTMLButtonElement>(null);
  const checkAllRef = useRef<HTMLButtonElement>(null);
  const modeRef = useRef<HTMLElement>(null);
  const fallbackRef = useRef<HTMLElement>(null);
  const intervalRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef<Refocus | null>(null);

  // Remove takes the row and its focused button, Add to pool its own button: focus goes on to
  // the next row's Remove (else the previous one's, else Add proxy), or the row's Test.
  useEffect(() => {
    const target = refocus.current;
    if (!target?.done(view)) return;
    refocus.current = null;
    // Focus is lost (on <body>), or still in the closing confirm, which would drop it next.
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('[role="alertdialog"]')) return;
    target.focus();
  }, [view]);

  const store = (next: ProxyPoolView) => {
    queryClient.setQueryData(queryKeys.settings.proxyPool(), next);
  };
  /** Reads the pool again; resolves once the new view is stored. */
  const reload = () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.proxyPool() });

  /** Focus a row's control, else Add proxy (the row is gone). */
  const focusRow = (id: string, action: RowAction) => {
    (rowControl(id, action) ?? addRef.current)?.focus();
  };

  const settings = useMutation({
    mutationFn: updateProxyPoolSettings,
    onMutate: (patch) => {
      setPending(patch);
      setFailure(null);
    },
    // The switch or select already shows the new value.
    onSuccess: (next) => {
      store(next);
      announce(t("settings:saved"));
    },
    onError: (error, patch) => {
      const control =
        patch.mode !== undefined
          ? modeRef
          : patch.directFallback !== undefined
            ? fallbackRef
            : intervalRef;
      // `mutate`, not saveSettings: this closure is from a render where the save was pending.
      setFailure({
        error,
        retry: () => settings.mutate(patch),
        focus: () => control.current?.focus(),
      });
    },
    onSettled: () => setPending(null),
  });
  const saveSettings = (patch: ProxyPoolSettingsPatch) => {
    if (!settings.isPending) settings.mutate(patch);
  };

  // Every row shows its new check; Check all spins meanwhile.
  const checkAll = useMutation({
    mutationFn: checkAllPoolProxies,
    onMutate: () => setFailure(null),
    onSuccess: (next) => {
      store(next);
      announce(t("card.checkAllDone"));
    },
    onError: (error) =>
      setFailure({
        error,
        retry: () => checkAll.mutate(),
        focus: () => checkAllRef.current?.focus(),
      }),
  });

  /** Tests one proxy: its row shows the result (state, last check, error) as Test stops. */
  const runTest = async (id: string, name: string, check: () => Promise<PoolProxyHealth>) => {
    setFailure(null);
    setTesting((prev) => toggled(prev, id, true));
    const result = await attempt(check);
    await reload();
    setTesting((prev) => toggled(prev, id, false));
    if (!result.ok) {
      setFailure({
        error: result.error,
        retry: () => void runTest(id, name, check),
        focus: () => focusRow(id, "test"),
        moot: (next) => !hasRow(next, id),
      });
      return;
    }
    const { status, failures, errorCode, errorStatus } = result.value;
    announce(
      status === "ok" && !failures
        ? t("card.testOk", { name })
        : t("card.testFailed", { name, error: proxyFailureSentence(errorCode, errorStatus, t) }),
    );
  };
  const test = (proxy: PoolProxy) =>
    runTest(proxy.id, mask(proxyName(proxy)), () =>
      checkPoolProxy(proxy.id).then(({ proxy: checked }) => checked.health),
    );
  const testDetected = (proxy: DetectedProxy) =>
    runTest(proxy.id, mask(proxy.url), () =>
      checkDetectedProxy(proxy.id).then(({ detected }) => detected.health),
    );

  /** The switch moves at once and waits, disabled, until the pool is read again. */
  const toggle = async (proxy: PoolProxy, enabled: boolean) => {
    setFailure(null);
    setSwitching((prev) => new Map(prev).set(proxy.id, enabled));
    const result = await attempt(() => setPoolProxyEnabled(proxy.id, enabled));
    await reload();
    setSwitching((prev) => {
      const next = new Map(prev);
      next.delete(proxy.id);
      return next;
    });
    if (!result.ok) {
      setFailure({
        error: result.error,
        retry: () => void toggle(proxy, enabled),
        focus: () => focusRow(proxy.id, "switch"),
        moot: (next) => !hasRow(next, proxy.id),
      });
      return;
    }
    const name = mask(proxyName(proxy));
    announce(enabled ? t("card.switchedOn", { name }) : t("card.switchedOff", { name }));
  };

  /** Add to pool spins; then the row says it is also in the pool, and the pool has a new row. */
  const runAdopt = async (proxy: DetectedProxy) => {
    setFailure(null);
    const adopted = (next: ProxyPoolView) =>
      !next.detected.some((item) => item.id === proxy.id && item.canAdopt);
    const mine: Refocus = { done: adopted, focus: () => focusRow(proxy.id, "test") };
    refocus.current = mine;
    setBusy((prev) => toggled(prev, proxy.id, true));
    const result = await attempt(() => adoptDetectedProxy(proxy.id));
    // Another row's remove or add may have taken the refocus meanwhile: leave that one be.
    if (!result.ok && refocus.current === mine) refocus.current = null;
    await reload();
    setBusy((prev) => toggled(prev, proxy.id, false));
    if (!result.ok) {
      setFailure({
        error: result.error,
        retry: () => void runAdopt(proxy),
        focus: () => focusRow(proxy.id, "adopt"),
        moot: adopted,
      });
      return;
    }
    announce(t("detected.adopted", { name: mask(proxy.url) }));
  };

  const adopt = async (proxy: DetectedProxy) => {
    const confirmed = await confirm({
      title: t("detected.adoptTitle"),
      description: t("detected.adoptBody", { name: mask(proxy.url) }),
      confirmLabel: t("detected.adopt"),
    });
    if (confirmed) await runAdopt(proxy);
  };

  /** Remove spins; then the row goes. */
  const runRemove = async (proxy: PoolProxy, order: readonly string[]) => {
    setFailure(null);
    const gone = (next: ProxyPoolView) => !next.proxies.some((item) => item.id === proxy.id);
    const mine: Refocus = {
      done: gone,
      focus: () => {
        const index = order.indexOf(proxy.id);
        for (const id of [...order.slice(index + 1), ...order.slice(0, index).reverse()]) {
          const control = rowControl(id, "remove");
          if (control) {
            control.focus();
            return;
          }
        }
        addRef.current?.focus();
      },
    };
    refocus.current = mine;
    setBusy((prev) => toggled(prev, proxy.id, true));
    const result = await attempt(() => removePoolProxy(proxy.id));
    // Another row's remove or add may have taken the refocus meanwhile: leave that one be.
    if (!result.ok && refocus.current === mine) refocus.current = null;
    await reload();
    setBusy((prev) => toggled(prev, proxy.id, false));
    if (!result.ok) {
      setFailure({
        error: result.error,
        retry: () => void runRemove(proxy, order),
        focus: () => focusRow(proxy.id, "remove"),
        moot: gone,
      });
      return;
    }
    announce(t("card.removed"));
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
    if (confirmed) {
      await runRemove(
        proxy,
        view.proxies.map((item) => item.id),
      );
    }
  };

  const on = (pending?.mode ?? view.mode) === "on";
  const fallback = pending?.directFallback ?? view.directFallback;
  const interval = pending?.checkIntervalMin ?? view.checkIntervalMin;
  const empty = view.proxies.length === 0;
  const anyProxy = !empty || view.detected.length > 0;
  const openEditor = (proxy?: PoolProxy) =>
    setEditor((prev) => ({ open: true, session: prev.session + 1, proxy }));

  // The rows get handlers that stay the same from render to render and call the latest ones, so
  // a memoised row renders again only when its own proxy or busy state changes, not for a test,
  // a switch or the dialog elsewhere in a pool of a hundred proxies.
  const latest = useRef({ test, toggle, remove, openEditor, testDetected, adopt });
  latest.current = { test, toggle, remove, openEditor, testDetected, adopt };
  const rowActions = useMemo<ProxyRowActions>(
    () => ({
      onTest: (proxy) => void latest.current.test(proxy),
      onToggle: (proxy, enabled) => void latest.current.toggle(proxy, enabled),
      onEdit: (proxy) => latest.current.openEditor(proxy),
      onRemove: (proxy) => void latest.current.remove(proxy),
    }),
    [],
  );
  const detectedActions = useMemo<DetectedRowActions>(
    () => ({
      onTest: (proxy) => void latest.current.testDetected(proxy),
      onAdopt: (proxy) => void latest.current.adopt(proxy),
    }),
    [],
  );

  return (
    <SettingsGroup
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => openEditor()} ref={addRef} size="sm" variant="secondary">
            <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" />
            {t("card.add")}
          </Button>
          {anyProxy ? (
            <Button
              loading={checkAll.isPending}
              onClick={() => checkAll.mutate()}
              ref={checkAllRef}
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
      {failure ? (
        <CardPanel>
          <ActionError
            error={failure.error}
            message={poolErrorMessage(failure.error, t)}
            onDismiss={() => {
              setFailure(null);
              failure.focus();
            }}
            onRetry={() => {
              // The notice goes: focus moves to the control that runs the action first.
              failure.focus();
              // Its row went meanwhile (another tab, or a try that went through but timed out).
              if (failure.moot?.(view)) setFailure(null);
              else failure.retry();
            }}
          />
        </CardPanel>
      ) : null}
      <SwitchField
        checked={on}
        description={empty && !on ? t("card.modeNeedsProxy") : t("card.modeHint")}
        // One settings save at a time: a change made while one is saving would be dropped.
        disabled={(empty && !on) || settings.isPending}
        onCheckedChange={(checked) => saveSettings({ mode: checked ? "on" : "off" })}
        switchRef={modeRef}
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
        disabled={settings.isPending}
        onCheckedChange={(directFallback) => saveSettings({ directFallback })}
        switchRef={fallbackRef}
        title={t("card.fallbackTitle")}
      />
      <SettingsRow
        control={
          <IntervalSelect
            disabled={settings.isPending}
            onChange={(checkIntervalMin) => saveSettings({ checkIntervalMin })}
            triggerRef={intervalRef}
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
            actions={rowActions}
            key={proxy.id}
            maxFailures={view.maxFailures}
            proxy={proxy}
            removing={busy.has(proxy.id)}
            switchingTo={switching.get(proxy.id)}
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
              actions={detectedActions}
              adopting={busy.has(proxy.id)}
              key={proxy.id}
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
          onClose={() => setEditor((prev) => ({ ...prev, open: false }))}
          onSaved={() => void reload()}
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
      className={`${SETTINGS_ROW_X} flex flex-wrap items-center gap-2 py-4`}
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
 * Details, which opens below so the sentence stays readable on a phone. A switched-off proxy
 * shows its last error only while its last check failed (a Test of it): its state stays Off.
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
  let lead: string;
  let tone: string;
  if (proxy.state === "off") {
    lead = t("card.offNote");
    tone = "text-muted-foreground";
  } else if (proxy.state === "auto_disabled") {
    lead = t("card.autoDisabledNote", { max: maxFailures ?? 3 });
    tone = "text-destructive-foreground";
  } else if (proxy.state === "unhealthy") {
    lead =
      maxFailures !== undefined
        ? t("card.strikesNote", { count: failures, max: maxFailures })
        : t("detected.failingNote", { count: failures });
    tone = "text-warning-foreground";
  } else {
    return null;
  }
  const error = proxy.state === "off" ? failures > 0 && lastError : lastError;
  // Sentences joined the language's way: a space in English, none after "。" in Chinese.
  const join = t("common:text.joinSentences");
  return (
    <p className={`wrap-anywhere text-xs ${tone}`}>
      {error
        ? fillNodes(join, {
            first: lead,
            second: fillNodes(join, {
              first: t("card.lastError", {
                error: proxyFailureSentence(errorCode, errorStatus, t),
              }),
              // The link look of Settings' "Learn more": the raw error is a longer note.
              second: (
                <InfoHint hint={mask(error)} variant="link">
                  {t("card.lastErrorDetails")}
                </InfoHint>
              ),
            }),
          })
        : lead}
    </p>
  );
}

/** A pool row's actions; the same object on every render of the card. */
interface ProxyRowActions {
  onTest: (proxy: PoolProxy) => void;
  onToggle: (proxy: PoolProxy, enabled: boolean) => void;
  onEdit: (proxy: PoolProxy) => void;
  onRemove: (proxy: PoolProxy) => void;
}

/** A detected row's actions; the same object on every render of the card. */
interface DetectedRowActions {
  onTest: (proxy: DetectedProxy) => void;
  onAdopt: (proxy: DetectedProxy) => void;
}

/**
 * One proxy: its name and state, then its address, sign-in, last check, latency and load. The
 * switch takes it out of the pool without removing it.
 */
const ProxyRow = memo(function ProxyRow({
  proxy,
  maxFailures,
  testing,
  switchingTo,
  removing,
  actions,
}: {
  proxy: PoolProxy;
  maxFailures: number;
  testing: boolean;
  /** Switched on or off, and saving: the switch shows the new state, disabled, meanwhile. */
  switchingTo?: boolean;
  removing: boolean;
  actions: ProxyRowActions;
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
            checked={switchingTo ?? proxy.enabled}
            data-action="switch"
            data-proxy={proxy.id}
            disabled={switchingTo !== undefined}
            onCheckedChange={(next) => actions.onToggle(proxy, next)}
          />
          {/* Each action also reads the proxy after its name, so nine Tests are told apart. */}
          <Button
            aria-description={name}
            data-action="test"
            data-proxy={proxy.id}
            loading={testing}
            onClick={() => actions.onTest(proxy)}
            size="sm"
            variant="secondary"
          >
            <HugeiconsIcon icon={Wifi01Icon} aria-hidden="true" />
            {t("actions.test")}
          </Button>
          <Button
            aria-description={name}
            onClick={() => actions.onEdit(proxy)}
            size="sm"
            variant="secondary"
          >
            <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
            {t("common:actions.edit")}
          </Button>
          <Button
            aria-description={name}
            data-action="remove"
            data-proxy={proxy.id}
            loading={removing}
            onClick={() => actions.onRemove(proxy)}
            size="sm"
            variant="danger"
          >
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
});

/**
 * A proxy in use outside the pool: the global proxy or accounts' own. Checked like a pool proxy
 * and never shared; one without a sign-in can join the pool, one with a sign-in never does.
 */
const DetectedRow = memo(function DetectedRow({
  proxy,
  testing,
  adopting,
  actions,
}: {
  proxy: DetectedProxy;
  testing: boolean;
  adopting: boolean;
  actions: DetectedRowActions;
}): JSX.Element {
  const { t } = useT("proxy-pool");
  const mask = useMaskText();
  const look = stateLook(proxy.state);
  const accounts = proxy.accountIds.length;
  return (
    <SettingsRow
      control={
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2 @xl/settings-row:justify-end">
          {/* Each action also reads the proxy after its name, as in the pool's rows. */}
          <Button
            aria-description={proxy.url}
            data-action="test"
            data-proxy={proxy.id}
            loading={testing}
            onClick={() => actions.onTest(proxy)}
            size="sm"
            variant="secondary"
          >
            <HugeiconsIcon icon={Wifi01Icon} aria-hidden="true" />
            {t("actions.test")}
          </Button>
          {proxy.canAdopt ? (
            <Button
              aria-description={proxy.url}
              data-action="adopt"
              data-proxy={proxy.id}
              loading={adopting}
              onClick={() => actions.onAdopt(proxy)}
              size="sm"
              variant="secondary"
            >
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
});
