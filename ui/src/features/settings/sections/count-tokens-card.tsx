import {
  CircleCheckIcon,
  CircleSlashIcon,
  Delete02Icon,
  FloppyDiskIcon,
  PencilEdit01Icon,
  PlusSignIcon,
  SentIcon,
  Timer02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { PasswordInput } from "@/components/shared/password-input";
import { SettingsRow } from "@/components/shared/settings-rows";
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
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type CountTokensAuthType,
  type CountTokensConfig,
  type CountTokensConfigUpdate,
  countTokensQuery,
  updateCountTokensConfig,
} from "@/lib/api/count-tokens";
import { queryKeys } from "@/lib/api/query-keys";
import { useT } from "@/lib/i18n";
import { maskCountTokensKey, validCountTokensUrl } from "../lib/count-tokens";
import { SECTION_ID } from "./sections";
import { SectionQuery, SettingsGroup, useSectionSave } from "./settings-section";

/** The header each mode sends: protocol names, the same in every language. */
const AUTH_HEADERS: Readonly<Record<CountTokensAuthType, string>> = {
  "x-api-key": "x-api-key",
  bearer: "Authorization: Bearer",
};
const AUTH_TYPES: readonly CountTokensAuthType[] = ["x-api-key", "bearer"];

const LOCAL: CountTokensConfig = {
  countTokensApiUrl: "",
  countTokensAuthType: "x-api-key",
  countTokensApiKeySet: false,
  countTokensApiKeyMasked: "",
};

/** What the server will answer after `body` is saved over `prev` (apiUpdateCountTokens). */
function applyUpdate(prev: CountTokensConfig, body: CountTokensConfigUpdate): CountTokensConfig {
  const url = body.countTokensApiUrl ?? prev.countTokensApiUrl;
  if (!url) return LOCAL;
  const key = body.countTokensApiKey ?? "";
  const keySet = key ? true : body.clearApiKey ? false : prev.countTokensApiKeySet;
  return {
    countTokensApiUrl: url,
    countTokensAuthType: body.countTokensAuthType ?? prev.countTokensAuthType,
    countTokensApiKeySet: keySet,
    countTokensApiKeyMasked: key
      ? maskCountTokensKey(key)
      : keySet
        ? prev.countTokensApiKeyMasked
        : "",
  };
}

export function CountTokensCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(countTokensQuery());
  return (
    <SectionQuery id={SECTION_ID.countTokens} query={query} title={t("countTokens.title")}>
      {(config) => <CountTokensPanel config={config} />}
    </SectionQuery>
  );
}

/**
 * Where count_tokens gets its answer, as one settings row: the local estimate, or the external
 * API's URL and how its key is sent. The form lives in a dialog whose Save applies at once;
 * Remove asks first.
 */
function CountTokensPanel({ config }: { config: CountTokensConfig }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const external = config.countTokensApiUrl !== "";
  // `session` remounts the form on each open, so it starts from the saved settings.
  const [editor, setEditor] = useState({ open: false, session: 0 });
  const closeEditor = () => setEditor((prev) => ({ ...prev, open: false }));

  const { save, saving } = useSectionSave(
    (body: CountTokensConfigUpdate) => updateCountTokensConfig(body),
    {
      onSaved: (body) => {
        queryClient.setQueryData<CountTokensConfig>(queryKeys.settings.countTokens(), (prev) =>
          applyUpdate(prev ?? LOCAL, body),
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.countTokens() });
        closeEditor();
      },
    },
  );

  const onRemove = async () => {
    const confirmed = await confirm({
      title: t("countTokens.removeTitle"),
      description: t("countTokens.removeBody"),
      confirmLabel: t("countTokens.remove"),
      variant: "danger",
    });
    if (confirmed) save({ countTokensApiUrl: "" });
  };

  const status = external ? (
    <Badge icon={CircleCheckIcon} size="sm" tone="success">
      {t("countTokens.statusExternal")}
    </Badge>
  ) : (
    <Badge icon={CircleSlashIcon} size="sm" tone="neutral">
      {t("countTokens.statusLocal")}
    </Badge>
  );

  let description = t("countTokens.localHint");
  if (external) {
    description = config.countTokensApiKeySet
      ? t("countTokens.authAs", {
          header: AUTH_HEADERS[config.countTokensAuthType],
          key: config.countTokensApiKeyMasked,
        })
      : t("countTokens.noKey");
  }

  return (
    <SettingsGroup
      badge={status}
      description={t("countTokens.hint")}
      id={SECTION_ID.countTokens}
      title={t("countTokens.title")}
    >
      <SettingsRow
        control={
          // The row's actions: under the URL on a narrow row, at the row's end on a wide one.
          <fieldset className="flex min-w-0 flex-wrap items-center gap-2 @xl/settings-row:justify-end">
            <Button
              onClick={() => setEditor((prev) => ({ open: true, session: prev.session + 1 }))}
              size="sm"
              variant="secondary"
            >
              <HugeiconsIcon icon={external ? PencilEdit01Icon : PlusSignIcon} aria-hidden="true" />
              {external ? t("common:actions.edit") : t("countTokens.setUp")}
            </Button>
            {external ? (
              <Button
                aria-label={t("countTokens.remove")}
                loading={saving}
                onClick={() => void onRemove()}
                size="sm"
                variant="danger"
              >
                <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
                {t("remove")}
              </Button>
            ) : null}
          </fieldset>
        }
        controlWidth="actions"
        description={description}
        title={
          external ? (
            // A long URL wraps at its slashes and dots first, mid-word only when it must.
            <span className="wrap-anywhere font-mono text-meta" translate="no">
              {config.countTokensApiUrl}
            </span>
          ) : (
            t("countTokens.localTitle")
          )
        }
      />

      <Dialog
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editor.open}
      >
        <CountTokensEditor initial={config} key={editor.session} onSave={save} saving={saving} />
      </Dialog>
    </SettingsGroup>
  );
}

/**
 * The form: the API URL, how the key is sent and the key itself. The saved key never comes back
 * from the server, so the key field starts empty: blank keeps the saved key, and a checkbox
 * removes it.
 */
function CountTokensEditor({
  initial,
  saving,
  onSave,
}: {
  initial: CountTokensConfig;
  saving: boolean;
  onSave: (body: CountTokensConfigUpdate) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  const isNew = initial.countTokensApiUrl === "";
  const savedKey = !isNew && initial.countTokensApiKeySet;
  const [url, setUrl] = useState(initial.countTokensApiUrl);
  const [authType, setAuthType] = useState<CountTokensAuthType>(initial.countTokensAuthType);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [urlError, setUrlError] = useState(false);

  return (
    <DialogPopup size="xl">
      <form
        className="flex min-h-0 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const trimmed = url.trim();
          if (!validCountTokensUrl(trimmed)) {
            setUrlError(true);
            return;
          }
          const body: CountTokensConfigUpdate = {
            countTokensApiUrl: trimmed,
            countTokensAuthType: authType,
          };
          if (clearKey) body.clearApiKey = true;
          else if (key.trim()) body.countTokensApiKey = key.trim();
          onSave(body);
        }}
      >
        <DialogHeader>
          <DialogTitle>{isNew ? t("countTokens.setUp") : t("countTokens.edit")}</DialogTitle>
          <DialogDescription>{t("countTokens.applyNote")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <Field className="min-w-0 items-stretch" invalid={urlError}>
            <FieldLabel>{t("countTokens.url")}</FieldLabel>
            <Input
              autoComplete="off"
              inputMode="url"
              onChange={(event) => {
                setUrlError(false);
                setUrl(event.target.value);
              }}
              placeholder={t("countTokens.urlPlaceholder")}
              spellCheck={false}
              translate="no"
              value={url}
            />
            {urlError ? <FieldError match>{t("countTokens.urlInvalid")}</FieldError> : null}
          </Field>

          {/* The header and the key side by side from sm up; stacked on phones. */}
          <div className="grid gap-4 sm:grid-cols-2 sm:gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <Label id={`${id}-auth`}>{t("countTokens.authType")}</Label>
              <Select
                items={AUTH_TYPES.map((value) => ({ value, label: AUTH_HEADERS[value] }))}
                onValueChange={(next) => {
                  if (next) setAuthType(next as CountTokensAuthType);
                }}
                value={authType}
              >
                <SelectTrigger aria-labelledby={`${id}-auth`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {AUTH_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      <span translate="no">{AUTH_HEADERS[value]}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Field className="min-w-0 items-stretch" disabled={clearKey}>
              <FieldLabel>{t("countTokens.apiKey")}</FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                disabled={clearKey}
                onChange={setKey}
                value={clearKey ? "" : key}
              />
              <FieldDescription>
                {savedKey
                  ? t("countTokens.apiKeyKeep", { key: initial.countTokensApiKeyMasked })
                  : t("countTokens.optional")}
              </FieldDescription>
            </Field>
          </div>

          {savedKey ? (
            <Label className="self-start" variant="option">
              <Checkbox
                checked={clearKey}
                onCheckedChange={(checked) => setClearKey(checked === true)}
              />
              {t("countTokens.apiKeyClear")}
            </Label>
          ) : null}

          {/* Notes under the form: when the local estimate takes over, and what is sent. */}
          <ul className="flex flex-col gap-2 text-muted-foreground text-xs leading-normal">
            <li className="flex gap-2">
              <HugeiconsIcon
                icon={Timer02Icon}
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0"
              />
              <span className="text-pretty">{t("countTokens.fallbackNote")}</span>
            </li>
            <li className="flex gap-2">
              <HugeiconsIcon
                icon={SentIcon}
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0"
              />
              <span className="text-pretty">{t("countTokens.forwardNote")}</span>
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
