import { Loader2Icon } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/utils";
import { useUiT } from "@/components/ui/messages";

export function Spinner({
  className,
  ...props
}: React.ComponentProps<typeof Loader2Icon>): React.ReactElement {
  const { t } = useUiT();
  return (
    <Loader2Icon
      aria-label={t("spinner.loading")}
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}
