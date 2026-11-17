import { Calendar03Icon, ChevronDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { selectTriggerIconClassName, selectTriggerVariants } from "@/components/ui/select";
import { dateTimeFormat, formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { endOfLocalDay, expiryInDays } from "./api-key-form";

/** Preset spans, in days from today; the year preset is the same date a year on. */
const PRESET_DAYS = [1, 7, 30, 90] as const;

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * When a key stops working, by day: presets (never, in 1, 7, 30 or 90 days, in a year) beside
 * the coss Calendar in a Popover, closing on a pick. A picked day counts to its last second in
 * the viewer's time zone. Days before today are disabled; a stored expiry that has passed (edit)
 * still shows until another day or Never is picked. It is a settings row's control: the row's
 * title and description name and describe the trigger (SettingsRow passes their ids as
 * aria-labelledby and aria-describedby), and the row says when the day has passed.
 */
export function ExpiryPicker({
  value,
  onChange,
  "aria-labelledby": rowLabelledBy,
  "aria-describedby": rowDescribedBy,
}: {
  /** unix s; 0 = never. */
  value: number;
  onChange: (value: number) => void;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}): JSX.Element {
  const { t, lang } = useT("api");
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const selected = value > 0 ? new Date(value * 1000) : undefined;
  const [month, setMonth] = useState<Date>(() => selected ?? startOfToday());
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const past = value > 0 && value <= nowSec;

  const yearOn = endOfLocalDay(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()));
  const presets = [
    { key: "never", label: t("form.expiryNever"), value: 0 },
    ...PRESET_DAYS.map((days) => ({
      key: `d${days}`,
      label: t("form.expiryDays", { count: days }),
      value: expiryInDays(days, now),
    })),
    { key: "year", label: t("form.expiryYear"), value: yearOn },
  ];

  const pick = (next: number) => {
    onChange(next);
    if (next > 0) setMonth(new Date(next * 1000));
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-describedby={rowDescribedBy}
        aria-labelledby={`${rowLabelledBy ?? ""} ${valueId}`.trim()}
        className={selectTriggerVariants()}
      >
        <HugeiconsIcon aria-hidden="true" icon={Calendar03Icon} />
        <span className="min-w-0 flex-1 truncate" id={valueId}>
          {selected
            ? dateTimeFormat(lang, { dateStyle: "medium" }).format(selected)
            : t("form.expiryNone")}
        </span>
        {selected && !past ? (
          <span className="shrink-0 text-muted-foreground text-xs">
            {formatRelativeTime(value, lang)}
          </span>
        ) : null}
        <HugeiconsIcon
          aria-hidden="true"
          className={selectTriggerIconClassName}
          icon={ChevronDownIcon}
        />
      </PopoverTrigger>
      <PopoverPopup align="start" flush>
        <div className="flex max-sm:flex-col">
          <div className="flex gap-0.5 max-sm:order-1 max-sm:mt-2 max-sm:flex-wrap max-sm:border-border-subtle max-sm:border-t max-sm:pt-2 sm:me-2 sm:flex-col sm:border-border-subtle sm:border-e sm:pe-2">
            {presets.map((preset) => (
              <Button
                aria-pressed={value === preset.value}
                className="justify-start"
                key={preset.key}
                onClick={() => pick(preset.value)}
                size="sm"
                variant="quiet"
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <Calendar
            disabled={{ before: startOfToday() }}
            mode="single"
            month={month}
            onMonthChange={setMonth}
            onSelect={(day: Date | undefined) => {
              if (day) pick(endOfLocalDay(day));
            }}
            selected={selected}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
