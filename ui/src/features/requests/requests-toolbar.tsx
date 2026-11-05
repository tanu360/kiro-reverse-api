import { Search01Icon, XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useEffect, useRef, useState } from "react";
import { InfoHint } from "@/components/shared/info-hint";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { useElementWidth } from "@/hooks/use-element-width";
import { useT } from "@/lib/i18n";

export const SEARCH_DEBOUNCE_MS = 250;

/** Below this toolbar width (the @md container step, 28rem) the placeholder is the short one. */
const SHORT_PLACEHOLDER_BELOW = 448;

type StatusValue = "success" | "failed" | undefined;
const ALL = "all";

export interface RequestsToolbarProps {
  /** The search held in the URL. */
  search: string;
  status: StatusValue;
  /** Called with the trimmed text 250 ms after the viewer stops typing. */
  onSearchChange: (search: string) => void;
  onStatusChange: (status: StatusValue) => void;
}

/** Search and the status filter on one row; the page size lives in the table's footer. */
export function RequestsToolbar({
  search,
  status,
  onSearchChange,
  onStatusChange,
}: RequestsToolbarProps): JSX.Element {
  const { t } = useT("requests");
  const [text, setText] = useState(search);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const width = useElementWidth(rootRef);
  const latest = useRef({ search, onSearchChange });
  latest.current = { search, onSearchChange };

  // The URL wins when it changes from elsewhere (Clear filters, back button).
  useEffect(() => {
    setText((current) => (current.trim() === search ? current : search));
  }, [search]);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === latest.current.search) return;
    const timer = setTimeout(() => latest.current.onSearchChange(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const statusOptions: { value: string; label: string }[] = [
    { value: ALL, label: t("allStatuses") },
    { value: "success", label: t("ok") },
    { value: "failed", label: t("fail") },
  ];
  const placeholder =
    width > 0 && width < SHORT_PLACEHOLDER_BELOW
      ? t("searchPlaceholderShort")
      : t("searchPlaceholder");

  return (
    // One row from the @md container step up; below it each control takes a full-width row.
    <div className="flex min-w-0 flex-wrap items-center gap-2" ref={rootRef}>
      <InputGroup className="min-w-32 flex-1 basis-full @md/requests:basis-0 @3xl/requests:max-w-md">
        <InputGroupAddon>
          <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t("search")}
          autoComplete="off"
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && text) {
              event.preventDefault();
              setText("");
            }
          }}
          placeholder={placeholder}
          ref={inputRef}
          size="sm"
          spellCheck={false}
          type="search"
          value={text}
        />
        {/*
          One trailing control at a time: the clear X takes the hint's slot while there is text,
          so it sits at the field's edge and the two touch targets never overlap.
        */}
        <InputGroupAddon align="inline-end">
          {text ? (
            <Button
              aria-label={t("clearSearch")}
              onClick={() => {
                setText("");
                inputRef.current?.focus();
              }}
              size="icon-xs"
              variant="quiet"
            >
              <HugeiconsIcon icon={XIcon} aria-hidden="true" />
            </Button>
          ) : (
            // Opens on hover, click and tap; the label is for screen readers only.
            <InfoHint className="gap-0" hint={t("searchHint")}>
              <span className="sr-only">{t("searchHintLabel")}</span>
            </InfoHint>
          )}
        </InputGroupAddon>
      </InputGroup>

      <SegmentedControl
        className="w-full shrink-0 @md/requests:ms-auto @md/requests:w-auto"
        render={
          <RadioGroupPrimitive
            aria-label={t("statusFilter")}
            onValueChange={(value) => {
              const next = value === ALL ? undefined : (value as StatusValue);
              if (next !== status) onStatusChange(next);
            }}
            value={status ?? ALL}
          />
        }
        size="sm"
        surface="field"
      >
        {statusOptions.map((option) => (
          <SegmentedControlItem
            className="flex-1 @md/requests:flex-none"
            key={option.value}
            render={<RadioPrimitive.Root value={option.value} />}
          >
            {option.label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}
