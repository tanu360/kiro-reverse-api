import { RepeatIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { KeepLabels, useCompactActions } from "@/components/ui/compact-actions";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import {
  SegmentedControl,
  SegmentedControlItem,
  type SegmentedControlSize,
} from "@/components/ui/segmented-control";
import { announce } from "@/lib/announce";
import { useT } from "@/lib/i18n";

export type SegmentedPickerItem<T extends string> = { value: T; label: string };

/**
 * A card header's choice between a few options (a range, a measure): a segmented radio group (one
 * tab stop, the arrow keys move it). Where the header is too narrow for it beside the title
 * (CompactActionsContext), one button shows the current option and a tap moves to the next,
 * round to the first; the new choice is announced.
 */
export function SegmentedPicker<T extends string>({
  label,
  items,
  value,
  onValueChange,
  size = "sm",
}: {
  /** The group's name ("Range"). */
  label: string;
  items: readonly SegmentedPickerItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: SegmentedControlSize;
}): JSX.Element {
  const { t } = useT();
  const compact = useCompactActions();

  if (compact && items.length > 0) {
    const index = Math.max(
      0,
      items.findIndex((item) => item.value === value),
    );
    const current = items[index];
    const next = items[(index + 1) % items.length];
    return (
      // The label is the point of this button: it keeps it however narrow the header is.
      <KeepLabels>
        <Button
          aria-label={t("text.labelValue", { label, value: current.label })}
          onClick={() => {
            onValueChange(next.value);
            announce(t("text.labelValue", { label, value: next.label }));
          }}
          size={size === "sm" ? "sm" : size === "lg" ? "lg" : "default"}
          variant="outline"
        >
          {current.label}
          <HugeiconsIcon icon={RepeatIcon} aria-hidden="true" />
        </Button>
      </KeepLabels>
    );
  }

  return (
    <SegmentedControl
      render={
        <RadioGroupPrimitive
          aria-label={label}
          onValueChange={(next) => {
            const item = items.find((option) => option.value === next);
            if (item) onValueChange(item.value);
          }}
          value={value}
        />
      }
      size={size}
    >
      {items.map((item) => (
        <SegmentedControlItem key={item.value} render={<RadioPrimitive.Root value={item.value} />}>
          {item.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
