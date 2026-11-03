import { useQuery } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import type { JSX } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import { SaveFooter, SectionQuery, SettingsSection, SwitchField } from "./settings-section";

export function StreamIntegrityCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  return (
    <SectionQuery id={SECTION_ID.streamIntegrity} query={query} shared title={t("streamIntegrity")}>
      {(settings) => <StreamIntegrityForm settings={settings} />}
    </SectionQuery>
  );
}

function StreamIntegrityForm({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  // Missing means off.
  const draft = useDraft({ lenientStreamIntegrity: settings.lenientStreamIntegrity === true });
  const { save, saving } = useGeneralSettingsSave(draft);

  return (
    <SettingsSection
      defaultOn={false}
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={draft.reload}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      hint={t("lenientStreamIntegrityHint")}
      id={SECTION_ID.streamIntegrity}
      onSubmit={() => save(draft.value)}
      title={t("streamIntegrity")}
    >
      <div className="flex flex-col gap-4">
        <SwitchField
          checked={draft.value.lenientStreamIntegrity}
          label={t("lenientStreamIntegrity")}
          onCheckedChange={(lenientStreamIntegrity) => draft.set({ lenientStreamIntegrity })}
        />
        <Alert role="note" variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{t("lenientStreamIntegrityRisk")}</AlertDescription>
        </Alert>
      </div>
    </SettingsSection>
  );
}
