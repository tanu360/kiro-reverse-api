import { CheckIcon, LockPasswordIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, useId, useRef, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { PasswordInput } from "@/components/shared/password-input";
import { SaveFooter, SettingsRow, SubmitButton } from "@/components/shared/settings-rows";
import { useSavedFlash } from "@/hooks/use-saved-flash";
import { announce } from "@/lib/announce";
import { settingsQuery, updateSettings } from "@/lib/api/settings";
import { reauthenticate } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { useReportDirty } from "../lib/unsaved";
import { SECTION_ID } from "./sections";
import { EnvBadge, FieldControl, FooterSaveError, SettingsSection } from "./settings-section";

const MIN_PASSWORD_LENGTH = 8;

export function AdminPasswordCard(): JSX.Element {
  const { t } = useT("settings");
  const confirm = useConfirm();
  const inputId = useId();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The button reads "Saved" for a moment after a change; a failure shows over it.
  const [failure, setFailure] = useState<unknown>(null);
  const changed = useSavedFlash();
  const submitRef = useRef<HTMLButtonElement>(null);
  // A typed, unsent password counts as an unsaved change.
  useReportDirty(SECTION_ID.adminPassword, password !== "");

  const onSubmit = async () => {
    if (busy) return;
    // The server ignores an empty password, so one is never sent.
    if (!password) {
      setError(t("passwordRequired"));
      return;
    }
    // Code points, like the server's rune count.
    if ([...password].length < MIN_PASSWORD_LENGTH) {
      setError(t("passwordTooShort"));
      return;
    }
    // Try again after a failure sends it at once: the change was already confirmed.
    if (failure === null) {
      const confirmed = await confirm({
        title: t("confirmPasswordTitle"),
        description: t("confirmPasswordBody"),
        confirmLabel: t("changePassword"),
      });
      if (!confirmed) return;
    }

    setBusy(true);
    setFailure(null);
    changed.clear();
    try {
      await updateSettings({ password });
    } catch (caught) {
      setFailure(caught);
      setBusy(false);
      return;
    }
    try {
      // The server revoked every session, this one included. Sign in again at once with the
      // same "Stay signed in" choice; the session change restarts the event stream.
      await reauthenticate(password);
    } catch {
      // reauthenticate cleared the session as expired, and the app goes to sign-in.
      setBusy(false);
      return;
    }
    announce(t("passwordChanged"));
    changed.flash();
    setPassword("");
    setBusy(false);
  };

  const done = changed.saved && password === "" && !busy;
  // main.go puts ADMIN_PASSWORD's password back at every start.
  const fromEnv = useQuery(settingsQuery()).data?.adminPasswordFromEnv === true;

  return (
    <SettingsSection
      footer={
        <>
          {failure !== null ? (
            <FooterSaveError
              error={failure}
              onDismiss={() => setFailure(null)}
              saveRef={submitRef}
            />
          ) : null}
          <SaveFooter
            action={
              // Quiet until a password is typed, like Save; it stays clickable to say one is
              // missing. Just changed, it reads "Saved" with a tick for a moment.
              <SubmitButton
                blocked={busy}
                busy={busy}
                icon={done ? null : LockPasswordIcon}
                primary={password !== "" || busy}
                ref={submitRef}
              >
                {busy ? (
                  t("changingPassword")
                ) : done ? (
                  <>
                    <HugeiconsIcon
                      icon={CheckIcon}
                      aria-hidden="true"
                      className="text-success-foreground"
                    />
                    {t("common:actions.saved")}
                  </>
                ) : (
                  t("changePassword")
                )}
              </SubmitButton>
            }
            dirty={password !== ""}
          />
        </>
      }
      hint={t("adminPasswordHint")}
      id={SECTION_ID.adminPassword}
      onSubmit={() => void onSubmit()}
      title={t("adminPassword")}
    >
      <SettingsRow
        control={
          <FieldControl error={error}>
            <PasswordInput
              maxLength={128}
              autoComplete="new-password"
              id={inputId}
              invalid={error !== null}
              onChange={(value) => {
                setPassword(value);
                setError(null);
                setFailure(null);
                changed.clear();
              }}
              value={password}
            />
          </FieldControl>
        }
        description={
          fromEnv
            ? t("common:text.joinSentences", {
                first: t("newPasswordHint"),
                second: t("adminPasswordEnvNote"),
              })
            : t("newPasswordHint")
        }
        htmlFor={inputId}
        status={fromEnv ? <EnvBadge name="ADMIN_PASSWORD" /> : undefined}
        title={t("newPassword")}
      >
        {/* Lets password managers file the new password under the admin account. */}
        <input autoComplete="username" hidden name="username" readOnly value="admin" />
      </SettingsRow>
    </SettingsSection>
  );
}
