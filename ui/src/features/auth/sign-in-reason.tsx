import { CircleCheckIcon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useEffect, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useT } from "@/lib/i18n";

/** The admin's sign-in (/login) or a key holder's (/user/login). */
type SignInPage = "admin" | "user";

/**
 * Why a session ended without a sign-out: it ran out, or a backup restore replaced it, keeping
 * the backup's admin password or, with ADMIN_PASSWORD set, that one (config/backup.go
 * writeRestoredConfig).
 */
type SignInReason = "expired" | "restored" | "restoredEnvPassword";

const reasons = new Map<SignInPage, SignInReason>();

/**
 * A session that ended by itself says why on the sign-in page it leads to: the session redirect
 * marks the reason just before it goes there.
 */
export function markSignInReason(page: SignInPage, reason: SignInReason): void {
  reasons.set(page, reason);
}

/**
 * On the sign-in form: why it came here (null after a sign-out or a plain visit), and a way to
 * hide that notice (the next sign-in attempt). The mark is taken when the form mounts, so a later
 * visit to the page does not say it again.
 */
export function useSignInReason(page: SignInPage): {
  reason: SignInReason | null;
  hide: () => void;
} {
  const [reason, setReason] = useState(() => reasons.get(page) ?? null);
  useEffect(() => {
    reasons.delete(page);
  }, [page]);
  return { reason, hide: () => setReason(null) };
}

/**
 * The reason as one line above the form's button: amber for a session that ran out, green for a
 * restored backup (whose password the next sign-in needs).
 */
export function SignInReasonNotice({
  reason,
}: {
  reason: SignInReason | null;
}): JSX.Element | null {
  const { t } = useT();
  if (reason === "restored" || reason === "restoredEnvPassword") {
    return (
      <Alert data-slot="sign-in-reason" variant="success">
        <HugeiconsIcon icon={CircleCheckIcon} aria-hidden="true" />
        <AlertDescription>
          {t(reason === "restoredEnvPassword" ? "backups:restoredEnvPassword" : "backups:restored")}
        </AlertDescription>
      </Alert>
    );
  }
  if (reason === "expired") {
    return (
      <Alert data-slot="sign-in-reason" variant="warning">
        <AnimatedIcon icon={Clock01Icon} aria-hidden="true" playOnMount />
        <AlertDescription>{t("errors:sessionExpired")}</AlertDescription>
      </Alert>
    );
  }
  return null;
}
