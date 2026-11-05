"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { type Button, buttonVariants } from "@/components/ui/button";
import { useUiT } from "@/components/ui/messages";

export function Pagination({
  className,
  ...props
}: React.ComponentProps<"nav">): React.ReactElement {
  const { t } = useUiT();
  return (
    <nav
      aria-label={t("pagination.label")}
      className={cn("mx-auto flex w-full justify-center", className)}
      data-slot="pagination"
      {...props}
    />
  );
}

export function PaginationContent({
  className,
  ...props
}: React.ComponentProps<"ul">): React.ReactElement {
  return (
    <ul
      className={cn("flex flex-row items-center gap-1", className)}
      data-slot="pagination-content"
      {...props}
    />
  );
}

export function PaginationItem({
  ...props
}: React.ComponentProps<"li">): React.ReactElement {
  return <li data-slot="pagination-item" {...props} />;
}

export type PaginationLinkProps = {
  isActive?: boolean;
  size?: React.ComponentProps<typeof Button>["size"];
} & useRender.ComponentProps<"a">;

export function PaginationLink({
  className,
  isActive,
  size = "icon",
  render,
  ...props
}: PaginationLinkProps): React.ReactElement {
  const defaultProps = {
    "aria-current": isActive ? ("page" as const) : undefined,
    className: render
      ? className
      : cn(
          // The current page takes the accent fill, as a highlighted popup row.
          buttonVariants({ size, variant: "ghost" }),
          "tabular-nums",
          isActive && "bg-accent text-foreground",
          className,
        ),
    "data-active": isActive,
    "data-slot": "pagination-link",
  };

  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
  });
}

export function PaginationPrevious({
  className,
  ...props
}: React.ComponentProps<typeof PaginationLink>): React.ReactElement {
  const { t } = useUiT();
  return (
    <PaginationLink
      aria-label={t("pagination.previousPage")}
      className={cn("max-sm:aspect-square max-sm:p-0", className)}
      size="default"
      {...props}
    >
      <HugeiconsIcon icon={ChevronLeftIcon} className="sm:-ms-1" />
      <span className="max-sm:hidden">{t("pagination.previous")}</span>
    </PaginationLink>
  );
}

export function PaginationNext({
  className,
  ...props
}: React.ComponentProps<typeof PaginationLink>): React.ReactElement {
  const { t } = useUiT();
  return (
    <PaginationLink
      aria-label={t("pagination.nextPage")}
      className={cn("max-sm:aspect-square max-sm:p-0", className)}
      size="default"
      {...props}
    >
      <span className="max-sm:hidden">{t("pagination.next")}</span>
      <HugeiconsIcon icon={ChevronRightIcon} className="sm:-me-1" />
    </PaginationLink>
  );
}

export function PaginationEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  const { t } = useUiT();
  return (
    <span
      aria-hidden
      className={cn("flex min-w-7 justify-center", className)}
      data-slot="pagination-ellipsis"
      {...props}
    >
      <HugeiconsIcon icon={MoreHorizontalIcon} className="size-5 sm:size-4" />
      <span className="sr-only">{t("pagination.more")}</span>
    </span>
  );
}
