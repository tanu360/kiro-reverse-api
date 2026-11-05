import { LoaderCircleIcon, LockPasswordIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useId, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Label } from "@/components/ui/label";
import { updateSettings } from "@/lib/api/settings";
import { reauthenticate } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useReportDirty } from "../lib/unsaved";
import { SECTION_ID } from "./sections";
import {
  FieldErrorText,
  PasswordInput,
  ROW_DESCRIPTION,
  SettingsRow,
  SettingsSection,
  SubmitButton,
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

  const describedBy = error ? `${inputId}-hint ${inputId}-error` : `${inputId}-hint`;

  return (
    <SettingsSection
      footer={
        <div className="flex w-full justify-end">
          {/* Quiet until a password is typed, like Save; it stays clickable to say one is missing. */}
          <SubmitButton blocked={busy} busy={busy} primary={password !== "" || busy}>
            <HugeiconsIcon
              aria-hidden="true"
              className={busy ? "animate-spin" : undefined}
              icon={busy ? LoaderCircleIcon : LockPasswordIcon}
            />
            {busy ? t("changingPassword") : t("changePassword")}
          </SubmitButton>
        </div>
      }
      hint={t("adminPasswordHint")}
      id={SECTION_ID.adminPassword}
      onSubmit={() => void onSubmit()}
      rows
      title={t("adminPassword")}
    >
      {/* A settings row: the name on the left, the field at the end. */}
      <SettingsRow className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
          <Label htmlFor={inputId}>{t("newPassword")}</Label>
          <p className={ROW_DESCRIPTION} id={`${inputId}-hint`}>
            {t("newPasswordHint")}
          </p>
        </div>
        {/* Lets password managers file the new password under the admin account. */}
        <input autoComplete="username" hidden name="username" readOnly value="admin" />
        <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-64">
          <PasswordInput
            autoComplete="new-password"
            describedBy={describedBy}
            id={inputId}
            invalid={error !== null}
            onChange={(value) => {
              setPassword(value);
              setError(null);
            }}
            value={password}
          />
          {error ? <FieldErrorText id={`${inputId}-error`}>{error}</FieldErrorText> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
