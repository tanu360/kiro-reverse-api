import { Alert02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { SwitchField } from "@/components/shared/settings-rows";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { endpointQuery, settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useInstantSetting } from "./general-settings";
import { SECTION_ID } from "./sections";
import { RowActionError, SectionQuery, SettingsSection } from "./settings-section";

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
  // CreateResponse always ends a turn with a stop reason (proxy/kiro_responses_stream.go
  // completed), which passes before this switch is read; Kiro API keys stay on the older runtime.
  const chatOnResponses = useQuery(endpointQuery()).data?.chatApi === "responses";
  // Missing means off.
  const lenientStreamIntegrity = useInstantSetting(
    "lenientStreamIntegrity",
    settings.lenientStreamIntegrity === true,
  );

  return (
    <SettingsSection id={SECTION_ID.streamIntegrity} title={t("streamIntegrity")}>
      <SwitchField
        checked={lenientStreamIntegrity.checked}
        description={t("lenientStreamIntegrityHint")}
        notice={
          lenientStreamIntegrity.failure ? (
            <RowActionError
              error={lenientStreamIntegrity.failure.error}
              onDismiss={lenientStreamIntegrity.failure.dismiss}
              onRetry={lenientStreamIntegrity.failure.retry}
            />
          ) : null
        }
        onCheckedChange={lenientStreamIntegrity.onCheckedChange}
        title={t("lenientStreamIntegrity")}
      >
        {/* The risk as a small warning notice under the description, as wide as its text. */}
        <Alert className="mt-1 w-fit max-w-2xl" role="note" size="sm" variant="warning">
          <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
          <AlertDescription>{t("lenientStreamIntegrityRisk")}</AlertDescription>
        </Alert>
        {chatOnResponses ? (
          <Alert className="mt-1 w-fit max-w-2xl" role="note" size="sm" variant="info">
            <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
            <AlertDescription>{t("lenientStreamIntegrityResponses")}</AlertDescription>
          </Alert>
        ) : null}
      </SwitchField>
    </SettingsSection>
  );
}
