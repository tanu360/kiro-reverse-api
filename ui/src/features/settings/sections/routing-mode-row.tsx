import { useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { SettingsRow } from "@/components/shared/settings-rows";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  isRoutingMode,
  ROUTING_MODE_LABEL,
  ROUTING_MODES,
} from "@/features/accounts/use-routing-mode";
import { updateSettings } from "@/lib/api/settings";
import type { RoutingMode, Settings, SettingsPatch } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { writeSettingsCache } from "./general-settings";
import { Hint, useSectionSave } from "./settings-section";

/**
 * The routing mode saves as it is picked, like the affinity switch under it (useInstantSetting):
 * the segment moves at once, a failed save puts it back with the error toast, and a pick while a
 * save is in flight is ignored so two patches never race.
 */
function useInstantRoutingMode(saved: RoutingMode): {
  value: RoutingMode;
  onValueChange: (value: unknown) => void;
} {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<RoutingMode | null>(null);
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
    onValueChange: (next) => {
      if (saving || !isRoutingMode(next) || next === value) return;
      setPending(next);
      save({ routingMode: next });
    },
  };
}

/**
 * Weighted round-robin, strict priority order, or the credits that reset first, for new
 * requests. A missing or unknown mode (an older server) reads as weighted, the server's default.
 */
export function RoutingModeRow({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  const mode = useInstantRoutingMode(
    isRoutingMode(settings.routingMode) ? settings.routingMode : "weighted",
  );
  return (
    <SettingsRow
      control={
        // A radio group: one tab stop, the arrow keys move the choice.
        <SegmentedControl
          render={<RadioGroupPrimitive onValueChange={mode.onValueChange} value={mode.value} />}
          size="sm"
        >
          {ROUTING_MODES.map((value) => (
            <SegmentedControlItem key={value} render={<RadioPrimitive.Root value={value} />}>
              {t(ROUTING_MODE_LABEL[value])}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      }
      controlWidth="actions"
      description={
        mode.value === "priority" ? (
          <Hint more={t("routingMode.priorityMore")}>{t("routingMode.priorityHint")}</Hint>
        ) : mode.value === "reset_first" ? (
          <Hint more={t("routingMode.resetFirstMore")}>{t("routingMode.resetFirstHint")}</Hint>
        ) : (
          t("routingMode.weightedHint")
        )
      }
      title={t("routingMode.title")}
    />
  );
}
