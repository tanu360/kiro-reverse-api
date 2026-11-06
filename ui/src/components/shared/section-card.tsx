import type { IconSvgElement } from "@hugeicons/react";
import { type JSX, type ReactNode, useId } from "react";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardHeading,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The single card shell for page sections (Overview, API, Backups, Settings), built on the Card
 * slots so every section has the same chrome: an optional icon chip, a 15 px semibold h2, a
 * description (stacked 12 px hint, or an inline 13 px subtitle on the title's baseline), an
 * optional meta (a count or state after the title) and the actions on the right. A hairline
 * separates the header from the content and the content from the footer.
 */
export interface SectionCardProps {
  id?: string;
  icon?: IconSvgElement;
  title: string;
  description?: ReactNode;
  descriptionVariant?: "stacked" | "inline";
  /** After the title, outside the heading: a count, a size or a state badge. */
  meta?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** `danger` draws the red-tinted card with a red icon chip and title (Danger zone). */
  tone?: "default" | "danger";
  /**
   * The children sit flush in the card (no panel padding), each one under a hairline: for rows
   * that bring their own padding (settings rows, lists) and for edge-to-edge tables.
   */
  slim?: boolean;
  /** Layout classes for the panel (flex, grid, gap). Ignored when `slim`. */
  panelClassName?: string;
  /** Layout classes for the card (col-span, order, min-h). */
  className?: string;
  children: ReactNode;
}

export function SectionCard({
  id,
  icon,
  title,
  description,
  descriptionVariant = "stacked",
  meta,
  actions,
  footer,
  tone = "default",
  slim = false,
  panelClassName,
  className,
  children,
}: SectionCardProps): JSX.Element {
  const fallbackId = useId();
  const headingId = `${id ?? fallbackId}-title`;
  const danger = tone === "danger";
  return (
    <Card
      aria-labelledby={headingId}
      className={cn("@container min-w-0 scroll-mt-20", className)}
      data-slot="section-card"
      divided
      id={id}
      render={<section />}
      tone={tone}
    >
      <CardHeader icon={icon} iconTone={danger ? "danger" : "default"}>
        <CardHeading>
          <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <CardTitle
              className={cn(danger && "text-danger-foreground")}
              id={headingId}
              render={(props) => <h2 {...props} />}
            >
              {title}
            </CardTitle>
            {meta ? (
              <span className="text-meta text-muted-foreground tabular-nums" data-slot="card-meta">
                {meta}
              </span>
            ) : null}
          </div>
          {description ? (
            <CardDescription variant={descriptionVariant}>{description}</CardDescription>
          ) : null}
        </CardHeading>
        {actions ? <CardAction>{actions}</CardAction> : null}
      </CardHeader>
      {slim ? children : <CardPanel className={panelClassName}>{children}</CardPanel>}
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </Card>
  );
}

/**
 * The Settings group: a SectionCard with Settings' defaults (a stacked hint under the title and
 * flush rows split by hairlines). `badge` is the Settings name for `meta`.
 */
export function SettingsFrame({
  badge,
  meta,
  descriptionVariant = "stacked",
  slim = true,
  ...props
}: SectionCardProps & {
  /** Same as `meta`. */
  badge?: ReactNode;
}): JSX.Element {
  return (
    <SectionCard
      descriptionVariant={descriptionVariant}
      meta={meta ?? badge}
      slim={slim}
      {...props}
    />
  );
}
