import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "@/components/ui/number-field";
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
import { useDraft } from "../lib/dirty";
import {
  buildProxyUrl,
  type ProxyModel,
  type ProxyType,
  parseProxyUrl,
  schemeForType,
} from "../lib/proxy-url";
import { SECTION_ID } from "./sections";
import {
  FieldErrorText,
  PasswordInput,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  useSectionSave,
} from "./settings-section";

const TYPE_LABEL_KEYS: Record<ProxyType, string> = {
  none: "proxyNone",
  socks5: "proxySocks5",
  http: "proxyHttp",
};

/** Two forms are the same when they send the same URL (hidden fields under Direct do not count). */
function sameProxy(a: ProxyModel, b: ProxyModel): boolean {
  return a.type === b.type && buildProxyUrl(a) === buildProxyUrl(b);
}

export function OutboundProxyCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(proxyQuery());
  return (
    <SectionQuery id={SECTION_ID.outboundProxy} query={query} title={t("proxySettings")}>
      {(config) => <OutboundProxyForm config={config} />}
    </SectionQuery>
  );
}

function OutboundProxyForm({ config }: { config: ProxyConfig }): JSX.Element {
  const { t } = useT("settings");
  const id = useId();
  const queryClient = useQueryClient();
  const server = useMemo(() => parseProxyUrl(config.proxyURL ?? ""), [config.proxyURL]);
  const draft = useDraft(server, sameProxy);
  const [hostError, setHostError] = useState(false);
  const { save, saving } = useSectionSave(
    ({ proxyURL }: { proxyURL: string; model: ProxyModel }) => updateProxyConfig({ proxyURL }),
    {
      onSaved: ({ proxyURL, model }) => {
        draft.commit(model);
        queryClient.setQueryData(queryKeys.settings.proxy(), { proxyURL });
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.proxy() });
      },
    },
  );

  const model = draft.value;
  const update = (patch: Partial<ProxyModel>) => {
    setHostError(false);
    draft.set((prev) => ({ ...prev, ...patch }));
  };

  const onSubmit = () => {
    if (model.type !== "none" && (!model.host.trim() || !model.port.trim())) {
      setHostError(true);
      return;
    }
    save({ proxyURL: buildProxyUrl(model), model });
  };

  const items = (Object.keys(TYPE_LABEL_KEYS) as ProxyType[]).map((value) => ({
    value,
    label: t(TYPE_LABEL_KEYS[value]),
  }));
  const portValue = model.port.trim() === "" ? null : Number(model.port);
  const errorId = `${id}-host-error`;

  return (
    <SettingsSection
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={() => {
            setHostError(false);
            draft.reload();
          }}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      hint={t("proxyHint")}
      id={SECTION_ID.outboundProxy}
      onSubmit={onSubmit}
      title={t("proxySettings")}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label id={`${id}-type-label`}>{t("proxyType")}</Label>
          <Select
            items={items}
            onValueChange={(value) => {
              if (!value) return;
              const type = value as ProxyType;
              update(
                type === "none" ? { type } : { type, scheme: schemeForType(type, model.scheme) },
              );
            }}
            value={model.type}
          >
            <SelectTrigger aria-labelledby={`${id}-type-label`} className="w-full sm:max-w-xs">
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
        </div>

        {model.type !== "none" ? (
          <>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
                <div className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor={`${id}-host`}>{t("proxyHost")}</Label>
                  <Input
                    aria-describedby={hostError ? errorId : undefined}
                    aria-invalid={(hostError && !model.host.trim()) || undefined}
                    autoComplete="off"
                    id={`${id}-host`}
                    onChange={(event) => update({ host: event.target.value })}
                    placeholder={t("proxyHostPlaceholder")}
                    spellCheck={false}
                    value={model.host}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor={`${id}-port`}>{t("proxyPort")}</Label>
                  <NumberField
                    format={{ useGrouping: false, maximumFractionDigits: 0 }}
                    id={`${id}-port`}
                    max={65535}
                    min={1}
                    onValueChange={(value) => update({ port: value === null ? "" : String(value) })}
                    step={1}
                    value={portValue !== null && Number.isFinite(portValue) ? portValue : null}
                  >
                    <NumberFieldGroup>
                      <NumberFieldInput
                        aria-describedby={hostError ? errorId : undefined}
                        aria-invalid={(hostError && !model.port.trim()) || undefined}
                        placeholder={t("proxyPortPlaceholder")}
                      />
                    </NumberFieldGroup>
                  </NumberField>
                </div>
              </div>
              {hostError ? (
                <FieldErrorText id={errorId}>{t("proxyHostRequired")}</FieldErrorText>
              ) : null}
            </div>

            <fieldset className="flex min-w-0 flex-col gap-3">
              <legend className="mb-3 font-medium text-sm">{t("proxyAuth")}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor={`${id}-username`}>{t("proxyUsername")}</Label>
                  <Input
                    autoComplete="off"
                    id={`${id}-username`}
                    onChange={(event) => update({ username: event.target.value })}
                    spellCheck={false}
                    value={model.username}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor={`${id}-password`}>{t("proxyPassword")}</Label>
                  <PasswordInput
                    autoComplete="new-password"
                    id={`${id}-password`}
                    onChange={(password) => update({ password })}
                    value={model.password}
                  />
                </div>
              </div>
            </fieldset>
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}
