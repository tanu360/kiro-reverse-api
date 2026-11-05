import { LockPasswordIcon } from "@hugeicons/core-free-icons";
import { type JSX, useId, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { PasswordInput } from "@/components/shared/password-input";
import { SaveFooter, SettingsRow, SubmitButton } from "@/components/shared/settings-rows";
import { updateSettings } from "@/lib/api/settings";
import { reauthenticate } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useReportDirty } from "../lib/unsaved";
import { SECTION_ID } from "./sections";
import { FieldControl, SettingsSection, toastSaveFailed } from "./settings-section";

const MIN_PASSWORD_LENGTH = 8;

export function AdminPasswordCard(): JSX.Element {
  const { t } = useT("settings");
  const confirm = useConfirm();
  const inputId = useId();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    const confirmed = await confirm({
      title: t("confirmPasswordTitle"),
      description: t("confirmPasswordBody"),
      confirmLabel: t("changePassword"),
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      await updateSettings({ password });
    } catch (caught) {
      toastSaveFailed(caught, t);
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
    toast.success(t("passwordChanged"));
    setPassword("");
    setBusy(false);
  };

  return (
    <SettingsSection
      footer={
        <SaveFooter
          action={
            // Quiet until a password is typed, like Save; it stays clickable to say one is missing.
            <SubmitButton
              blocked={busy}
              busy={busy}
              icon={LockPasswordIcon}
              primary={password !== "" || busy}
            >
              {busy ? t("changingPassword") : t("changePassword")}
            </SubmitButton>
          }
          dirty={password !== ""}
        />
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
              autoComplete="new-password"
              id={inputId}
              invalid={error !== null}
              onChange={(value) => {
                setPassword(value);
                setError(null);
              }}
              value={password}
            />
          </FieldControl>
        }
        description={t("newPasswordHint")}
        htmlFor={inputId}
        title={t("newPassword")}
      >
        {/* Lets password managers file the new password under the admin account. */}
        <input autoComplete="username" hidden name="username" readOnly value="admin" />
      </SettingsRow>
    </SettingsSection>
  );
}
