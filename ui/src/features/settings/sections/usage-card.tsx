import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { SwitchField } from "@/components/shared/settings-rows";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useInstantSetting } from "./general-settings";
import { SECTION_ID } from "./sections";
import { SectionQuery, SettingsSection } from "./settings-section";

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
  const allowOverUsage = useInstantSetting("allowOverUsage", settings.allowOverUsage === true);

  return (
    <SettingsSection id={SECTION_ID.usage} title={t("usageSettings")}>
      <SwitchField
        checked={allowOverUsage.checked}
        description={t("allowOverUsageHint")}
        onCheckedChange={allowOverUsage.onCheckedChange}
        title={t("allowOverUsage")}
      />
    </SettingsSection>
  );
}
