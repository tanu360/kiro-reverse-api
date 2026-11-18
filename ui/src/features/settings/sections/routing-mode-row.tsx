import type { JSX } from "react";
import { SettingsRow } from "@/components/shared/settings-rows";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  isRoutingMode,
  ROUTING_MODE_LABEL,
  ROUTING_MODES,
} from "@/features/accounts/use-routing-mode";
import type { Settings } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useInstantValue } from "./general-settings";
import { Hint, RowActionError } from "./settings-section";

/**
 * Weighted round-robin, strict priority order, or the credits that reset first, for new
 * requests. A missing or unknown mode (an older server) reads as weighted, the server's default.
 * It saves as it is picked, like the affinity switch under it (useInstantValue).
 */
export function RoutingModeRow({ settings }: { settings: Settings }): JSX.Element {
  const { t } = useT("settings");
  const mode = useInstantValue(
    isRoutingMode(settings.routingMode) ? settings.routingMode : "weighted",
    (routingMode) => ({ routingMode }),
  );
  return (
    <SettingsRow
      control={
        // A radio group: one tab stop, the arrow keys move the choice.
        <SegmentedControl
          render={
            <RadioGroupPrimitive
              onValueChange={(next) => {
                if (isRoutingMode(next)) mode.onChange(next);
              }}
              value={mode.value}
            />
          }
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
    >
      {mode.failure ? (
        <RowActionError
          error={mode.failure.error}
          onDismiss={mode.failure.dismiss}
          onRetry={mode.failure.retry}
        />
      ) : null}
    </SettingsRow>
  );
}
