import {
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  Delete02Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, type RefObject, useId, useMemo, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { PasswordInput } from "@/components/shared/password-input";
import { RelativeTime } from "@/components/shared/relative-time";
import {
  ROW_DESCRIPTION,
  SettingsEmptyRow,
  SettingsRow,
  SwitchField,
} from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { announce } from "@/lib/announce";
import {
  ALERT_CHANNEL_TYPES,
  type AlertChannel,
  type AlertChannelInput,
  type AlertChannelType,
  type AlertDelivery,
  type AlertsConfig,
  alertDeliveryErrorText,
  alertsQuery,
  alertsQueryKey,
  testAlertChannel,
  testDailySummary,
  updateAlerts,
} from "@/lib/api/alerts";
import { ApiError, isApiError } from "@/lib/api/errors";
import { dateTimeFormat } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { useDraft } from "../lib/dirty";
import {
  CHAT_ID_MAX,
  type ChannelDraft,
  type ChannelErrors,
  type ChannelField,
  type ChannelProblem,
  COOLDOWN_MAX,
  COOLDOWN_MIN,
  channelDraft,
  formatThresholds,
  formatUtcMinute,
  invalidRulesFields,
  keepThresholdChars,
  MAX_CHANNELS,
  NAME_MAX,
  newChannelDraft,
  parseThresholds,
  type RulesField,
  type RulesForm,
  rulesForm,
  SECRET_MAX,
  serverChannelProblem,
  summaryTimeDate,
  summaryTimeOptions,
  toChannelInputs,
  URL_MAX,
  validateChannelDraft,
  withDraft,
} from "./alerts-model";
import { SECTION_ID } from "./sections";
import {
  DialogSaveButton,
  FieldControl,
  FooterSaveError,
  fillNodes,
  RowAction,
  RowActionError,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  useSavedThenClose,
  useSectionSave,
} from "./settings-section";

/** Events a last result can name; anything else shows no event label. */
const EVENTS = [
  "account_usage",
  "pool_usage",
  "account_banned",
  "all_unavailable",
  "daily_summary",
  "test",
];

/** Example targets for the URL field; addresses, so not translated. */
const URL_PLACEHOLDER: Record<Exclude<AlertChannelType, "telegram">, string> = {
  webhook: "https://example.com/hooks/kiro",
  discord: "https://discord.com/api/webhooks/…",
  slack: "https://hooks.slack.com/services/…",
};

const SIGNATURE_HEADER = "X-Kiro-Proxy-Signature";

/** The code, field and channel index of a 400 from POST /alerts. */
function alertErrorFields(error: unknown): { code?: string; field?: string; index?: number } {
  if (!isApiError(error) || typeof error.body !== "object" || error.body === null) return {};
  const body = error.body as Record<string, unknown>;
  return {
    code: typeof body.code === "string" ? body.code : undefined,
    field: typeof body.field === "string" ? body.field : undefined,
    index: typeof body.index === "number" ? body.index : undefined,
  };
}

/** The reason for one of the alert codes, in the UI language; null for any other error. */
function alertsCodeText(error: unknown, t: TFunction): string | null {
  switch (alertErrorFields(error).code) {
    case "alert_thresholds_invalid":
      return t("alerts:thresholdsInvalid");
    case "alert_cooldown_range":
      return t("alerts:cooldownInvalid", { min: COOLDOWN_MIN, max: COOLDOWN_MAX });
    case "alert_channel_limit":
      return t("alerts:channelLimit", { max: MAX_CHANNELS });
    default:
      return null;
  }
}

/**
 * A POST /alerts that throws the alert codes' reasons in the UI language, so the card's inline
 * error shows them translated; the code, field and index stay on the error's body.
 */
async function postAlerts(
  body: Parameters<typeof updateAlerts>[0],
  t: TFunction,
): Promise<AlertsConfig> {
  try {
    return await updateAlerts(body);
  } catch (error) {
    const text = isApiError(error) ? alertsCodeText(error, t) : null;
    if (!isApiError(error) || text === null) throw error;
    throw new ApiError({
      status: error.status,
      serverMessage: text,
      body: error.body,
      index: error.index,
    });
  }
}

/** The channel field a failed channel save names, when the dialog can mark it; else null. */
function channelFieldError(
  error: unknown,
  vars: { index: number; draft?: ChannelDraft } | undefined,
): ChannelField | null {
  const { code, field, index } = alertErrorFields(error);
  if (!vars?.draft || code !== "alert_channel_invalid" || index !== vars.index) return null;
  return isChannelField(field) ? field : null;
}

function isRulesField(field: string | undefined): field is RulesField {
  return (
    field === "accountThresholds" || field === "poolThresholds" || field === "poolCooldownMinutes"
  );
}

function isChannelField(field: string | undefined): field is ChannelField {
  return (
    field === "name" ||
    field === "url" ||
    field === "botToken" ||
    field === "chatId" ||
    field === "secret"
  );
}

/** The channel's name (emails in it masked under privacy), or its type when it has none. */
function channelLabel(
  channel: { name: string; type: AlertChannelType },
  t: TFunction,
  mask: (text?: string) => string,
): string {
  return mask(channel.name.trim()) || t(`type.${channel.type}`);
}

export function AlertsCard(): JSX.Element {
  const { t } = useT("alerts");
  const query = useQuery(alertsQuery());
  return (
    <SectionQuery id={SECTION_ID.alerts} query={query} title={t("title")}>
      {(config) => <AlertsPanel config={config} />}
    </SectionQuery>
  );
}

/** The rules as POST /alerts takes them; only called with a form that passed validation. */
function rulesPatch(form: RulesForm) {
  const account = parseThresholds(form.accountThresholds);
  const pool = parseThresholds(form.poolThresholds);
  return {
    accountUsage: form.accountUsage,
    poolUsage: form.poolUsage,
    accountBanned: form.accountBanned,
    allUnavailable: form.allUnavailable,
    accountThresholds: account.ok ? account.values : [],
    poolThresholds: pool.ok ? pool.values : [],
    poolCooldownMinutes: form.poolCooldownMinutes ?? 0,
    dailySummary: form.dailySummary,
    dailySummaryMinute: form.dailySummaryMinute,
  };
}

/** The viewer's time zone name ("Europe/Ljubljana"); "" when the browser does not say. */
function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * The summary's send time: each whole hour of the viewer's day, labelled with the local time and
 * the UTC time the server stores, so the zone is never in doubt.
 */
function SummaryTimeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (utcMinute: number) => void;
}): JSX.Element {
  const { t, lang } = useT("alerts");
  // The language's own clock: "7:00 AM" in English (not "07:00 AM"), "07:00" where 24-hour.
  const clock = dateTimeFormat(lang, { timeStyle: "short" });
  const items = summaryTimeOptions(value).map((minute) => ({
    value: minute,
    label: t("dailySummaryTimeOption", {
      local: clock.format(summaryTimeDate(minute)),
      utc: formatUtcMinute(minute),
    }),
  }));
  return (
    <Select
      items={items}
      onValueChange={(next) => {
        if (typeof next === "number") onChange(next);
      }}
      value={value}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      {/* 48 half hours: a list under the field, capped at 22rem and scrolling, instead of one
          laid over the field that grows to the window's height to line the chosen time up. */}
      <SelectPopup alignItemWithTrigger={false}>
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
 * One card: the channels first (nothing is sent without one), each saved at once from its
 * dialog like the outbound proxy; then the rules, saved together with Save.
 */
function AlertsPanel({ config }: { config: AlertsConfig }): JSX.Element {
  const { t } = useT("alerts");
  const mask = useMaskText();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const accountId = useId();
  const poolId = useId();
  const cooldownId = useId();
  const summaryTimeId = useId();

  const server = useMemo(() => rulesForm(config), [config]);
  const draft = useDraft<RulesForm>(server);
  const [invalid, setInvalid] = useState<RulesField[]>([]);
  const edit = (patch: Partial<RulesForm>, field?: RulesField) => {
    if (field) setInvalid((prev) => prev.filter((item) => item !== field));
    draft.set((prev) => ({ ...prev, ...patch }));
  };

  const rules = useSectionSave((form: RulesForm) => postAlerts(rulesPatch(form), t), {
    onSaved: (form) => {
      const patch = rulesPatch(form);
      draft.commit({
        ...form,
        accountThresholds: formatThresholds(patch.accountThresholds),
        poolThresholds: formatThresholds(patch.poolThresholds),
      });
      void queryClient.invalidateQueries({ queryKey: alertsQueryKey });
    },
    onFailed: (error) => {
      const { field } = alertErrorFields(error);
      if (!isRulesField(field)) return false;
      // The field shows the reason; the footer shows nothing more.
      setInvalid([field]);
      return true;
    },
  });

  const onSubmit = () => {
    const bad = invalidRulesFields(draft.value);
    setInvalid(bad);
    if (bad.length === 0) rules.save(draft.value);
  };

  // The channel dialog: `session` remounts the form on each open.
  const [editor, setEditor] = useState<{ open: boolean; session: number; id: string | null }>({
    open: false,
    session: 0,
    id: null,
  });
  const [serverErrors, setServerErrors] = useState<ChannelErrors>({});
  const addRef = useRef<HTMLButtonElement>(null);
  const testAllRef = useRef<HTMLButtonElement>(null);
  const editing = editor.id
    ? config.channels.find((channel) => channel.id === editor.id)
    : undefined;
  // The dialog's Save reads "Saved", then the dialog closes on the saved row; a removed row
  // goes. A failure shows in the dialog, or under the row for a removal.
  const savedClose = useSavedThenClose(() => setEditor((prev) => ({ ...prev, open: false })));

  const channels = useMutation({
    mutationFn: (vars: {
      inputs: AlertChannelInput[];
      index: number;
      draft?: ChannelDraft;
      removedId?: string;
    }) => postAlerts({ channels: vars.inputs }, t),
    onSuccess: (data, vars) => {
      queryClient.setQueryData(alertsQueryKey, data);
      announce(vars.removedId ? t("channelRemoved") : t("channelSaved"));
      if (vars.removedId) addRef.current?.focus();
      else savedClose.done();
    },
    onError: (error, vars) => {
      const field = channelFieldError(error, vars);
      if (field && vars.draft)
        setServerErrors({ [field]: serverChannelProblem(field, vars.draft) });
    },
  });
  // A failed save that the dialog cannot mark at a field: over its buttons.
  const dialogError =
    channels.isError &&
    channels.variables?.draft &&
    channelFieldError(channels.error, channels.variables) === null
      ? channels.error
      : null;
  const removeFailedId =
    channels.isError && channels.variables?.removedId ? channels.variables.removedId : null;

  const openEditor = (id: string | null) => {
    setServerErrors({});
    // A save still on its way keeps its state (Save stays busy); only a failure is cleared.
    if (channels.isError && channels.variables?.draft) channels.reset();
    savedClose.reset();
    setEditor((prev) => ({ open: true, session: prev.session + 1, id }));
  };
  const closeEditor = () => {
    if (channels.isError && channels.variables?.draft) channels.reset();
    setEditor((prev) => ({ ...prev, open: false }));
  };

  const saveDraft = (next: ChannelDraft) => {
    const { inputs, index } = withDraft(config.channels, next);
    channels.mutate({ inputs, index, draft: next });
  };

  const removeNow = (channel: AlertChannel) => {
    const rest = config.channels.filter((item) => item.id !== channel.id);
    channels.mutate({ inputs: toChannelInputs(rest), index: -1, removedId: channel.id });
  };

  const onRemove = async (channel: AlertChannel) => {
    const name = channelLabel(channel, t, mask);
    const confirmed = await confirm({
      title: t("removeChannelTitle", { name }),
      description: t("removeChannelBody"),
      confirmLabel: t("removeChannel"),
      target: name,
      variant: "danger",
    });
    if (confirmed) removeNow(channel);
  };

  // Channels with a test in flight: tests of two channels can overlap, and each keeps its spinner.
  const [testing, setTesting] = useState<ReadonlySet<string>>(() => new Set());
  // Tests that did not reach the server, by channel: each shows under its row until retried.
  const [testErrors, setTestErrors] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const clearTestError = (id: string) =>
    setTestErrors((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  // The row's last result changes on screen, and a screen reader hears it.
  const test = useMutation({
    mutationFn: (channel: AlertChannel) => testAlertChannel(channel.id),
    onMutate: (channel) => {
      clearTestError(channel.id);
      setTesting((prev) => new Set(prev).add(channel.id));
    },
    onSettled: (_result, _error, channel) =>
      setTesting((prev) => {
        const next = new Set(prev);
        next.delete(channel.id);
        return next;
      }),
    onSuccess: (result, channel) => {
      queryClient.setQueryData<AlertsConfig>(alertsQueryKey, (old) =>
        old
          ? {
              ...old,
              channels: old.channels.map((item) =>
                item.id === channel.id ? { ...item, lastResult: result } : item,
              ),
            }
          : old,
      );
      const name = channelLabel(channel, t, mask);
      if (result.ok) announce(t("testOk", { name }));
      else {
        const reason =
          mask(alertDeliveryErrorText(result, t)) || t("attempts", { count: result.attempts });
        announce(t("testFailed", { name, reason }), { assertive: true });
      }
    },
    onError: (error, channel) => setTestErrors((prev) => new Map(prev).set(channel.id, error)),
  });

  // The summary test's outcome, said under its button until the next test.
  const [summaryResult, setSummaryResult] = useState<{ failed: number; count: number } | null>(
    null,
  );
  const summaryTest = useMutation({
    mutationFn: testDailySummary,
    onMutate: () => setSummaryResult(null),
    onSuccess: (data) => {
      const byId = new Map(data.results.map((result) => [result.channelId, result]));
      queryClient.setQueryData<AlertsConfig>(alertsQueryKey, (old) =>
        old
          ? {
              ...old,
              channels: old.channels.map((item) => {
                const result = byId.get(item.id);
                if (!result) return item;
                const { channelId: _id, ...lastResult } = result;
                return { ...item, lastResult };
              }),
            }
          : old,
      );
      const failed = data.results.filter((result) => !result.ok).length;
      const count = data.results.length;
      setSummaryResult({ failed, count });
      if (failed === 0) announce(t("dailySummaryTestOk", { count }));
      else announce(t("dailySummaryTestFailed", { failed, count }), { assertive: true });
    },
  });

  const enabledCount = config.channels.filter((channel) => channel.enabled).length;
  const zone = viewerTimeZone();
  const summaryUtc = formatUtcMinute(draft.value.dailySummaryMinute);
  const summaryTimeHint = zone
    ? t("dailySummaryTimeHint", { zone, utc: summaryUtc })
    : t("dailySummaryTimeHintNoZone", { utc: summaryUtc });
  // A live "5 minutes ago": nothing refetches the config while the page stays open.
  const lastSent =
    config.dailySummaryLastSent > 0
      ? fillNodes(t("dailySummaryLastSent"), {
          relative: <RelativeTime value={config.dailySummaryLastSent} />,
        })
      : null;
  const full = config.channels.length >= MAX_CHANNELS;
  const invalidText = (field: RulesField): string | null => {
    if (!invalid.includes(field)) return null;
    return field === "poolCooldownMinutes"
      ? t("cooldownInvalid", { min: COOLDOWN_MIN, max: COOLDOWN_MAX })
      : t("thresholdsInvalid");
  };

  return (
    <SettingsSection
      badge={
        enabledCount > 0 ? (
          <Badge icon={CircleCheckIcon} size="sm" tone="success">
            {t("channelsOn", { count: enabledCount })}
          </Badge>
        ) : (
          <Badge icon={CircleSlashIcon} size="sm" tone="neutral">
            {t("noChannelOn")}
          </Badge>
        )
      }
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={() => {
            setInvalid([]);
            draft.reload();
          }}
          feedback={rules.feedback}
          serverChanged={draft.serverChanged}
        />
      }
      hint={t("description")}
      id={SECTION_ID.alerts}
      onSubmit={onSubmit}
      title={t("title")}
    >
      <SettingsRow
        control={
          <RowAction>
            <Button
              disabled={full}
              onClick={() => openEditor(null)}
              ref={addRef}
              size="sm"
              variant="secondary"
            >
              <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" />
              {t("addChannel")}
            </Button>
          </RowAction>
        }
        controlWidth="actions"
        description={full ? t("channelLimit", { max: MAX_CHANNELS }) : t("channelsHint")}
        status={
          <Badge size="sm" tone="neutral">
            {config.channels.length}
          </Badge>
        }
        title={t("channels")}
      />
      {config.channels.length === 0 ? (
        <SettingsEmptyRow>{t("noChannels")}</SettingsEmptyRow>
      ) : (
        <ul
          aria-label={t("channels")}
          className="[&>li+li]:border-border-subtle [&>li+li]:border-t"
        >
          {config.channels.map((channel) => (
            <li key={channel.id}>
              <ChannelRow
                channel={channel}
                failure={
                  removeFailedId === channel.id
                    ? {
                        action: "remove",
                        error: channels.error,
                        retry: () => removeNow(channel),
                        dismiss: channels.reset,
                      }
                    : testErrors.has(channel.id)
                      ? {
                          action: "test",
                          error: testErrors.get(channel.id),
                          retry: () => test.mutate(channel),
                          dismiss: () => clearTestError(channel.id),
                        }
                      : null
                }
                onEdit={() => openEditor(channel.id)}
                onRemove={() => void onRemove(channel)}
                onTest={() => test.mutate(channel)}
                removing={channels.isPending && channels.variables?.removedId === channel.id}
                testing={testing.has(channel.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <SettingsRow description={t("rulesHint")} title={t("rulesHeading")} />
      <SwitchField
        checked={draft.value.accountUsage}
        description={t("accountUsageHint")}
        onCheckedChange={(accountUsage) => edit({ accountUsage })}
        title={t("accountUsage")}
      />
      <SettingsRow
        control={
          <FieldControl error={invalidText("accountThresholds")}>
            {/* A text keyboard, not the numeric pad: a phone's pad has no comma or space. */}
            <Input
              autoComplete="off"
              id={accountId}
              onChange={(event) =>
                edit(
                  { accountThresholds: keepThresholdChars(event.target.value) },
                  "accountThresholds",
                )
              }
              placeholder={formatThresholds([80, 90, 100])}
              spellCheck={false}
              value={draft.value.accountThresholds}
            />
          </FieldControl>
        }
        description={t("thresholdsHint")}
        htmlFor={accountId}
        title={t("accountThresholds")}
      />
      <SwitchField
        checked={draft.value.poolUsage}
        description={t("poolUsageHint")}
        onCheckedChange={(poolUsage) => edit({ poolUsage })}
        title={t("poolUsage")}
      />
      <SettingsRow
        control={
          <FieldControl error={invalidText("poolThresholds")}>
            <Input
              autoComplete="off"
              id={poolId}
              onChange={(event) =>
                edit({ poolThresholds: keepThresholdChars(event.target.value) }, "poolThresholds")
              }
              placeholder={formatThresholds([80, 90, 100])}
              spellCheck={false}
              value={draft.value.poolThresholds}
            />
          </FieldControl>
        }
        description={t("thresholdsHint")}
        htmlFor={poolId}
        title={t("poolThresholds")}
      />
      {/* One Field round the row, as the auto-continue card: the error sits under the description. */}
      <Field className="items-stretch" invalid={invalid.includes("poolCooldownMinutes")}>
        <SettingsRow
          control={
            <CooldownField
              id={cooldownId}
              onValueChange={(value) => edit({ poolCooldownMinutes: value }, "poolCooldownMinutes")}
              value={draft.value.poolCooldownMinutes}
            />
          }
          controlWidth="number"
          description={t("poolCooldownHint")}
          htmlFor={cooldownId}
          title={t("poolCooldown")}
        >
          {invalid.includes("poolCooldownMinutes") ? (
            <FieldError match>{invalidText("poolCooldownMinutes")}</FieldError>
          ) : null}
        </SettingsRow>
      </Field>
      <SwitchField
        checked={draft.value.accountBanned}
        description={t("accountBannedHint")}
        onCheckedChange={(accountBanned) => edit({ accountBanned })}
        title={t("accountBanned")}
      />
      <SwitchField
        checked={draft.value.allUnavailable}
        description={t("allUnavailableHint")}
        onCheckedChange={(allUnavailable) => edit({ allUnavailable })}
        title={t("allUnavailable")}
      />
      <SwitchField
        checked={draft.value.dailySummary}
        description={t("dailySummaryHint")}
        onCheckedChange={(dailySummary) => edit({ dailySummary })}
        title={t("dailySummary")}
      />
      <SettingsRow
        control={
          <SummaryTimeSelect
            id={summaryTimeId}
            onChange={(dailySummaryMinute) => edit({ dailySummaryMinute })}
            value={draft.value.dailySummaryMinute}
          />
        }
        description={
          lastSent
            ? fillNodes(t("common:text.joinSentences"), {
                first: summaryTimeHint,
                second: lastSent,
              })
            : summaryTimeHint
        }
        htmlFor={summaryTimeId}
        title={t("dailySummaryTime")}
      />
      <SettingsRow
        control={
          <RowAction>
            <Button
              disabled={enabledCount === 0}
              loading={summaryTest.isPending}
              loadingText={t("sending")}
              onClick={() => summaryTest.mutate()}
              ref={testAllRef}
              size="sm"
              variant="secondary"
            >
              <HugeiconsIcon icon={SentIcon} aria-hidden="true" />
              {t("dailySummaryTest")}
            </Button>
          </RowAction>
        }
        controlWidth="actions"
        description={
          enabledCount === 0 ? t("dailySummaryTestNoChannel") : t("dailySummaryTestHint")
        }
        title={t("dailySummaryTestTitle")}
      >
        {summaryResult ? (
          <p
            className={cn(
              ROW_DESCRIPTION,
              summaryResult.failed > 0 && "text-destructive-foreground",
            )}
          >
            {summaryResult.failed === 0
              ? t("dailySummaryTestOk", { count: summaryResult.count })
              : t("dailySummaryTestFailed", summaryResult)}
          </p>
        ) : null}
        {summaryTest.isError ? (
          <RowActionError
            error={summaryTest.error}
            focusTarget={testAllRef}
            onDismiss={summaryTest.reset}
            onRetry={() => summaryTest.mutate()}
          />
        ) : null}
      </SettingsRow>

      <Dialog
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editor.open}
      >
        <ChannelEditor
          done={savedClose.saved}
          error={dialogError}
          key={editor.session}
          onDismissError={channels.reset}
          onEdit={() => {
            setServerErrors({});
            if (dialogError !== null) channels.reset();
          }}
          onSave={saveDraft}
          saved={editing}
          saving={channels.isPending && channels.variables?.removedId === undefined}
          serverErrors={serverErrors}
        />
      </Dialog>
    </SettingsSection>
  );
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/** The cooldown number field; the row's label and description go to the input itself. */
function CooldownField({
  id,
  value,
  onValueChange,
  ...aria
}: AriaProps & {
  id: string;
  value: number | null;
  onValueChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <NumberField
      allowOutOfRange
      id={id}
      max={COOLDOWN_MAX}
      min={COOLDOWN_MIN}
      onValueChange={onValueChange}
      step={1}
      value={value}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement />
        <NumberFieldInput {...aria} />
        <NumberFieldIncrement />
      </NumberFieldGroup>
    </NumberField>
  );
}

/**
 * One channel as a settings row: its name with the type (and Off) pills, where it sends, and its
 * last result; Send test, Edit and Remove under the text on a narrow row, at its end on a wide one.
 */
function ChannelRow({
  channel,
  testing,
  removing,
  failure,
  onTest,
  onEdit,
  onRemove,
}: {
  channel: AlertChannel;
  testing: boolean;
  removing: boolean;
  /** A test or removal that failed, under the last result until retried or closed. */
  failure: {
    action: "test" | "remove";
    error: unknown;
    retry: () => void;
    dismiss: () => void;
  } | null;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useT("alerts");
  const mask = useMaskText();
  const testRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const focusTarget: RefObject<HTMLButtonElement | null> =
    failure?.action === "remove" ? removeRef : testRef;
  const name = channelLabel(channel, t, mask);
  const target = [
    channel.targetHint,
    channel.type === "telegram" && channel.chatId ? t("chatIdValue", { id: channel.chatId }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SettingsRow
      control={
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2 @xl/settings-row:justify-end">
          <Button
            aria-label={t("sendTestTo", { name })}
            loading={testing}
            loadingText={t("sending")}
            onClick={onTest}
            ref={testRef}
            size="sm"
            variant="secondary"
          >
            <HugeiconsIcon icon={SentIcon} aria-hidden="true" />
            {t("sendTest")}
          </Button>
          <Button
            aria-label={t("editChannelNamed", { name })}
            onClick={onEdit}
            size="sm"
            variant="secondary"
          >
            <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
            {t("common:actions.edit")}
          </Button>
          <Button
            aria-label={t("removeChannelNamed", { name })}
            loading={removing}
            onClick={onRemove}
            ref={removeRef}
            size="sm"
            variant="danger"
          >
            <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
            {t("removeChannel")}
          </Button>
        </fieldset>
      }
      controlWidth="actions"
      description={
        target ? (
          <span className="wrap-anywhere" translate="no">
            {target}
          </span>
        ) : undefined
      }
      status={
        <>
          <Badge size="sm" tone="neutral">
            {t(`type.${channel.type}`)}
          </Badge>
          {channel.enabled ? null : (
            <Badge icon={CircleSlashIcon} size="sm" tone="warning">
              {t("channelOff")}
            </Badge>
          )}
        </>
      }
      title={<span className="wrap-anywhere">{name}</span>}
    >
      <LastResult result={channel.lastResult} />
      {/* Try again removes at once: the removal was already confirmed. */}
      {failure ? (
        <RowActionError
          error={failure.error}
          focusTarget={focusTarget}
          onDismiss={failure.dismiss}
          onRetry={failure.retry}
        />
      ) : null}
    </SettingsRow>
  );
}

/** "Delivered · Test · 5 minutes ago · 1 attempt", and the scrubbed error under a failure. */
function LastResult({ result }: { result: AlertDelivery | null }): JSX.Element {
  const { t } = useT("alerts");
  const mask = useMaskText();
  if (!result) return <p className={ROW_DESCRIPTION}>{t("lastNever")}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
        <Badge
          icon={result.ok ? CircleCheckIcon : CircleXIcon}
          size="sm"
          tone={result.ok ? "success" : "destructive"}
        >
          {result.ok ? t("lastOk") : t("lastFailed")}
        </Badge>
        {EVENTS.includes(result.event) ? <span>{t(`event.${result.event}`)}</span> : null}
        <RelativeTime value={result.ts} />
        <span>{t("attempts", { count: result.attempts })}</span>
      </p>
      {!result.ok && (result.error || result.errorCode) ? (
        <p className="text-pretty text-destructive-foreground text-xs leading-normal wrap-anywhere">
          {mask(alertDeliveryErrorText(result, t))}
        </p>
      ) : null}
    </div>
  );
}

function problemText(problem: ChannelProblem, t: TFunction): string {
  switch (problem) {
    case "required":
      return t("required");
    case "urlInvalid":
      return t("urlInvalid");
    case "urlTooLong":
      return t("tooLong", { max: URL_MAX });
    case "nameTooLong":
      return t("tooLong", { max: NAME_MAX });
    case "botTokenInvalid":
      return t("botTokenInvalid");
    case "chatIdInvalid":
      return t("chatIdInvalid");
    case "secretTooLong":
      return t("tooLong", { max: SECRET_MAX });
  }
}

/**
 * The add/edit form. Saved secrets are never sent to the browser: their fields start blank, say
 * so in their placeholder, and a blank one keeps the saved value. A saved signing secret can also
 * be removed. Changing the type asks for the new type's secrets.
 */
function ChannelEditor({
  saved,
  saving,
  done,
  error: saveError,
  serverErrors,
  onEdit,
  onSave,
  onDismissError,
}: {
  saved: AlertChannel | undefined;
  saving: boolean;
  /** Saved: Save reads "Saved" while the dialog closes. */
  done: boolean;
  /** A failed save no field can show, over the buttons until the form changes. */
  error: unknown;
  serverErrors: ChannelErrors;
  onEdit: () => void;
  onSave: (draft: ChannelDraft) => void;
  onDismissError: () => void;
}): JSX.Element {
  const { t } = useT("alerts");
  const id = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<ChannelDraft>(() =>
    saved ? channelDraft(saved) : newChannelDraft(),
  );
  const [errors, setErrors] = useState<ChannelErrors>({});
  const shown: ChannelErrors = { ...serverErrors, ...errors };
  const update = (patch: Partial<ChannelDraft>) => {
    setErrors({});
    onEdit();
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  const sameType = saved !== undefined && saved.type === draft.type;
  const keepHint = (set: boolean | undefined) => (sameType && set ? t("secretKeep") : undefined);
  const error = (field: ChannelField) => {
    const problem = shown[field];
    return problem ? <FieldError match>{problemText(problem, t)}</FieldError> : null;
  };

  return (
    <DialogPopup>
      <form
        className="flex min-h-0 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // The dialog renders inside the card's form; its submit must not reach that one.
          event.stopPropagation();
          if (saving || done) return;
          const found = validateChannelDraft(draft, saved);
          setErrors(found);
          if (Object.keys(found).length === 0) onSave(draft);
        }}
      >
        <DialogHeader>
          <DialogTitle>{saved ? t("editChannel") : t("addChannel")}</DialogTitle>
          <DialogDescription>{t("dialogHint")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <Label id={`${id}-type`}>{t("type")}</Label>
              <Select
                items={ALERT_CHANNEL_TYPES.map((type) => ({
                  value: type,
                  label: t(`type.${type}`),
                }))}
                onValueChange={(next) => {
                  if (next) update({ type: next as AlertChannelType });
                }}
                value={draft.type}
              >
                <SelectTrigger aria-labelledby={`${id}-type`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {ALERT_CHANNEL_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`type.${type}`)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Field className="min-w-0 items-stretch" invalid={shown.name !== undefined}>
              <FieldLabel>{t("name")}</FieldLabel>
              <Input
                autoComplete="off"
                maxLength={NAME_MAX}
                onChange={(event) => update({ name: event.target.value })}
                placeholder={t(`type.${draft.type}`)}
                value={draft.name}
              />
              {error("name")}
            </Field>
          </div>

          {draft.type === "telegram" ? (
            <>
              <Field className="min-w-0 items-stretch" invalid={shown.botToken !== undefined}>
                <FieldLabel>{t("botToken")}</FieldLabel>
                <PasswordInput
                  maxLength={SECRET_MAX}
                  autoComplete="off"
                  onChange={(botToken) => update({ botToken })}
                  placeholder={keepHint(saved?.botTokenSet)}
                  value={draft.botToken}
                />
                <FieldDescription>{t("botTokenHint")}</FieldDescription>
                {error("botToken")}
              </Field>
              <Field className="min-w-0 items-stretch" invalid={shown.chatId !== undefined}>
                <FieldLabel>{t("chatId")}</FieldLabel>
                <Input
                  maxLength={CHAT_ID_MAX}
                  autoComplete="off"
                  onChange={(event) => update({ chatId: event.target.value })}
                  placeholder="-1001234567890"
                  spellCheck={false}
                  value={draft.chatId}
                />
                <FieldDescription>{t("chatIdHint")}</FieldDescription>
                {error("chatId")}
              </Field>
            </>
          ) : (
            <Field className="min-w-0 items-stretch" invalid={shown.url !== undefined}>
              <FieldLabel>{t("url")}</FieldLabel>
              <PasswordInput
                maxLength={URL_MAX}
                autoComplete="off"
                onChange={(url) => update({ url })}
                placeholder={keepHint(saved?.urlSet) ?? URL_PLACEHOLDER[draft.type]}
                value={draft.url}
              />
              <FieldDescription>{t(`urlHint.${draft.type}`)}</FieldDescription>
              {error("url")}
            </Field>
          )}

          {draft.type === "webhook" ? (
            <div className="flex min-w-0 flex-col gap-2">
              <Field className="min-w-0 items-stretch" invalid={shown.secret !== undefined}>
                <FieldLabel>{t("signingSecret")}</FieldLabel>
                <PasswordInput
                  maxLength={SECRET_MAX}
                  autoComplete="new-password"
                  disabled={draft.clearSecret}
                  onChange={(secret) => update({ secret })}
                  placeholder={draft.clearSecret ? undefined : keepHint(saved?.secretSet)}
                  value={draft.secret}
                />
                <FieldDescription>
                  {fillNodes(t("signingSecretHint"), { header: <Code>{SIGNATURE_HEADER}</Code> })}
                </FieldDescription>
                {error("secret")}
              </Field>
              {/* Outside the Field: a second control inside it would take the field's label. */}
              {sameType && saved?.secretSet ? (
                <Label className="self-start" variant="option">
                  <Checkbox
                    checked={draft.clearSecret}
                    onCheckedChange={(checked) =>
                      update({ clearSecret: checked === true, secret: "" })
                    }
                  />
                  {t("removeSecret")}
                </Label>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={`${id}-enabled`}>{t("enabled")}</Label>
            <Switch
              checked={draft.enabled}
              id={`${id}-enabled`}
              onCheckedChange={(enabled) => update({ enabled })}
            />
          </div>
          {/* Over the buttons; Try again saves the form again. */}
          {saveError != null ? (
            <FooterSaveError error={saveError} onDismiss={onDismissError} saveRef={saveRef} />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <DialogSaveButton ref={saveRef} saved={done} saving={saving} />
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
