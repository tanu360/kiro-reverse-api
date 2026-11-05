import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { cn } from "@/lib/utils";

/*
 * The icon tile of an empty or error state: a 36 px rounded tile on the card surface. The empty
 * state stacks two tilted copies behind it (coss's "pile"); the destructive tone (errors) is a
 * single red-tinted tile.
 */
const emptyMediaVariants = cva(
  "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      tone: "default",
      variant: "default",
    },
    // `variant` before `tone`, so the tone's colours come last and win the merge.
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "relative size-9 rounded-lg border border-border bg-card text-foreground [&_svg:not([class*='size-'])]:size-4.5",
      },
      tone: {
        default: "",
        destructive: "border-destructive/24 bg-error-surface text-destructive-foreground",
      },
    },
  },
);

export function Empty({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-6 text-balance p-6 text-center md:p-12",
        className,
      )}
      data-slot="empty"
      {...props}
    />
  );
}

export function EmptyHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex max-w-sm flex-col items-center text-center",
        className,
      )}
      data-slot="empty-header"
      {...props}
    />
  );
}

export function EmptyMedia({
  className,
  variant = "default",
  tone = "default",
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof emptyMediaVariants>): React.ReactElement {
  const pile = variant === "icon" && tone !== "destructive";
  return (
    // Only this wrapper takes className and props, so a margin passed in lands once.
    <div
      className={cn("relative mb-6", className)}
      data-slot="empty-media"
      data-tone={tone}
      data-variant={variant}
      {...props}
    >
      {pile && (
        <>
          <div
            aria-hidden="true"
            className={cn(
              emptyMediaVariants({ tone, variant }),
              "pointer-events-none absolute bottom-px origin-bottom-left -translate-x-0.5 -rotate-10 scale-84",
            )}
          />
          <div
            aria-hidden="true"
            className={cn(
              emptyMediaVariants({ tone, variant }),
              "pointer-events-none absolute bottom-px origin-bottom-right translate-x-0.5 rotate-10 scale-84",
            )}
          />
        </>
      )}
      <div className={cn(emptyMediaVariants({ tone, variant }))}>{children}</div>
    </div>
  );
}

export function EmptyTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("font-semibold text-foreground text-heading leading-6", className)}
      data-slot="empty-title"
      {...props}
    />
  );
}

export function EmptyDescription({
  className,
  ...props
}: React.ComponentProps<"p">): React.ReactElement {
  return (
    <div
      className={cn(
        "text-pretty text-muted-foreground text-sm leading-relaxed [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4 [[data-slot=empty-title]+&]:mt-1 [[data-slot=empty-description]+&]:mt-1",
        className,
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

export function EmptyContent({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm",
        className,
      )}
      data-slot="empty-content"
      {...props}
    />
  );
}
