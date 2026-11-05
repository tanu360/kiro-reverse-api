import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * The two sizes of an empty or error state. `compact` is for a state inside a card: a 36 px
 * icon tile with 12 px under it, and tighter padding. ErrorState uses the same sizes.
 */
export const EMPTY_SIZING = {
  default: { root: undefined, media: undefined },
  compact: { root: "gap-3 px-4 py-6 md:py-8", media: "mb-3" },
} as const;

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  inCard = false,
  variant = inCard ? "compact" : "default",
}: {
  icon?: IconSvgElement;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** The state sits inside a card: compact unless `variant` says otherwise. */
  inCard?: boolean;
  variant?: "default" | "compact";
}): JSX.Element {
  const sizing = EMPTY_SIZING[variant];
  return (
    <Empty className={sizing.root}>
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia className={sizing.media} variant="icon">
            <HugeiconsIcon icon={Icon} aria-hidden="true" />
          </EmptyMedia>
        ) : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
