import {
  ClipboardPasteIcon,
  FloppyDiskIcon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type JSX, useId, useState } from "react";
import { Code } from "@/components/shared/code";
import { PasswordInput } from "@/components/shared/password-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
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
import {
  PROXY_HOST_PROBLEM_KEYS,
  type ProxyModel,
  parseProxyUrl,
  schemeForType,
} from "@/features/settings/lib/proxy-url";
import { addPoolProxy, type PoolProxy, updatePoolProxy } from "@/lib/api/proxy-pool";
import { fillNodes, useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import {
  type EditorModel,
  editorErrors,
  editorModel,
  editorRequest,
  hasErrors,
  MAX_LABEL,
  poolErrorMessage,
} from "./lib/pool-model";

/** What the editor offers: SOCKS5, or HTTP CONNECT spoken in plain HTTP or over TLS. */
type ProxyKind = "socks5" | "http" | "https";

const KINDS: readonly { value: ProxyKind; labelKey: string; hint: string }[] = [
  { value: "socks5", labelKey: "settings:proxySocks5", hint: "settings:proxySocks5Hint" },
  { value: "http", labelKey: "settings:proxyHttp", hint: "settings:proxyHttpHint" },
  { value: "https", labelKey: "settings:proxyHttps", hint: "settings:proxyProtocolHint" },
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
 * Adds a pool proxy, or edits one. The saved password is never shown: on an edit the password
 * field starts empty, an empty field keeps it, and Remove the saved password drops it. A full
 * proxy URL pasted into Host fills every field.
 */
export function ProxyEditor({
  proxy,
  onSaved,
}: {
  proxy?: PoolProxy;
  onSaved: () => void;
}): JSX.Element {
  const { t } = useT("proxy-pool");
  const id = useId();
  const editing = proxy !== undefined;
  const [model, setModel] = useState<EditorModel>(() => editorModel(proxy));
  const [showErrors, setShowErrors] = useState(false);
  const errors = editorErrors(model);
  const update = (proxyModel: ProxyModel) => setModel((prev) => ({ ...prev, proxy: proxyModel }));

  const save = useMutation({
    mutationFn: () => {
      const body = editorRequest(model, editing);
      return proxy ? updatePoolProxy(proxy.id, body) : addPoolProxy(body);
    },
    onSuccess: () => {
      toast.success(editing ? t("editor.saved") : t("editor.added"));
      onSaved();
    },
    onError: (error) => toast.error(poolErrorMessage(error, t)),
  });

  /** A pasted full proxy URL fills every field; anything else is the host as typed. */
  const onHostChange = (value: string) => {
    if (value.includes("://")) {
      const parsed = parseProxyUrl(value);
      if (parsed.type !== "none") {
        update(parsed);
        return;
      }
    }
    update({ ...model.proxy, host: value });
  };

  const kind = kindOf(model.proxy);
  const kindHint = KINDS.find((item) => item.value === kind)?.hint ?? "settings:proxySocks5Hint";
  const tipId = `${id}-address-tip`;
  const hostInvalid = showErrors && errors.host !== null;
  const portInvalid = showErrors && errors.port;
  const labelInvalid = showErrors && errors.label;

  return (
    <DialogPopup size="xl">
      <form
        className="flex min-h-0 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (hasErrors(errors)) {
            setShowErrors(true);
            return;
          }
          save.mutate();
        }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? t("editor.editTitle") : t("editor.addTitle")}</DialogTitle>
          <DialogDescription>{t("editor.description")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <Field className="min-w-0 items-stretch" invalid={labelInvalid}>
            <FieldLabel>
              {t("editor.label")}
              <Badge size="sm" tone="neutral">
                {t("settings:proxyOptional")}
              </Badge>
            </FieldLabel>
            <Input
              autoComplete="off"
              onChange={(event) => setModel((prev) => ({ ...prev, label: event.target.value }))}
              placeholder={t("editor.labelPlaceholder")}
              value={model.label}
            />
            {labelInvalid ? (
              <FieldError match>{t("editor.labelTooLong", { max: MAX_LABEL })}</FieldError>
            ) : null}
          </Field>

          {/* Type, host and port on one line from sm up; stacked on phones. */}
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)_6rem] sm:gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <Label id={`${id}-type`}>{t("settings:proxyType")}</Label>
              <Select
                items={KINDS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
                onValueChange={(next) => {
                  if (next) update(withKind(model.proxy, next as ProxyKind));
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
              <FieldLabel>{t("settings:proxyHost")}</FieldLabel>
              <Input
                aria-describedby={tipId}
                autoComplete="off"
                onChange={(event) => onHostChange(event.target.value)}
                placeholder={t("settings:proxyHostPlaceholder")}
                spellCheck={false}
                value={model.proxy.host}
              />
              {hostInvalid && errors.host ? (
                <FieldError match>{t(PROXY_HOST_PROBLEM_KEYS[errors.host])}</FieldError>
              ) : null}
            </Field>
            <Field className="min-w-0 items-stretch" invalid={portInvalid}>
              <FieldLabel>{t("settings:proxyPort")}</FieldLabel>
              <Input
                autoComplete="off"
                inputMode="numeric"
                maxLength={5}
                onChange={(event) =>
                  update({ ...model.proxy, port: event.target.value.replace(/\D/g, "") })
                }
                placeholder={t("settings:proxyPortPlaceholder")}
                value={model.proxy.port}
              />
              {portInvalid ? <FieldError match>{t("settings:proxyPortInvalid")}</FieldError> : null}
            </Field>
          </div>

          <Fieldset className="flex min-w-0 flex-col gap-3">
            <FieldsetLegend className="flex items-center gap-2">
              {t("settings:proxyAuth")}
              <Badge size="sm" tone="neutral">
                {t("settings:proxyOptional")}
              </Badge>
            </FieldsetLegend>
            <div className="grid gap-4 sm:grid-cols-2 sm:gap-3">
              <Field className="min-w-0 items-stretch">
                <FieldLabel>{t("settings:proxyUsername")}</FieldLabel>
                <Input
                  autoComplete="off"
                  onChange={(event) => update({ ...model.proxy, username: event.target.value })}
                  spellCheck={false}
                  value={model.proxy.username}
                />
              </Field>
              <Field className="min-w-0 items-stretch">
                <FieldLabel>{t("settings:proxyPassword")}</FieldLabel>
                <PasswordInput
                  autoComplete="new-password"
                  disabled={model.clearPassword}
                  onChange={(password) => update({ ...model.proxy, password })}
                  value={model.proxy.password}
                />
                {proxy?.hasPassword ? (
                  <FieldDescription>{t("editor.passwordKeep")}</FieldDescription>
                ) : null}
              </Field>
            </div>
            {proxy?.hasPassword ? (
              <Label className="self-start" variant="option">
                <Checkbox
                  checked={model.clearPassword}
                  onCheckedChange={(checked) =>
                    setModel((prev) => ({
                      ...prev,
                      clearPassword: checked === true,
                      proxy: { ...prev.proxy, password: "" },
                    }))
                  }
                />
                {t("editor.passwordClear")}
              </Label>
            ) : null}
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
                {fillNodes(t("settings:proxyPasteTip"), { example: <Code>{PASTE_EXAMPLE}</Code> })}
              </span>
            </li>
          </ul>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <Button loading={save.isPending} loadingText={t("common:actions.saving")} type="submit">
            <HugeiconsIcon icon={FloppyDiskIcon} aria-hidden="true" />
            {t("common:actions.save")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
