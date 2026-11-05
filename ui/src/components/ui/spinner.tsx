import { LoaderCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import type React from "react";
import { useUiT } from "@/components/ui/messages";
import { cn } from "@/lib/utils";

export function Spinner({
  className,
  ...props
}: Omit<HugeiconsIconProps, "icon">): React.ReactElement {
  const { t } = useUiT();
  return (
    <HugeiconsIcon
      aria-label={t("spinner.loading")}
      className={cn("animate-spin", className)}
      icon={LoaderCircleIcon}
      role="status"
      {...props}
    />
  );
}
