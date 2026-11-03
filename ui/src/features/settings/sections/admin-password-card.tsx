import { type JSX, useId, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateSettings } from "@/lib/api/settings";
import { reauthenticate } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SECTION_ID } from "./sections";
import {
  FieldErrorText,
  PasswordInput,
  SettingsSection,
  toastSaveFailed,
} from "./settings-section";

const MIN_PASSWORD_LENGTH = 8;

export function AdminPasswordCard(): JSX.Element {
  const { t } = useT("settings");
  const confirm = useConfirm();
  const inputId = useId();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const describedBy = error ? `${inputId}-error` : undefined;

  return (
    <SettingsSection
      footer={
        <div className="flex w-full justify-end">
          <Button disabled={busy} type="submit">
            {busy ? t("changingPassword") : t("changePassword")}
          </Button>
        </div>
      }
      hint={t("adminPasswordHint")}
      id={SECTION_ID.adminPassword}
      onSubmit={() => void onSubmit()}
      title={t("adminPassword")}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId}>{t("newPassword")}</Label>
        {/* Lets password managers file the new password under the admin account. */}
        <input autoComplete="username" hidden name="username" readOnly value="admin" />
        <PasswordInput
          autoComplete="new-password"
          className="sm:max-w-sm"
          describedBy={describedBy}
          id={inputId}
          invalid={error !== null}
          onChange={(value) => {
            setPassword(value);
            setError(null);
          }}
          placeholder={t("newPasswordPlaceholder")}
          value={password}
        />
        {error ? <FieldErrorText id={`${inputId}-error`}>{error}</FieldErrorText> : null}
      </div>
    </SettingsSection>
  );
}
