import { TriangleAlertIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDraft } from "../lib/dirty";
import { useGeneralSettingsSave } from "./general-settings";
import { SECTION_ID } from "./sections";
import {
  SaveFooter,
  SectionQuery,
  SettingsRow,
  SettingsSection,
  SwitchField,
} from "./settings-section";

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
      rows
      title={t("streamIntegrity")}
    >
      <SettingsRow>
        <SwitchField
          checked={draft.value.lenientStreamIntegrity}
          label={t("lenientStreamIntegrity")}
          hint={
            <>
              {t("lenientStreamIntegrityHint")}
              {/* The risk as a warning line under the description, not a box across the row. */}
              <span className="mt-2 flex gap-1.5 text-warning-foreground" role="note">
                <HugeiconsIcon
                  icon={TriangleAlertIcon}
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0"
                />
                <span>{t("lenientStreamIntegrityRisk")}</span>
              </span>
            </>
          }
          onCheckedChange={(lenientStreamIntegrity) => draft.set({ lenientStreamIntegrity })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
