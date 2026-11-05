import { AiMagicIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, type ReactNode, useId } from "react";
import { AmazonQLogo, AwsLogo, KiroLogo } from "@/components/shared/brand-logos";
import { Label } from "@/components/ui/label";
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
import {
  ROW_DESCRIPTION,
  SaveFooter,
  SectionQuery,
  SettingsRow,
  SettingsSection,
  SwitchField,
  useSectionSave,
} from "./settings-section";

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
  kiro: <KiroLogo className="rounded-[3px]" />,
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

function EndpointForm({ config }: { config: EndpointConfig }): JSX.Element {
  const { t } = useT("settings");
  const selectId = useId();
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

  const items = (Object.keys(ENDPOINT_LABEL_KEYS) as PreferredEndpoint[]).map((value) => ({
    value,
    label: t(ENDPOINT_LABEL_KEYS[value]),
  }));

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
      rows
      title={t("endpointSettings")}
    >
      {/* A settings row like a switch's: name and hint on the left, the select at the end. */}
      <SettingsRow className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <Label id={`${selectId}-label`}>{t("preferredEndpoint")}</Label>
          <p className={ROW_DESCRIPTION} id={`${selectId}-hint`}>
            {t("endpointHint")}
          </p>
        </div>
        <Select
          items={items}
          onValueChange={(value) => {
            if (value) {
              draft.set((prev) => ({ ...prev, preferredEndpoint: value as PreferredEndpoint }));
            }
          }}
          value={draft.value.preferredEndpoint}
        >
          <SelectTrigger
            aria-describedby={`${selectId}-hint`}
            aria-labelledby={`${selectId}-label`}
            className="w-full sm:w-72"
          >
            <SelectValue className="flex min-w-0 items-center gap-2">
              {(value: PreferredEndpoint) => (
                <>
                  {ENDPOINT_ICONS[value]}
                  <span className="truncate">{t(ENDPOINT_LABEL_KEYS[value])}</span>
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
      </SettingsRow>
      <SettingsRow>
        <SwitchField
          checked={draft.value.endpointFallback}
          hint={t("endpointFallbackHint")}
          label={t("endpointFallback")}
          onCheckedChange={(endpointFallback) =>
            draft.set((prev) => ({ ...prev, endpointFallback }))
          }
        />
      </SettingsRow>
    </SettingsSection>
  );
}
