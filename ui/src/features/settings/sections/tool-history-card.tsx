import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import { SaveFooter, SectionQuery, SettingsSection, SwitchField } from "./settings-section";

export function ToolHistoryCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  return (
    <SectionQuery id={SECTION_ID.toolHistory} query={query} shared title={t("toolHistory")}>
      {(settings) => <ToolHistoryForm settings={settings} />}
    </SectionQuery>
  );
}

function ToolHistoryForm({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  // Missing means on.
  const draft = useDraft({ structuredToolHistory: settings.structuredToolHistory !== false });
  const { save, saving } = useGeneralSettingsSave(draft);

  return (
    <SettingsSection
      defaultOn
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={draft.reload}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      id={SECTION_ID.toolHistory}
      onSubmit={() => save(draft.value)}
      title={t("toolHistory")}
    >
      <SwitchField
        checked={draft.value.structuredToolHistory}
        label={t("structuredToolHistory")}
        learnMore={t("structuredToolHistoryMore")}
        hint={t("structuredToolHistoryHint")}
        onCheckedChange={(structuredToolHistory) => draft.set({ structuredToolHistory })}
      />
    </SettingsSection>
  );
}
