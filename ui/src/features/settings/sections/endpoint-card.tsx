import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId } from "react";
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
  DefaultTag,
  SaveFooter,
  SectionQuery,
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
      title={t("endpointSettings")}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label id={`${selectId}-label`}>{t("preferredEndpoint")}</Label>
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
              className="w-full sm:max-w-xs"
            >
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
          <p className="text-muted-foreground text-xs" id={`${selectId}-hint`}>
            {t("endpointHint")}
          </p>
        </div>
        <SwitchField
          checked={draft.value.endpointFallback}
          extra={<DefaultTag on />}
          hint={t("endpointFallbackHint")}
          label={t("endpointFallback")}
          onCheckedChange={(endpointFallback) =>
            draft.set((prev) => ({ ...prev, endpointFallback }))
          }
        />
      </div>
    </SettingsSection>
  );
}
