import {
  CircleCheckIcon,
  CircleSlashIcon,
  ClipboardPasteIcon,
  Delete02Icon,
  FloppyDiskIcon,
  InformationCircleIcon,
  PencilEdit01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useMemo, useState } from "react";
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
import { queryKeys } from "@/lib/api/query-keys";
import { proxyQuery, updateProxyConfig } from "@/lib/api/settings";
import type { ProxyConfig } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { buildProxyUrl, type ProxyModel, parseProxyUrl, schemeForType } from "../lib/proxy-url";
import { SECTION_ID } from "./sections";
import { fillNodes, SectionQuery, SettingsGroup, useSectionSave } from "./settings-section";

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

function validPort(port: string): boolean {
  const value = Number(port);
  return /^\d+$/.test(port) && value >= 1 && value <= 65535;
}

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
  // `session` remounts the form on each open, so it starts from the saved proxy.
  const [editor, setEditor] = useState({ open: false, session: 0 });
  const closeEditor = () => setEditor((prev) => ({ ...prev, open: false }));

  const { save, saving } = useSectionSave((proxyURL: string) => updateProxyConfig({ proxyURL }), {
    onSaved: (proxyURL) => {
      queryClient.setQueryData(queryKeys.settings.proxy(), { proxyURL });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.proxy() });
      closeEditor();
    },
  });

  const onRemove = async () => {
    const confirmed = await confirm({
      title: t("proxyRemoveTitle"),
      description: t("proxyRemoveBody"),
      confirmLabel: t("proxyRemove"),
      variant: "danger",
    });
    if (confirmed) save("");
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
      description={t("proxyHint")}
      id={SECTION_ID.outboundProxy}
      title={t("proxySettings")}
    >
      <SettingsRow
        control={
          // A group named by the row: the route, then its actions.
          <fieldset className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              onClick={() => setEditor((prev) => ({ open: true, session: prev.session + 1 }))}
              size="sm"
              variant="outline"
            >
              <HugeiconsIcon icon={direct ? PlusSignIcon : PencilEdit01Icon} aria-hidden="true" />
              {direct ? t("proxySetUp") : t("common:actions.edit")}
            </Button>
            {direct ? null : (
              <Button
                aria-label={t("proxyRemove")}
                loading={saving}
                onClick={() => void onRemove()}
                size="sm"
                variant="danger"
              >
                <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
                {t("remove")}
              </Button>
            )}
          </fieldset>
        }
        controlWidth="auto"
        description={
          direct ? t("proxyNoneHint") : user ? t("proxyAuthAs", { user }) : t("proxyAuthNone")
        }
        title={
          direct ? (
            t("proxyDirectTitle")
          ) : (
            // A long host wraps instead of pushing the actions off the row.
            <span className="break-all" translate="no">
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
        <ProxyEditor initial={server} key={editor.session} onSave={save} saving={saving} />
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
  onSave,
}: {
  initial: ProxyModel;
  saving: boolean;
  onSave: (proxyURL: string) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  const isNew = initial.type === "none";
  const [model, setModel] = useState<ProxyModel>(() =>
    isNew ? { ...initial, type: "socks5", scheme: "socks5" } : initial,
  );
  const [addressError, setAddressError] = useState(false);
  const update = (next: ProxyModel) => {
    setAddressError(false);
    setModel(next);
  };

  /** A pasted full proxy URL fills every field; anything else is the host as typed. */
  const onHostChange = (value: string) => {
    if (value.includes("://")) {
      const parsed = parseProxyUrl(value);
      if (parsed.type !== "none") {
        update(parsed);
        return;
      }
    }
    update({ ...model, host: value });
  };

  const kind = kindOf(model);
  const kindHint = KINDS.find((item) => item.value === kind)?.hint ?? "proxySocks5Hint";
  const hostInvalid = addressError && !model.host.trim();
  const portInvalid = addressError && !validPort(model.port.trim());
  const tipId = `${id}-address-tip`;

  return (
    <DialogPopup size="xl">
      <form
        className="flex min-h-0 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!model.host.trim() || !validPort(model.port.trim())) {
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
              {hostInvalid ? <FieldError match>{t("proxyHostRequired")}</FieldError> : null}
            </Field>
            <Field className="min-w-0 items-stretch" invalid={portInvalid}>
              <FieldLabel>{t("proxyPort")}</FieldLabel>
              <Input
                autoComplete="off"
                inputMode="numeric"
                maxLength={5}
                onChange={(event) =>
                  update({ ...model, port: event.target.value.replace(/\D/g, "") })
                }
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
                  autoComplete="off"
                  onChange={(event) => update({ ...model, username: event.target.value })}
                  spellCheck={false}
                  value={model.username}
                />
              </Field>
              <Field className="min-w-0 items-stretch">
                <FieldLabel>{t("proxyPassword")}</FieldLabel>
                <PasswordInput
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
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <Button loading={saving} loadingText={t("common:actions.saving")} type="submit">
            <HugeiconsIcon icon={FloppyDiskIcon} aria-hidden="true" />
            {t("common:actions.save")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
