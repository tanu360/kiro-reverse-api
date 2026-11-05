import { AiMagicIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { AmazonQLogo, AwsLogo, KiroLogo } from "@/components/shared/brand-logos";
import { SettingsRow, SwitchField } from "@/components/shared/settings-rows";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/api/query-keys";
import { endpointQuery, updateEndpointConfig } from "@/lib/api/settings";
import type { EndpointConfig, PreferredEndpoint } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { SECTION_ID } from "./sections";
import { SaveFooter, SectionQuery, SettingsSection, useSectionSave } from "./settings-section";

const ENDPOINT_LABEL_KEYS: Record<PreferredEndpoint, string> = {
  auto: "endpointAuto",
  kiro: "endpointKiro",
  codewhisperer: "endpointCodeWhisperer",
  amazonq: "endpointAmazonQ",
};

/**
 * Each endpoint's mark, in the menu rows and the trigger. Automatic has no brand, so it takes a
 * muted icon. The AWS wordmark is pinned to the text colour (`text-foreground`): the rows and
 * the trigger otherwise mute an svg, and a picked row turns its text purple.
 */
const ENDPOINT_ICONS: Record<PreferredEndpoint, ReactNode> = {
  auto: <HugeiconsIcon aria-hidden="true" icon={AiMagicIcon} />,
  kiro: <KiroLogo />,
  codewhisperer: <AwsLogo className="text-foreground" />,
  amazonq: <AmazonQLogo />,
};

export function EndpointCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(endpointQuery());
  return (
    <SectionQuery id={SECTION_ID.endpoint} query={query} title={t("endpointSettings")}>
      {(config) => <EndpointForm config={config} />}
    </SectionQuery>
  );
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/**
 * The endpoint select, each option with its mark. The row's label and description (SettingsRow
 * puts them on its control) go to the trigger.
 */
function EndpointSelect({
  value,
  onChange,
  ...aria
}: AriaProps & {
  value: PreferredEndpoint;
  onChange: (value: PreferredEndpoint) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const items = (Object.keys(ENDPOINT_LABEL_KEYS) as PreferredEndpoint[]).map((endpoint) => ({
    value: endpoint,
    label: t(ENDPOINT_LABEL_KEYS[endpoint]),
  }));
  return (
    <Select
      items={items}
      onValueChange={(next) => {
        if (next) onChange(next as PreferredEndpoint);
      }}
      value={value}
    >
      <SelectTrigger {...aria}>
        <SelectValue className="flex min-w-0 items-center gap-2">
          {(endpoint: PreferredEndpoint) => (
            <>
              {ENDPOINT_ICONS[endpoint]}
              <span className="truncate">{t(ENDPOINT_LABEL_KEYS[endpoint])}</span>
            </>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {ENDPOINT_ICONS[item.value]}
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function EndpointForm({ config }: { config: EndpointConfig }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const draft = useDraft<EndpointConfig>({
    preferredEndpoint: config.preferredEndpoint || "auto",
    // Missing means on.
    endpointFallback: config.endpointFallback !== false,
  });
  const { save, saving } = useSectionSave((body: EndpointConfig) => updateEndpointConfig(body), {
    onSaved: (sent) => {
      draft.commit(sent);
      queryClient.setQueryData(queryKeys.settings.endpoint(), sent);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.endpoint() });
    },
  });

  return (
    <SettingsSection
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={draft.reload}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      hint={t("endpointSettingsHint")}
      id={SECTION_ID.endpoint}
      onSubmit={() => save(draft.value)}
      title={t("endpointSettings")}
    >
      <SettingsRow
        control={
          <EndpointSelect
            onChange={(preferredEndpoint) => draft.set((prev) => ({ ...prev, preferredEndpoint }))}
            value={draft.value.preferredEndpoint}
          />
        }
        description={t("endpointHint")}
        title={t("preferredEndpoint")}
      />
      <SwitchField
        checked={draft.value.endpointFallback}
        description={t("endpointFallbackHint")}
        onCheckedChange={(endpointFallback) => draft.set((prev) => ({ ...prev, endpointFallback }))}
        title={t("endpointFallback")}
      />
    </SettingsSection>
  );
}
