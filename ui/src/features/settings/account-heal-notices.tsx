import { Alert02Icon, ArrowRight02Icon, XIcon } from "@hugeicons/core-free-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { NoticeIconButton, NoticeLine } from "@/components/shared/notice-line";
import { announce } from "@/lib/announce";
import { queryKeys } from "@/lib/api/query-keys";
import { useAdminEvent } from "@/lib/events/admin-events";
import { useT } from "@/lib/i18n";
import { SECTION_ID, sectionPagePath } from "./sections/sections";

const SELF_HEAL_PATH = sectionPagePath(SECTION_ID.selfHeal);

/**
 * The server's account_heal events, on every page (it sits at the top of the app shell's
 * content). Every event refetches the self-heal card, the account list and the status counts. A
 * heal that brought accounts back is read out to screen readers (the lists update themselves).
 * When self-heal stops, a one-line warning stays at the top of the page, with a way to the
 * self-heal settings, until it is closed, the pool recovers or an admin resumes. It hides on the
 * settings page with the self-heal card, which says the same with its Resume.
 */
export function AccountHealNotices(): JSX.Element | null {
  const { t } = useT("settings");
  const { t: tc } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [halted, setHalted] = useState(false);
  const onSelfHealPage = useRouterState({
    select: (state) => state.location.pathname.replace(/\/+$/, "") === SELF_HEAL_PATH,
  });

  useAdminEvent("account_heal", (event) => {
    for (const queryKey of [queryKeys.settings.all, queryKeys.accounts.list(), queryKeys.status]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    const [kind, value] = (event.payload ?? "").split(":");
    const count = Number(value);
    switch (kind) {
      case "healed":
        if (Number.isInteger(count) && count > 0) {
          announce(t("selfHeal.healedCount", { count }));
        }
        break;
      case "halted":
        setHalted(true);
        break;
      case "recovered":
      case "resumed":
        setHalted(false);
        break;
    }
  });

  if (!halted || onSelfHealPage) return null;
  return (
    <NoticeLine
      actions={
        <>
          <NoticeIconButton
            icon={ArrowRight02Icon}
            label={t("selfHeal.open")}
            onClick={() => void navigate({ to: SELF_HEAL_PATH, hash: SECTION_ID.selfHeal })}
          />
          <NoticeIconButton
            icon={XIcon}
            label={tc("actions.close")}
            onClick={() => {
              setHalted(false);
              // The close button goes with the notice: focus stays on the page, not the body.
              document.getElementById("main")?.focus();
            }}
          />
        </>
      }
      data-slot="self-heal-halted"
      icon={Alert02Icon}
      variant="warning"
    >
      {t("selfHeal.haltedNotice")}
    </NoticeLine>
  );
}
