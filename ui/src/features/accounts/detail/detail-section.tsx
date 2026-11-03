import { useMutation } from "@tanstack/react-query";
import { type JSX, type ReactNode, useId } from "react";
import { updateAccount } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { UpdateAccountRequest } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useInvalidateAccounts } from "../use-account-actions";

/**
 * Touch targets of at least 40 px on phones for the sheet's buttons and inputs. `max-sm`
 * because the controls' own `sm:` heights win from 640 px up. A button next to an input
 * stretches to the input's height, so the pair lines up. The input rule sizes the inner
 * `<input>`, which holds the height, through the `Input` wrapper.
 */
export const TOUCH_BUTTON = "max-sm:h-auto max-sm:min-h-10";
export const TOUCH_INPUT = "max-sm:*:data-[slot=input]:h-10 max-sm:*:data-[slot=input]:leading-10";

/** One titled block of the detail sheet. */
export function DetailSection({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col gap-3 border-t pt-5 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading font-medium text-sm" id={headingId}>
          {title}
        </h3>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * PUT one field of an account, toast "Saved" and refetch the list. Each section owns its own
 * input state, so the refetch never wipes unsaved input elsewhere in the sheet.
 */
export function useSaveAccountField(accountId: string) {
  const { t } = useT("accounts");
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (patch: UpdateAccountRequest) => updateAccount(accountId, patch),
    onSuccess: () => {
      toast.success(t("detail.saved"));
      return invalidate();
    },
    onError: (error) => {
      toast.error(t("detail.saveFailed", { reason: errorMessage(error, t) }));
    },
  });
}
