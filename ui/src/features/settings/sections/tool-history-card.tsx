import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { SwitchField } from "@/components/shared/settings-rows";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useInstantSetting } from "./general-settings";
import { SECTION_ID } from "./sections";
import { Hint, SectionQuery, SettingsSection } from "./settings-section";

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
  const structuredToolHistory = useInstantSetting(
    "structuredToolHistory",
    settings.structuredToolHistory !== false,
  );

  return (
    <SettingsSection id={SECTION_ID.toolHistory} title={t("toolHistory")}>
      <SwitchField
        checked={structuredToolHistory.checked}
        description={
          <Hint more={t("structuredToolHistoryMore")}>{t("structuredToolHistoryHint")}</Hint>
        }
        onCheckedChange={structuredToolHistory.onCheckedChange}
        title={t("structuredToolHistory")}
      />
    </SettingsSection>
  );
}
