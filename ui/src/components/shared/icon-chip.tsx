import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { cn } from "@/lib/utils";

/**
 * The small rounded tile that carries an icon: card headers, list rows and choice rows. It sits
 * one step above the card (--surface-2) under a hairline, with the icon in the muted colour.
 * `danger` tints it red for destructive sections.
 */
const iconChipVariants = cva(
  "flex shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-2 text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "sm",
      tone: "default",
    },
    variants: {
      size: {
        sm: "size-7 [&_svg]:size-4",
        md: "size-9 [&_svg]:size-4",
        // A dialog's heading mark (the add-account steps): 44 px, a 24 px mark.
        lg: "size-11 rounded-xl [&_svg]:size-6",
      },
      tone: {
        default: "",
        danger: "border-destructive/24 bg-error-surface text-destructive-foreground",
      },
    },
  },
);

type IconChipProps = Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof iconChipVariants> & {
    /** The icon to draw. Decorative: the chip is hidden from assistive tech. */
    icon?: IconSvgElement;
    /** A mark that is not a Hugeicons icon (a brand logo), drawn instead of `icon`. */
    children?: React.ReactNode;
  };

export function IconChip({
  icon,
  children,
  size,
  tone,
  className,
  ...props
}: IconChipProps): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(iconChipVariants({ size, tone }), className)}
      data-slot="icon-chip"
      data-tone={tone ?? "default"}
      {...props}
    >
      {icon ? <HugeiconsIcon icon={icon} /> : children}
    </span>
  );
}
