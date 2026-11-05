import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { SwitchField } from "@/components/shared/settings-rows";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import { SaveFooter, SectionQuery, SettingsSection } from "./settings-section";

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
      footer={
        <SaveFooter
          dirty={draft.dirty}
          onReload={draft.reload}
          saving={saving}
          serverChanged={draft.serverChanged}
        />
      }
      id={SECTION_ID.streamIntegrity}
      onSubmit={() => save(draft.value)}
      title={t("streamIntegrity")}
    >
      <SwitchField
        checked={draft.value.lenientStreamIntegrity}
        description={t("lenientStreamIntegrityHint")}
        onCheckedChange={(lenientStreamIntegrity) => draft.set({ lenientStreamIntegrity })}
        title={t("lenientStreamIntegrity")}
      >
        {/* The risk as a small warning notice under the description, as wide as its text. */}
        <Alert className="mt-1 w-fit max-w-2xl" role="note" size="sm" variant="warning">
          <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
          <AlertDescription>{t("lenientStreamIntegrityRisk")}</AlertDescription>
        </Alert>
      </SwitchField>
    </SettingsSection>
  );
}
