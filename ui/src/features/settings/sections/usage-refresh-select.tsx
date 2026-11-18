import type { JSX } from "react";
import { SettingsRow } from "@/components/shared/settings-rows";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type TFunction, useT } from "@/lib/i18n";
import { useInstantValue } from "./general-settings";
import { RowActionError } from "./settings-section";

/** The intervals the select offers, in minutes; 0 is off. The server takes 0 or 5..1440. */
const REFRESH_PRESETS: readonly number[] = [0, 5, 10, 15, 30, 60, 120, 360, 720, 1440];

/** "Off", "Every 15 minutes", "Every 6 hours". */
function intervalLabel(minutes: number, t: TFunction): string {
  if (minutes === 0) return t("usageRefresh.off");
  if (minutes % 60 === 0) return t("usageRefresh.hours", { count: minutes / 60 });
  return t("usageRefresh.minutes", { count: minutes });
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

/**
 * How often the background sweep refreshes every account's usage and tokens; 0 is off. It saves
 * as it is picked, like the switch above it (useInstantValue).
 */
export function UsageRefreshRow({ saved }: { saved: number }): JSX.Element {
  const { t } = useT("settings");
  const interval = useInstantValue(saved, (minutes) => ({ usageRefreshIntervalMinutes: minutes }));
  return (
    <SettingsRow
      control={<IntervalSelect onChange={interval.onChange} value={interval.value} />}
      description={t("usageRefresh.hint")}
      title={t("usageRefresh.title")}
    >
      {interval.failure ? (
        <RowActionError
          error={interval.failure.error}
          onDismiss={interval.failure.dismiss}
          onRetry={interval.failure.retry}
        />
      ) : null}
    </SettingsRow>
  );
}
