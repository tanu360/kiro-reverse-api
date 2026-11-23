import {
  CircleCheckIcon,
  CircleSlashIcon,
  ClipboardPasteIcon,
  Delete02Icon,
  InformationCircleIcon,
  PencilEdit01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useMemo, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { PasswordInput } from "@/components/shared/password-input";
import { SettingsRow } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { proxyPoolQuery } from "@/lib/api/proxy-pool";
import { queryKeys } from "@/lib/api/query-keys";
import { proxyQuery, updateProxyConfig } from "@/lib/api/settings";
import type { ProxyConfig } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { digitsOnly } from "@/lib/input-filters";
import {
  applyHostInput,
  buildProxyUrl,
  isValidProxyPort,
  PROXY_HOST_PROBLEM_KEYS,
  type ProxyModel,
  parseProxyUrl,
  proxyHostProblem,
  schemeForType,
} from "../lib/proxy-url";
import { SECTION_ID } from "./sections";
import {
  DialogSaveButton,
  FooterSaveError,
  fillNodes,
  RowActionError,
  SectionQuery,
  SettingsGroup,
  useSavedThenClose,
  useSectionSave,
} from "./settings-section";

/** What the editor offers: SOCKS5, or HTTP CONNECT spoken in plain HTTP or over TLS. */
type ProxyKind = "socks5" | "http" | "https";

const KINDS: readonly { value: ProxyKind; labelKey: string; hint: string }[] = [
  { value: "socks5", labelKey: "proxySocks5", hint: "proxySocks5Hint" },
  { value: "http", labelKey: "proxyHttp", hint: "proxyHttpHint" },
  { value: "https", labelKey: "proxyHttps", hint: "proxyProtocolHint" },
];

function kindOf(model: ProxyModel): ProxyKind {
  if (model.type === "socks5") return "socks5";
  return model.scheme === "https" ? "https" : "http";
}

/** Keeps socks5h when SOCKS5 is picked again; HTTP and HTTPS set the scheme outright. */
function withKind(model: ProxyModel, kind: ProxyKind): ProxyModel {
  if (kind === "socks5") {
    return { ...model, type: "socks5", scheme: schemeForType("socks5", model.scheme) };
  }
  return { ...model, type: "http", scheme: kind };
}

const PASTE_EXAMPLE = "socks5://user:pass@host:1080";
/**
 * The longest host name DNS allows. Checked, not a maxLength: the Host field also takes a pasted
 * full URL, which the browser would cut before parseProxyUrl sees it.
 */
const HOST_MAX = 253;

/** `host:port`, an IPv6 host in brackets. */
function address(model: ProxyModel): string {
  const host = model.host.includes(":") ? `[${model.host}]` : model.host;
  return model.port ? `${host}:${model.port}` : host;
}

export function OutboundProxyCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(proxyQuery());
  return (
    <SectionQuery id={SECTION_ID.outboundProxy} query={query} title={t("proxySettings")}>
      {(config) => <OutboundProxyPanel config={config} />}
    </SectionQuery>
  );
}

/**
 * The saved route as one settings row (Direct, or the proxy's address and sign-in) with its
 * actions; the form lives in a dialog. A proxy change applies at once on the server, so the
 * dialog's Save sends it straight away, and Remove asks first.
 */
function OutboundProxyPanel({ config }: { config: ProxyConfig }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const server = useMemo(() => parseProxyUrl(config.proxyURL ?? ""), [config.proxyURL]);
  const direct = server.type === "none";
  // With the pool on, Kiro traffic of accounts without their own proxy goes through the pool,
  // not this route: say so, or "Direct" reads as this server's IP talking to Kiro.
  const poolOn = useQuery(proxyPoolQuery()).data?.mode === "on";
  // `session` remounts the form on each open, so it starts from the saved proxy.
  const [editor, setEditor] = useState({ open: false, session: 0 });
  const editRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  // The dialog's Save reads "Saved", then the dialog closes on the new route; Remove changes
  // the row. A failure shows in the dialog, or under the row for Remove.
  const savedClose = useSavedThenClose(() => setEditor((prev) => ({ ...prev, open: false })));
  const { save, saving, feedback } = useSectionSave(
    (proxyURL: string) => updateProxyConfig({ proxyURL }),
    {
      onSaved: (proxyURL) => {
        queryClient.setQueryData(queryKeys.settings.proxy(), { proxyURL });
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.proxy() });
        if (proxyURL !== "") savedClose.done();
        // Remove goes with the route: focus moves on to Set up, not to the page.
        else editRef.current?.focus();
      },
    },
  );
  // Remove sends "" (the form never does): its failure shows under the row, not in the dialog.
  const [removing, setRemoving] = useState(false);
  const send = (proxyURL: string) => {
    setRemoving(proxyURL === "");
    save(proxyURL);
  };
  // A save still on its way keeps its state (Save or Remove stays busy), even with the dialog
  // closed: only a failure is cleared.
  const openEditor = () => {
    if (!saving) feedback.dismiss();
    savedClose.reset();
    setEditor((prev) => ({ open: true, session: prev.session + 1 }));
  };
  const closeEditor = () => {
    if (!removing && !saving) feedback.dismiss();
    setEditor((prev) => ({ ...prev, open: false }));
  };

  const onRemove = async () => {
    const confirmed = await confirm({
      title: t("proxyRemoveTitle"),
      description: t("proxyRemoveBody"),
      confirmLabel: t("proxyRemove"),
      variant: "danger",
    });
    if (confirmed) send("");
  };

  const kind = KINDS.find((item) => item.value === kindOf(server)) ?? KINDS[0];
  const status = direct ? (
    <Badge icon={CircleSlashIcon} size="sm" tone="neutral">
      {t("proxyStatusDirect")}
    </Badge>
  ) : (
    <Badge icon={CircleCheckIcon} size="sm" tone="success">
      {t("proxyStatusVia", { type: t(kind.labelKey) })}
    </Badge>
  );
  const user = server.username.trim();

  return (
    <SettingsGroup
      badge={status}
      description={poolOn ? t("proxyHintPoolOn") : t("proxyHint")}
      id={SECTION_ID.outboundProxy}
      title={t("proxySettings")}
    >
      <SettingsRow
        control={
          // A group named by the row: the route, then its actions. Under the route on a narrow
          // row, so a long host keeps the row's width; at the row's end on a wide one.
          <fieldset className="flex min-w-0 flex-wrap items-center gap-2 @xl/settings-row:justify-end">
            <Button onClick={openEditor} ref={editRef} size="sm" variant="secondary">
              <HugeiconsIcon icon={direct ? PlusSignIcon : PencilEdit01Icon} aria-hidden="true" />
              {direct ? t("proxySetUp") : t("common:actions.edit")}
            </Button>
            {direct ? null : (
              <Button
                aria-label={t("proxyRemove")}
                loading={saving && removing}
                onClick={() => void onRemove()}
                ref={removeRef}
                size="sm"
                variant="danger"
              >
                <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
                {t("remove")}
              </Button>
            )}
          </fieldset>
        }
        controlWidth="actions"
        description={
          direct ? t("proxyNoneHint") : user ? t("proxyAuthAs", { user }) : t("proxyAuthNone")
        }
        notice={
          // Try again removes at once: the removal was already confirmed. A route already gone
          // (removed in another tab) leaves nothing to remove.
          removing && feedback.error != null && !direct ? (
            <RowActionError
              error={feedback.error}
              focusTarget={removeRef}
              onDismiss={feedback.dismiss}
              onRetry={() => send("")}
            />
          ) : null
        }
        title={
          direct ? (
            t("proxyDirectTitle")
          ) : (
            // A long host wraps at its dots and colon first, mid-label only when it must.
            <span className="wrap-anywhere font-mono text-meta" translate="no">
              {address(server)}
            </span>
          )
        }
      />

      <Dialog
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editor.open}
      >
        <ProxyEditor
          error={removing ? null : feedback.error}
          initial={server}
          key={editor.session}
          onDismissError={feedback.dismiss}
          onSave={send}
          saved={savedClose.saved}
          saving={saving && !removing}
        />
      </Dialog>
    </SettingsGroup>
  );
}

/**
 * The proxy form: type, host and port on one line, the optional sign-in under them and the URL
 * it saves. A full proxy URL pasted into Host fills every field.
 */
function ProxyEditor({
  initial,
  saving,
  saved,
  error,
  onSave,
  onDismissError,
}: {
  initial: ProxyModel;
  saving: boolean;
  /** Saved: Save reads "Saved" while the dialog closes. */
  saved: boolean;
  /** The server's refusal of the last Save, over the buttons until the form changes. */
  error: unknown;
  onSave: (proxyURL: string) => void;
  onDismissError: () => void;
}): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  const isNew = initial.type === "none";
  const [model, setModel] = useState<ProxyModel>(() =>
    isNew ? { ...initial, type: "socks5", scheme: "socks5" } : initial,
  );
  const [addressError, setAddressError] = useState(false);
  const update = (next: ProxyModel) => {
    setAddressError(false);
    if (error != null) onDismissError();
    setModel(next);
  };

  /** A full proxy URL fills the fields it carries; anything else is the host as typed. */
  const onHostChange = (value: string) => update(applyHostInput(model, value));

  const kind = kindOf(model);
  const kindHint = KINDS.find((item) => item.value === kind)?.hint ?? "proxySocks5Hint";
  // The server's checks (proxy-url.ts): a host without a port or a space, a port in range.
  const hostProblem =
    model.host.trim().length > HOST_MAX ? "invalid" : proxyHostProblem(model.host);
  const portValid = isValidProxyPort(model.port.trim());
  const hostInvalid = addressError && hostProblem !== null;
  const portInvalid = addressError && !portValid;
  const tipId = `${id}-address-tip`;

  return (
    <DialogPopup size="xl">
      <form
        className="flex min-h-0 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (saving || saved) return;
          if (hostProblem !== null || !portValid) {
            setAddressError(true);
            return;
          }
          onSave(buildProxyUrl(model));
        }}
      >
        <DialogHeader>
          <DialogTitle>{isNew ? t("proxySetUp") : t("proxyEdit")}</DialogTitle>
          <DialogDescription>{t("proxyApplyNote")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          {/* Type, host and port on one line from sm up; stacked on phones. Each field's error
              sits under it. */}
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)_6rem] sm:gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <Label id={`${id}-type`}>{t("proxyType")}</Label>
              <Select
                items={KINDS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
                onValueChange={(next) => {
                  if (next) update(withKind(model, next as ProxyKind));
                }}
                value={kind}
              >
                <SelectTrigger aria-labelledby={`${id}-type`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {KINDS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {t(item.labelKey)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Field className="min-w-0 items-stretch" invalid={hostInvalid}>
              <FieldLabel>{t("proxyHost")}</FieldLabel>
              <Input
                aria-describedby={tipId}
                autoComplete="off"
                onChange={(event) => onHostChange(event.target.value)}
                placeholder={t("proxyHostPlaceholder")}
                spellCheck={false}
                value={model.host}
              />
              {hostInvalid && hostProblem ? (
                <FieldError match>{t(PROXY_HOST_PROBLEM_KEYS[hostProblem])}</FieldError>
              ) : null}
            </Field>
            <Field className="min-w-0 items-stretch" invalid={portInvalid}>
              <FieldLabel>{t("proxyPort")}</FieldLabel>
              <Input
                autoComplete="off"
                inputMode="numeric"
                maxLength={5}
                onChange={(event) => update({ ...model, port: digitsOnly(event.target.value, 5) })}
                placeholder={t("proxyPortPlaceholder")}
                value={model.port}
              />
              {portInvalid ? <FieldError match>{t("proxyPortInvalid")}</FieldError> : null}
            </Field>
          </div>

          <Fieldset className="flex min-w-0 flex-col gap-3">
            <FieldsetLegend className="flex items-center gap-2">
              {t("proxyAuth")}
              <Badge size="sm" tone="neutral">
                {t("proxyOptional")}
              </Badge>
            </FieldsetLegend>
            <div className="grid gap-4 sm:grid-cols-2 sm:gap-3">
              <Field className="min-w-0 items-stretch">
                <FieldLabel>{t("proxyUsername")}</FieldLabel>
                <Input
                  maxLength={255}
                  autoComplete="off"
                  onChange={(event) => update({ ...model, username: event.target.value })}
                  spellCheck={false}
                  value={model.username}
                />
              </Field>
              <Field className="min-w-0 items-stretch">
                <FieldLabel>{t("proxyPassword")}</FieldLabel>
                <PasswordInput
                  maxLength={255}
                  autoComplete="new-password"
                  onChange={(password) => update({ ...model, password })}
                  value={model.password}
                />
              </Field>
            </div>
          </Fieldset>

          {/* Notes under the form: what the chosen type does, and the paste shortcut. */}
          <ul className="flex flex-col gap-2 text-muted-foreground text-xs leading-normal">
            <li className="flex gap-2">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0"
              />
              <span className="text-pretty">{t(kindHint)}</span>
            </li>
            <li className="flex gap-2" id={tipId}>
              <HugeiconsIcon
                icon={ClipboardPasteIcon}
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0"
              />
              <span className="text-pretty">
                {fillNodes(t("proxyPasteTip"), { example: <Code>{PASTE_EXAMPLE}</Code> })}
              </span>
            </li>
          </ul>
          {/* Over the buttons; Try again saves the form again. */}
          {error != null ? (
            <FooterSaveError error={error} onDismiss={onDismissError} saveRef={saveRef} />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <DialogSaveButton ref={saveRef} saved={saved} saving={saving} />
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
