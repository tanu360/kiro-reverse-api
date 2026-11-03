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
        <EmptyTitle className={cn(compact && "text-base")}>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
