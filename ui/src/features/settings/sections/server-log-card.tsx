import { Alert02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { SettingsRow } from "@/components/shared/settings-rows";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { settingsQuery, updateSettings } from "@/lib/api/settings";
import type { LogLevel, Settings, SettingsPatch } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { writeSettingsCache } from "./general-settings";
import { SECTION_ID } from "./sections";
import { Hint, SectionQuery, SettingsSection, useSectionSave } from "./settings-section";

/** Most detail first, as the server ranks them. */
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function ServerLogCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  return (
    <SectionQuery id={SECTION_ID.serverLog} query={query} shared title={t("serverLog.title")}>
      {(settings) => <ServerLogForm settings={settings} />}
    </SectionQuery>
  );
}

/**
 * The level saves as it is picked, like the usage refresh interval: the pick shows at once, a
 * failed save puts the saved level back and the toast says why, and a pick while a save is in
 * flight is ignored so two patches never race.
 */
function useInstantLogLevel(saved: LogLevel): {
  value: LogLevel;
  onChange: (level: LogLevel) => void;
} {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<LogLevel | null>(null);
  const { save, saving } = useSectionSave((patch: SettingsPatch) => updateSettings(patch), {
    onSaved: (patch) => {
      writeSettingsCache(queryClient, patch);
      setPending(null);
    },
    onFailed: () => setPending(null),
  });
  const value = pending ?? saved;
  return {
    value,
    onChange: (level) => {
      if (saving || level === value) return;
      setPending(level);
      save({ logLevel: level });
    },
  };
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/** The level select. The row's label and description (SettingsRow) go to the trigger. */
function LevelSelect({
  value,
  onChange,
  ...aria
}: AriaProps & { value: LogLevel; onChange: (level: LogLevel) => void }): JSX.Element {
  const { t } = useT("settings");
  const items = LOG_LEVELS.map((level) => ({ value: level, label: t(`serverLog.${level}`) }));
  return (
    <Select
      items={items}
      onValueChange={(next) => {
        if (typeof next === "string" && LOG_LEVELS.includes(next as LogLevel)) {
          onChange(next as LogLevel);
        }
      }}
      value={value}
    >
      <SelectTrigger {...aria}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ServerLogForm({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  // Missing (an older server) means the default, info.
  const level = useInstantLogLevel(settings.logLevel ?? "info");
  return (
    <SettingsSection id={SECTION_ID.serverLog} title={t("serverLog.title")}>
      <SettingsRow
        control={<LevelSelect onChange={level.onChange} value={level.value} />}
        description={<Hint more={t("serverLog.more")}>{t("serverLog.hint")}</Hint>}
        title={t("serverLog.level")}
      >
        {/* Notices under the description, each as wide as its text. */}
        {level.value === "debug" ? (
          <Alert className="mt-1 w-fit max-w-2xl" role="note" size="sm" variant="warning">
            <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
            <AlertDescription>{t("serverLog.debugWarning")}</AlertDescription>
          </Alert>
        ) : null}
        {settings.logLevelFromEnv ? (
          <Alert className="mt-1 w-fit max-w-2xl" role="note" size="sm" variant="info">
            <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
            <AlertDescription>{t("serverLog.envNote")}</AlertDescription>
          </Alert>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
