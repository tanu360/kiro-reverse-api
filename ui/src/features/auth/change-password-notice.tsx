import { ArrowRight02Icon, InformationCircleIcon, XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type JSX, useEffect, useSyncExternalStore } from "react";
import {
  NOTICE_ACTIONS_CLASS,
  NOTICE_LINE_CLASS,
  NoticeIconButton,
} from "@/components/shared/notice-line";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { SECTION_ID, sectionPagePath } from "@/features/settings/sections/sections";
import { subscribeSession } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";

let shown = false;
const listeners = new Set<() => void>();

function setShown(next: boolean): void {
  if (shown === next) return;
  shown = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/**
 * After a sign-in with the generated first-run password (/setup): the hint to change it, shown
 * over the page the sign-in leads to. It goes when it is closed, once Settings is opened, and when
 * this session ends, so it never waits on the sign-in page or comes back with the next session.
 */
export function showChangePasswordNotice(): void {
  setShown(true);
  const stop = subscribeSession((session) => {
    if (session) return;
    setShown(false);
    stop();
  });
}

/**
 * The hint as one line at the top of the page, in the app shell: an arrow to the admin password
 * in Settings, and close. Nothing while it is not wanted, or on Settings, which it points to.
 */
export function ChangePasswordNotice(): JSX.Element | null {
  const { t } = useT("auth");
  const { t: tc } = useT();
  const navigate = useNavigate();
  const visible = useSyncExternalStore(subscribe, () => shown);
  const onSettings = useRouterState({
    select: (state) => isSettingsPath(state.location.pathname),
  });

  // It has nothing to add once Settings is open: it does not come back after. Also when the
  // sign-in itself led to Settings, where it is asked for after this page mounted.
  useEffect(() => {
    if (onSettings && visible) setShown(false);
  }, [onSettings, visible]);

  if (!visible || onSettings) return null;
  return (
    <Alert
      className={NOTICE_LINE_CLASS}
      data-slot="change-password-notice"
      role="status"
      variant="info"
    >
      <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
      <AlertDescription>{t("changePasswordToast")}</AlertDescription>
      <AlertAction className={NOTICE_ACTIONS_CLASS}>
        <NoticeIconButton
          icon={ArrowRight02Icon}
          label={t("openSettings")}
          onClick={() =>
            void navigate({
              to: sectionPagePath(SECTION_ID.adminPassword),
              hash: SECTION_ID.adminPassword,
            })
          }
        />
        <NoticeIconButton
          icon={XIcon}
          label={tc("actions.close")}
          onClick={() => {
            setShown(false);
            // The close button goes with the notice: focus stays on the page, not the body.
            document.getElementById("main")?.focus();
          }}
        />
      </AlertAction>
    </Alert>
  );
}
