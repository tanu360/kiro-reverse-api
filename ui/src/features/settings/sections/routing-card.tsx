import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { SwitchField } from "@/components/shared/settings-rows";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { RpmLimitFooter, RpmLimitRows, useRpmLimitForm } from "./account-rpm-limit";
import { useInstantSetting } from "./general-settings";
import { RoutingModeRow } from "./routing-mode-row";
import { SECTION_ID } from "./sections";
import { Hint, SectionQuery, SettingsSection } from "./settings-section";

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
  const sessionAffinity = useInstantSetting("sessionAffinity", settings.sessionAffinity !== false);
  // Session affinity saves as it is flipped; the RPM limit is a draft saved with the footer.
  const rpmLimit = useRpmLimitForm(settings);

  return (
    <SettingsSection
      footer={<RpmLimitFooter form={rpmLimit} />}
      id={SECTION_ID.routing}
      onSubmit={rpmLimit.submit}
      title={t("routing")}
    >
      <RoutingModeRow settings={settings} />
      <SwitchField
        checked={sessionAffinity.checked}
        description={<Hint more={t("sessionAffinityMore")}>{t("sessionAffinityHint")}</Hint>}
        onCheckedChange={sessionAffinity.onCheckedChange}
        title={t("sessionAffinity")}
      />
      <RpmLimitRows form={rpmLimit} />
    </SettingsSection>
  );
}
