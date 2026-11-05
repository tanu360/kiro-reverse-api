import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { SwitchField } from "@/components/shared/settings-rows";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import { Hint, SaveFooter, SectionQuery, SettingsSection } from "./settings-section";

export function RoutingCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  return (
    <SectionQuery id={SECTION_ID.routing} query={query} shared title={t("routing")}>
      {(settings) => <RoutingForm settings={settings} />}
    </SectionQuery>
  );
}

function RoutingForm({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  // Missing means on.
  const draft = useDraft({ sessionAffinity: settings.sessionAffinity !== false });
  const { save, saving } = useGeneralSettingsSave(draft);

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
      id={SECTION_ID.routing}
      onSubmit={() => save(draft.value)}
      title={t("routing")}
    >
      <SwitchField
        checked={draft.value.sessionAffinity}
        description={<Hint more={t("sessionAffinityMore")}>{t("sessionAffinityHint")}</Hint>}
        onCheckedChange={(sessionAffinity) => draft.set({ sessionAffinity })}
        title={t("sessionAffinity")}
      />
    </SettingsSection>
  );
}
