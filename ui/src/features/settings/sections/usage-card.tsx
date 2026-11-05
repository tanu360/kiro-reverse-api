import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import { SaveFooter, SectionQuery, SettingsSection, SwitchField } from "./settings-section";

export function UsageCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  return (
    <SectionQuery id={SECTION_ID.usage} query={query} shared title={t("usageSettings")}>
      {(settings) => <UsageForm settings={settings} />}
    </SectionQuery>
  );
}

function UsageForm({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  // Missing means off.
  const draft = useDraft({ allowOverUsage: settings.allowOverUsage === true });
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
      id={SECTION_ID.usage}
      onSubmit={() => save(draft.value)}
      title={t("usageSettings")}
    >
      <SwitchField
        checked={draft.value.allowOverUsage}
        label={t("allowOverUsage")}
        hint={t("allowOverUsageHint")}
        onCheckedChange={(allowOverUsage) => draft.set({ allowOverUsage })}
      />
    </SettingsSection>
  );
}
