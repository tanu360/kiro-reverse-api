"use client";

import { type DateLib, DayPicker } from "@daypicker/react";
import { ArrowLeft01Icon, ArrowRight01Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { useUiT } from "@/components/ui/messages";
import { dateTimeFormat } from "@/lib/format";
import { intlLocale, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const buttonClassNames =
  "relative flex size-(--cell-size) text-sm items-center justify-center rounded-lg text-foreground not-in-data-selected:hover:bg-accent disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

type CalendarProps = React.ComponentProps<typeof DayPicker>;

/** The month arrows and the dropdown caret, in Hugeicons; the arrows mirror in RTL. */
function CalendarChevron({
  className,
  orientation,
}: {
  className?: string;
  orientation?: "left" | "right" | "up" | "down";
}): React.ReactElement {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className={cn(className, orientation !== "up" && orientation !== "down" && "rtl:rotate-180")}
      icon={
        orientation === "left"
          ? ArrowLeft01Icon
          : orientation === "right"
            ? ArrowRight01Icon
            : UnfoldMoreIcon
      }
    />
  );
}

/** The first day of the week in the language's own region (Intl weekInfo); Sunday when unknown. */
function weekStart(lang: Lang): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  try {
    const locale = new Intl.Locale(intlLocale(lang)) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay ?? 7;
    return (firstDay % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  } catch {
    return 0;
  }
}

/**
 * The coss ui Calendar (it wraps @daypicker/react), on the app's tokens and Hugeicons. Month and
 * weekday names, the first day of the week and the accessible names follow the app's language
 * through Intl and the `ui` namespace, so it needs no date-fns locale of its own. Days look as in
 * shadcn Nova: 32 px cells (the icon button's size), today on the muted fill, days that cannot be
 * picked faded (no strike-through). A popup may size the cells itself (--cell-size).
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  components: userComponents,
  mode = "single",
  ...props
}: CalendarProps): React.ReactElement {
  const { t, lang } = useUiT();
  const defaultClassNames = {
    button_next: buttonClassNames,
    button_previous: buttonClassNames,
    caption_label: "text-sm font-medium flex items-center gap-2 h-full",
    day: "size-(--cell-size) text-sm py-px",
    day_button: cn(
      buttonClassNames,
      "tabular-nums in-data-disabled:pointer-events-none in-[.range-middle]:rounded-none in-[.range-end:not(.range-start)]:rounded-s-none in-[.range-start:not(.range-end)]:rounded-e-none in-[.range-middle]:in-data-selected:bg-accent in-data-selected:bg-primary in-[.range-middle]:in-data-selected:text-foreground in-data-disabled:text-muted-foreground in-data-disabled:opacity-50 in-data-today:not-in-data-selected:bg-muted in-data-outside:text-muted-foreground/72 in-data-selected:in-data-outside:text-primary-foreground in-data-selected:text-primary-foreground outline-none in-[[data-selected]:not(.range-middle)]:transition-[border-radius,box-shadow] focus-visible:z-1 focus-visible:ring-[3px] focus-visible:ring-ring/50",
    ),
    dropdown: "absolute bg-popover inset-0 opacity-0",
    dropdown_root:
      "relative has-focus:border-ring has-focus:ring-ring/50 has-focus:ring-[3px] border border-input shadow-xs/5 rounded-lg px-[calc(--spacing(3)-1px)] h-8 sm:h-9 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-me-1",
    dropdowns:
      "w-full flex items-center text-sm justify-center h-(--cell-size) gap-1.5 *:[span]:font-medium",
    hidden: "invisible",
    month: "w-full",
    month_caption:
      "relative mx-(--cell-size) px-1 mb-1 flex h-(--cell-size) items-center justify-center z-2",
    months: "relative flex flex-col sm:flex-row gap-2",
    nav: "absolute top-0 flex w-full justify-between z-1",
    outside: "text-muted-foreground data-selected:bg-accent/50 data-selected:text-muted-foreground",
    range_end: "range-end",
    range_middle: "range-middle",
    range_start: "range-start",
    today: "",
    week_number: "size-(--cell-size) p-0 text-xs font-medium text-muted-foreground/72",
    weekday: "size-(--cell-size) p-0 text-xs font-medium text-muted-foreground/72",
  };
  const mergedClassNames: typeof defaultClassNames = Object.keys(defaultClassNames).reduce(
    (acc, key) => {
      const userClass = classNames?.[key as keyof typeof classNames];
      const baseClass = defaultClassNames[key as keyof typeof defaultClassNames];
      acc[key as keyof typeof defaultClassNames] = userClass ? cn(baseClass, userClass) : baseClass;
      return acc;
    },
    { ...defaultClassNames } as typeof defaultClassNames,
  );

  const caption = (month: Date) =>
    dateTimeFormat(lang, { month: "long", year: "numeric" }).format(month);
  const fullDate = (date: Date) => dateTimeFormat(lang, { dateStyle: "full" }).format(date);

  const dayPickerProps = {
    className: cn("w-fit [--cell-size:--spacing(8)]", className),
    classNames: mergedClassNames,
    components: { Chevron: CalendarChevron, ...userComponents },
    "data-slot": "calendar",
    formatters: {
      formatCaption: caption,
      formatMonthDropdown: (month: Date, _dateLib: DateLib) =>
        dateTimeFormat(lang, { month: "short" }).format(month),
      formatWeekdayName: (weekday: Date) =>
        dateTimeFormat(lang, { weekday: "short" }).format(weekday),
    } as CalendarProps["formatters"],
    labels: {
      labelDayButton: fullDate,
      labelGrid: caption,
      labelNext: () => t("calendar.nextMonth"),
      labelPrevious: () => t("calendar.previousMonth"),
      labelWeekday: (weekday: Date) => dateTimeFormat(lang, { weekday: "long" }).format(weekday),
    } as CalendarProps["labels"],
    lang: intlLocale(lang),
    mode,
    showOutsideDays,
    weekStartsOn: weekStart(lang),
    ...props,
  };

  return <DayPicker {...(dayPickerProps as CalendarProps)} />;
}
