import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { queryKeys } from "@/lib/api/query-keys";
import { useAdminEvent } from "@/lib/events/admin-events";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SECTION_ID } from "./sections/sections";

/** One halt notice at a time; a recovery or a resume closes it. */
export const HALTED_TOAST_ID = "self-heal-halted";

/**
 * Turns the server's account_heal events into toasts on every page: an info toast when a heal
 * brought accounts back, and a warning that stays until it is closed, the pool recovers or an
 * admin resumes, when self-heal stopped. Every event refetches the self-heal card, the account
 * list and the status counts. Renders nothing.
 */
export function AccountHealNotices(): null {
  const { t } = useT("settings");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useAdminEvent("account_heal", (event) => {
    for (const queryKey of [queryKeys.settings.all, queryKeys.accounts.list(), queryKeys.status]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    const [kind, value] = (event.payload ?? "").split(":");
    const count = Number(value);
    switch (kind) {
      case "healed":
        if (Number.isInteger(count) && count > 0) {
          toast.info(t("selfHeal.toastHealed", { count }));
        }
        break;
      case "halted":
        toast.warning(t("selfHeal.toastHalted"), {
          id: HALTED_TOAST_ID,
          duration: 0,
          background: true,
          action: {
            label: t("selfHeal.open"),
            onClick: () => void navigate({ to: "/settings", hash: SECTION_ID.selfHeal }),
          },
        });
        break;
      case "recovered":
      case "resumed":
        toast.dismiss(HALTED_TOAST_ID);
        break;
    }
  });

  return null;
}
