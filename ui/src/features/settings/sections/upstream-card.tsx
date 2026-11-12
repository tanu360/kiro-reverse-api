import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, type ReactNode, useId, useState } from "react";
import { AwsLogo, KiroLogo } from "@/components/shared/brand-logos";
import { Code } from "@/components/shared/code";
import { ROW_DESCRIPTION, SettingsRow } from "@/components/shared/settings-rows";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/api/query-keys";
import { updateUpstreamConfig, upstreamQuery } from "@/lib/api/settings";
import type { ApiDomain, UpstreamConfig } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { SECTION_ID } from "./sections";
import {
  FieldControl,
  fillNodes,
  SaveFooter,
  SectionQuery,
  SettingsSection,
  useSectionSave,
} from "./settings-section";

/** The API region select's value for "no override"; sent as ''. */
const AUTO_REGION = "auto";

/** config.NormalizeAWSRegion's pattern: the region ends up in the OIDC hostname. */
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/;

const DOMAIN_LABEL_KEYS: Record<ApiDomain, string> = {
  amazonaws: "upstream.domainAmazonaws",
  kiro: "upstream.domainKiro",
};

/** The AWS wordmark is pinned to the text colour, as in the endpoint card. */
const DOMAIN_ICONS: Record<ApiDomain, ReactNode> = {
  amazonaws: <AwsLogo className="text-foreground" />,
  kiro: <KiroLogo />,
};

interface UpstreamDraft {
  apiDomain: ApiDomain;
  /** AUTO_REGION or one of apiRegions */
  apiRegion: string;
  /** as typed; '' = each account's own region */
  authRegion: string;
}

function toDraft(config: Pick<UpstreamConfig, "apiDomain" | "apiRegion" | "authRegion">) {
  return {
    apiDomain: config.apiDomain === "kiro" ? "kiro" : "amazonaws",
    apiRegion: config.apiRegion || AUTO_REGION,
    authRegion: config.authRegion ?? "",
  } satisfies UpstreamDraft;
}

/** The chat host the settings lead to; `<region>` when each account keeps its own. */
function effectiveHost(domain: ApiDomain, region: string): string {
  const shown = region === AUTO_REGION ? "<region>" : region;
  return domain === "kiro" ? `runtime.${shown}.kiro.dev` : `q.${shown}.amazonaws.com`;
}

export function UpstreamCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(upstreamQuery());
  return (
    <SectionQuery id={SECTION_ID.upstream} query={query} title={t("upstream.title")}>
      {(config) => <UpstreamForm config={config} />}
    </SectionQuery>
  );
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/** The domain select, each option with its mark; the row's label and hint go to the trigger. */
function DomainSelect({
  value,
  onChange,
  ...aria
}: AriaProps & { value: ApiDomain; onChange: (value: ApiDomain) => void }): JSX.Element {
  const { t } = useT("settings");
  const items = (Object.keys(DOMAIN_LABEL_KEYS) as ApiDomain[]).map((domain) => ({
    value: domain,
    label: t(DOMAIN_LABEL_KEYS[domain]),
  }));
  return (
    <Select
      items={items}
      onValueChange={(next) => {
        if (next) onChange(next as ApiDomain);
      }}
      value={value}
    >
      <SelectTrigger {...aria}>
        <SelectValue className="flex min-w-0 items-center gap-2">
          {(domain: ApiDomain) => (
            <>
              {DOMAIN_ICONS[domain]}
              <span className="truncate">{t(DOMAIN_LABEL_KEYS[domain])}</span>
            </>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {DOMAIN_ICONS[item.value]}
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Automatic plus the regions the server accepts. */
function RegionSelect({
  value,
  regions,
  onChange,
  ...aria
}: AriaProps & {
  value: string;
  regions: readonly string[];
  onChange: (value: string) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const items = [
    { value: AUTO_REGION, label: t("upstream.regionAuto") },
    ...regions.map((region) => ({ value: region, label: region })),
  ];
  return (
    <Select
      items={items}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      value={value}
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

function UpstreamForm({ config }: { config: UpstreamConfig }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const authRegionId = useId();
  const draft = useDraft<UpstreamDraft>(toDraft(config));
  const [authError, setAuthError] = useState<string | null>(null);
  const regions = config.apiRegions ?? [];
  const { save, saving } = useSectionSave(updateUpstreamConfig, {
    onSaved: (sent) => {
      const saved = { ...config, ...sent } as UpstreamConfig;
      draft.commit(toDraft(saved));
      queryClient.setQueryData(queryKeys.settings.upstream(), saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.upstream() });
    },
  });

  const onSubmit = () => {
    const authRegion = draft.value.authRegion.trim().toLowerCase();
    if (authRegion !== "" && !AWS_REGION.test(authRegion)) {
      setAuthError(t("upstream.authRegionInvalid"));
      return;
    }
    // Every field is sent, so the saved copy is exactly what the form shows.
    save({
      apiDomain: draft.value.apiDomain,
      apiRegion: draft.value.apiRegion === AUTO_REGION ? "" : draft.value.apiRegion,
      authRegion,
    });
  };

  const host = effectiveHost(draft.value.apiDomain, draft.value.apiRegion);
  return (
    <SettingsSection
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={() => {
            setAuthError(null);
            draft.reload();
          }}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      hint={t("upstream.hint")}
      id={SECTION_ID.upstream}
      onSubmit={onSubmit}
      title={t("upstream.title")}
    >
      <SettingsRow
        control={
          <DomainSelect
            onChange={(apiDomain) => draft.set((prev) => ({ ...prev, apiDomain }))}
            value={draft.value.apiDomain}
          />
        }
        description={t("upstream.domainHint")}
        title={t("upstream.domain")}
      >
        <p className={ROW_DESCRIPTION}>
          {fillNodes(
            t(
              draft.value.apiRegion === AUTO_REGION
                ? "upstream.effectiveHostAuto"
                : "upstream.effectiveHost",
            ),
            { host: <Code>{host}</Code> },
          )}
        </p>
      </SettingsRow>
      <SettingsRow
        control={
          <RegionSelect
            onChange={(apiRegion) => draft.set((prev) => ({ ...prev, apiRegion }))}
            regions={regions}
            value={draft.value.apiRegion}
          />
        }
        description={t("upstream.apiRegionHint")}
        title={t("upstream.apiRegion")}
      />
      <SettingsRow
        control={
          <FieldControl error={authError}>
            <Input
              autoComplete="off"
              id={authRegionId}
              onChange={(event) => {
                const authRegion = event.target.value;
                setAuthError(null);
                draft.set((prev) => ({ ...prev, authRegion }));
              }}
              placeholder={t("upstream.authRegionPlaceholder")}
              spellCheck={false}
              value={draft.value.authRegion}
            />
          </FieldControl>
        }
        description={t("upstream.authRegionHint")}
        htmlFor={authRegionId}
        title={t("upstream.authRegion")}
      />
    </SettingsSection>
  );
}
