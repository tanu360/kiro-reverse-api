import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = "default",
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: "default" | "compact";
}): JSX.Element {
  const compact = variant === "compact";
  return (
    <Empty className={cn(compact && "gap-3 px-4 py-6 md:py-8")}>
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia className={cn(compact && "mb-3")} variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
        ) : null}
        {/* The card-title step of the type scale, not the primitive's bold 20 px. */}
        <EmptyTitle className={cn("font-semibold text-base", compact && "text-[0.9375rem]")}>
          {title}
        </EmptyTitle>
        {description ? (
          <EmptyDescription className="text-pretty leading-relaxed">{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
