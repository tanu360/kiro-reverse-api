import { InfoIcon, SearchIcon, XIcon } from "lucide-react";
import { type JSX, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, type PageSize } from "./request-model";

export const SEARCH_DEBOUNCE_MS = 250;

type StatusValue = "success" | "failed" | undefined;

export interface RequestsToolbarProps {
  /** The search held in the URL. */
  search: string;
  status: StatusValue;
  pageSize: number;
  /** Called with the trimmed text 250 ms after the viewer stops typing. */
  onSearchChange: (search: string) => void;
  onStatusChange: (status: StatusValue) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
}

/** Filter bar adapted from the data-table-filters toolbar: search, status, page size. */
export function RequestsToolbar({
  search,
  status,
  pageSize,
  onSearchChange,
  onStatusChange,
  onPageSizeChange,
}: RequestsToolbarProps): JSX.Element {
  const { t } = useT("requests");
  const [text, setText] = useState(search);
  const inputRef = useRef<HTMLInputElement>(null);
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

  const statusOptions: { value: StatusValue; label: string }[] = [
    { value: undefined, label: t("allStatuses") },
    { value: "success", label: t("ok") },
    { value: "failed", label: t("fail") },
  ];
  const sizeItems = PAGE_SIZES.map((size) => ({
    value: String(size),
    label: t("pageSizeOption", { count: size }),
  }));

  return (
    // Sized by the toolbar's own width, not the viewport's: a narrow content column (phone,
    // tablet, or a desktop with the sidebar open) stacks the search above the filters.
    <div className="@container/toolbar">
      <div className="flex flex-col gap-2 @[38rem]/toolbar:grid @[38rem]/toolbar:grid-cols-[minmax(16rem,1fr)_auto_auto] @[38rem]/toolbar:items-center">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
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
            placeholder={t("searchPlaceholder")}
            ref={inputRef}
            spellCheck={false}
            type="search"
            value={text}
          />
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
                <XIcon aria-hidden="true" />
              </Button>
            ) : null}
            {/* A popover, not a tooltip: a tap opens it on touch screens, hover still works. */}
            <Popover>
              <PopoverTrigger
                openOnHover
                render={<Button aria-label={t("searchHintLabel")} size="icon-xs" variant="quiet" />}
              >
                <InfoIcon aria-hidden="true" />
              </PopoverTrigger>
              <PopoverPopup className="max-w-xs" tooltipStyle>
                {t("searchHint")}
              </PopoverPopup>
            </Popover>
          </InputGroupAddon>
        </InputGroup>

        <div className="flex flex-wrap items-center justify-between gap-2 @[38rem]/toolbar:contents">
          <SegmentedControl aria-label={t("statusFilter")} role="group">
            {statusOptions.map((option) => {
              const active = option.value === status;
              return (
                <SegmentedControlItem
                  aria-pressed={active}
                  data-pressed={active ? "" : undefined}
                  key={option.value ?? "all"}
                  onClick={() => {
                    if (!active) onStatusChange(option.value);
                  }}
                >
                  {option.label}
                </SegmentedControlItem>
              );
            })}
          </SegmentedControl>

          <Select
            items={sizeItems}
            onValueChange={(value) => {
              const next = Number(value);
              if ((PAGE_SIZES as readonly number[]).includes(next))
                onPageSizeChange(next as PageSize);
            }}
            value={String(pageSize || DEFAULT_PAGE_SIZE)}
          >
            <SelectTrigger aria-label={t("pageSize")} className="w-auto min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {sizeItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
    </div>
  );
}
