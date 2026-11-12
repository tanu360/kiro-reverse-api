import { useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { SettingsRow } from "@/components/shared/settings-rows";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateSettings } from "@/lib/api/settings";
import type { SettingsPatch } from "@/lib/api/types";
import { type TFunction, useT } from "@/lib/i18n";
import { writeSettingsCache } from "./general-settings";
import { useSectionSave } from "./settings-section";

/** The intervals the select offers, in minutes; 0 is off. The server takes 0 or 5..1440. */
const REFRESH_PRESETS: readonly number[] = [0, 5, 10, 15, 30, 60, 120, 360, 720, 1440];

/** "Off", "Every 15 minutes", "Every 6 hours". */
function intervalLabel(minutes: number, t: TFunction): string {
  if (minutes === 0) return t("usageRefresh.off");
  if (minutes % 60 === 0) return t("usageRefresh.hours", { count: minutes / 60 });
  return t("usageRefresh.minutes", { count: minutes });
}

/**
 * The interval saves as it is picked, like the switch above it (useInstantSetting): the pick
 * shows at once, a failed save puts the saved value back and the toast says why, and a pick
 * while a save is in flight is ignored so two patches never race.
 */
function useInstantInterval(saved: number): {
  value: number;
  onChange: (minutes: number) => void;
} {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<number | null>(null);
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
    onChange: (minutes) => {
      if (saving || minutes === value) return;
      setPending(minutes);
      save({ usageRefreshIntervalMinutes: minutes });
    },
  };
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/** The interval select. The row's label and description (SettingsRow) go to the trigger. */
function IntervalSelect({
  value,
  onChange,
  ...aria
}: AriaProps & { value: number; onChange: (minutes: number) => void }): JSX.Element {
  const { t } = useT("settings");
  // The API also takes values the presets lack (45); keep a stored one visible, in order.
  const shown = REFRESH_PRESETS.includes(value)
    ? REFRESH_PRESETS
    : [...REFRESH_PRESETS, value].sort((a, b) => a - b);
  const items = shown.map((minutes) => ({ value: minutes, label: intervalLabel(minutes, t) }));
  return (
    <Select
      items={items}
      onValueChange={(next) => {
        if (typeof next === "number") onChange(next);
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

/** How often the background sweep refreshes every account's usage and tokens; 0 is off. */
export function UsageRefreshRow({ saved }: { saved: number }): JSX.Element {
  const { t } = useT("settings");
  const interval = useInstantInterval(saved);
  return (
    <SettingsRow
      control={<IntervalSelect onChange={interval.onChange} value={interval.value} />}
      description={t("usageRefresh.hint")}
      title={t("usageRefresh.title")}
    />
  );
}
