import {
  Alert02Icon,
  InformationCircleIcon,
  Key01Icon,
  LockPasswordIcon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type JSX, useId, useState } from "react";
import { Code } from "@/components/shared/code";
import { CopyButton } from "@/components/shared/copy-button";
import { PasswordInput } from "@/components/shared/password-input";
import { SettingsRow } from "@/components/shared/settings-rows";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage, serverErrorCode } from "@/lib/api/server-errors";
import {
  disableTwoFactor,
  enableTwoFactor,
  replaceRecoveryCodes,
  startTwoFactorSetup,
  type TwoFactorProof,
  type TwoFactorSetup,
  type TwoFactorStatus,
  twoFactorQuery,
} from "@/lib/api/two-factor";
import { formatDateTime } from "@/lib/format";
import { fillNodes, useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SECTION_ID } from "./sections";
import { SectionQuery, SettingsGroup } from "./settings-section";

/** Settings card for admin two-factor sign-in with an authenticator app. */
export function TwoFactorCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(twoFactorQuery());
  return (
    <SectionQuery id={SECTION_ID.twoFactor} query={query} title={t("twoFactor.title")}>
      {(status) => <TwoFactorPanel status={status} />}
    </SectionQuery>
  );
}

type DialogState =
  | { kind: "setup"; session: number }
  | { kind: "disable"; session: number }
  | { kind: "codes"; session: number }
  | null;

function TwoFactorPanel({ status }: { status: TwoFactorStatus }): JSX.Element {
  const { t, lang } = useT("settings");
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [session, setSession] = useState(0);
  const open = (kind: "setup" | "disable" | "codes") => {
    setSession((value) => value + 1);
    setDialog({ kind, session: session + 1 });
  };
  const close = () => setDialog(null);
  const refresh = (next?: TwoFactorStatus) => {
    if (next) queryClient.setQueryData(queryKeys.settings.twoFactor(), next);
    void queryClient.invalidateQueries({ queryKey: queryKeys.settings.twoFactor() });
  };

  return (
    <SettingsGroup
      badge={
        <Badge dot size="sm" tone={status.enabled ? "success" : "neutral"}>
          {status.enabled ? t("twoFactor.on") : t("twoFactor.off")}
        </Badge>
      }
      description={t("twoFactor.hint")}
      id={SECTION_ID.twoFactor}
      title={t("twoFactor.title")}
    >
      {status.enabled ? (
        <>
          <SettingsRow
            control={
              <Button onClick={() => open("disable")} size="sm" variant="danger">
                {t("twoFactor.turnOff")}
              </Button>
            }
            controlWidth="auto"
            description={
              status.enabledAt
                ? t("twoFactor.onSince", {
                    time: formatDateTime(Math.floor(status.enabledAt / 1000), lang),
                  })
                : t("twoFactor.onHint")
            }
            title={t("twoFactor.signIn")}
          />
          <SettingsRow
            control={
              <Button onClick={() => open("codes")} size="sm" variant="secondary">
                <HugeiconsIcon icon={Key01Icon} aria-hidden="true" />
                {t("twoFactor.newCodes")}
              </Button>
            }
            controlWidth="auto"
            description={t("twoFactor.codesLeft", { count: status.recoveryCodesLeft })}
            title={t("twoFactor.recoveryTitle")}
          >
            {status.recoveryCodesLeft <= 2 ? (
              <Alert className="mt-1 w-fit max-w-2xl" role="note" size="sm" variant="warning">
                <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
                <AlertDescription>{t("twoFactor.codesLow")}</AlertDescription>
              </Alert>
            ) : null}
          </SettingsRow>
        </>
      ) : (
        <SettingsRow
          control={
            <Button
              disabled={status.resetByEnv}
              onClick={() => open("setup")}
              size="sm"
              variant="secondary"
            >
              <HugeiconsIcon icon={SecurityCheckIcon} aria-hidden="true" />
              {t("twoFactor.turnOn")}
            </Button>
          }
          controlWidth="auto"
          description={t("twoFactor.offHint")}
          title={t("twoFactor.signIn")}
        >
          {status.resetByEnv ? (
            <Alert className="mt-1 w-fit max-w-2xl" role="note" size="sm" variant="info">
              <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
              <AlertDescription>{t("twoFactor.resetByEnv")}</AlertDescription>
            </Alert>
          ) : null}
        </SettingsRow>
      )}
      <p className="px-4 pb-4 text-muted-foreground text-xs sm:px-6">
        {fillNodes(t("twoFactor.lockoutNote"), { env: <Code>ADMIN_RESET_2FA=1</Code> })}
      </p>

      <Dialog
        onOpenChange={(next) => {
          if (!next) close();
        }}
        open={dialog !== null}
      >
        {dialog?.kind === "setup" ? (
          <SetupDialog key={dialog.session} onDone={(next) => refresh(next)} />
        ) : null}
        {dialog?.kind === "disable" ? (
          <DisableDialog
            key={dialog.session}
            onDone={(next) => {
              refresh(next);
              close();
            }}
          />
        ) : null}
        {dialog?.kind === "codes" ? (
          <NewCodesDialog key={dialog.session} onDone={(next) => refresh(next)} />
        ) : null}
      </Dialog>
    </SettingsGroup>
  );
}

/** "That code is not right" and its kin, or the usual error text. */
function codeError(error: unknown, t: (key: string) => string): string {
  const code = serverErrorCode(error);
  if (code === "totp_invalid") return t("twoFactor.codeWrong");
  if (code === "totp_reused") return t("errors:serverError.totpReused");
  return errorMessage(error, t as never);
}

/**
 * The six-digit field the dialogs share. It keeps digits only, at most six: a letter never shows,
 * and a code pasted as "123 456" lands as "123456".
 */
function CodeInput({
  id,
  value,
  onChange,
  error,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  label: string;
}): JSX.Element {
  const { t } = useT("settings");
  return (
    <Field className="min-w-0 items-stretch" invalid={error !== null}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        autoComplete="one-time-code"
        autoFocus
        id={id}
        inputMode="numeric"
        maxLength={9}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder={t("twoFactor.codePlaceholder")}
        spellCheck={false}
        value={value}
        variant="code"
      />
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}

/** The codes, shown once, with Copy and Download. */
function RecoveryCodes({ codes }: { codes: string[] }): JSX.Element {
  const { t } = useT("settings");
  const text = codes.join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "kiro-proxy-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-3">
      <Alert role="note" size="sm" variant="warning">
        <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
        <AlertDescription>{t("twoFactor.codesOnce")}</AlertDescription>
      </Alert>
      <ul
        aria-label={t("twoFactor.recoveryTitle")}
        className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border-subtle bg-surface-2 p-4 font-mono text-sm tabular-nums"
        translate="no"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton
          copiedMessage={t("twoFactor.codesCopied")}
          label={t("twoFactor.copyCodes")}
          showLabel
          value={text}
        />
        <Button onClick={download} size="sm" type="button" variant="secondary">
          {t("twoFactor.downloadCodes")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Turning it on: the QR code and the secret, then a code from the app to confirm, then the
 * recovery codes, shown once.
 */
function SetupDialog({ onDone }: { onDone: (status: TwoFactorStatus) => void }): JSX.Element {
  const { t } = useT("settings");
  const codeId = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const setup = useQuery({
    queryKey: ["two-factor-setup"],
    queryFn: startTwoFactorSetup,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
  const enable = useMutation({
    mutationFn: (value: string) => enableTwoFactor(value),
    onSuccess: (result) => {
      setCodes(result.recoveryCodes);
      onDone(result.status);
      toast.success(t("twoFactor.enabled"));
    },
    onError: (caught) => setError(codeError(caught, t)),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (enable.isPending) return;
    if (!/^\d{6}$/.test(code.replace(/[\s-]/g, ""))) {
      setError(t("twoFactor.codeInvalid"));
      return;
    }
    enable.mutate(code);
  };

  if (codes) {
    return (
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("twoFactor.codesTitle")}</DialogTitle>
          <DialogDescription>{t("twoFactor.codesHint")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RecoveryCodes codes={codes} />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button />}>{t("twoFactor.codesSaved")}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    );
  }

  return (
    <DialogPopup className="sm:max-w-lg">
      <form className="contents" noValidate onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t("twoFactor.setupTitle")}</DialogTitle>
          <DialogDescription>{t("twoFactor.setupHint")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {setup.isError ? (
            <Alert role="alert" size="sm" variant="error">
              <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
              <AlertDescription>{errorMessage(setup.error, t)}</AlertDescription>
            </Alert>
          ) : (
            <SetupSecret setup={setup.data} />
          )}
          <CodeInput
            error={error}
            id={codeId}
            label={t("twoFactor.confirmCode")}
            onChange={(value) => {
              setCode(value);
              setError(null);
            }}
            value={code}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <Button
            disabled={!setup.data}
            loading={enable.isPending}
            loadingText={t("twoFactor.enabling")}
            type="submit"
          >
            <HugeiconsIcon icon={SecurityCheckIcon} aria-hidden="true" />
            {t("twoFactor.turnOn")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}

/**
 * The QR code and the secret to type. The SVG paints its own white quiet zone, so it reads
 * dark-on-light for a scanner in both themes.
 */
function SetupSecret({ setup }: { setup?: TwoFactorSetup }): JSX.Element {
  const { t } = useT("settings");
  const grouped = setup?.secret.replace(/(.{4})/g, "$1 ").trim() ?? "";
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div className="size-44 shrink-0 overflow-hidden rounded-lg border border-border-subtle">
        {setup ? (
          <img
            alt={t("twoFactor.qrAlt")}
            className="size-full [image-rendering:pixelated]"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 self-stretch">
        <p className="text-muted-foreground text-xs">{t("twoFactor.secretHint")}</p>
        <div className="flex items-center gap-1">
          <code
            className="min-w-0 flex-1 rounded-md bg-surface-2 px-2 py-1.5 font-mono text-sm wrap-anywhere"
            translate="no"
          >
            {grouped || "…"}
          </code>
          {setup ? (
            <CopyButton
              copiedMessage={t("twoFactor.secretCopied")}
              label={t("twoFactor.copySecret")}
              size="icon-sm"
              value={setup.secret}
            />
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">
          {t("twoFactor.accountName", { issuer: setup?.issuer ?? "Kiro Proxy" })}
        </p>
      </div>
    </div>
  );
}

/** Turning it off: a current code, or the password when the phone is not at hand. */
function DisableDialog({ onDone }: { onDone: (status: TwoFactorStatus) => void }): JSX.Element {
  const { t } = useT("settings");
  const codeId = useId();
  const passwordId = useId();
  const [withPassword, setWithPassword] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const disable = useMutation({
    mutationFn: (proof: TwoFactorProof) => disableTwoFactor(proof),
    onSuccess: (status) => {
      toast.success(t("twoFactor.disabled"));
      onDone(status);
    },
    onError: (caught) =>
      setError(
        serverErrorCode(caught) === "admin_password_wrong"
          ? t("twoFactor.passwordWrong")
          : codeError(caught, t),
      ),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disable.isPending) return;
    if (withPassword ? !password : !code.trim()) {
      setError(withPassword ? t("twoFactor.passwordRequired") : t("twoFactor.codeInvalid"));
      return;
    }
    disable.mutate(withPassword ? { password } : { code });
  };
  return (
    <DialogPopup className="sm:max-w-md">
      <form className="contents" noValidate onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t("twoFactor.disableTitle")}</DialogTitle>
          <DialogDescription>{t("twoFactor.disableHint")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {withPassword ? (
            <Field className="min-w-0 items-stretch" invalid={error !== null}>
              <FieldLabel htmlFor={passwordId}>{t("twoFactor.password")}</FieldLabel>
              <PasswordInput
                autoComplete="current-password"
                id={passwordId}
                invalid={error !== null}
                onChange={(value) => {
                  setPassword(value);
                  setError(null);
                }}
                value={password}
              />
              {error ? <FieldError match>{error}</FieldError> : null}
            </Field>
          ) : (
            <CodeInput
              error={error}
              id={codeId}
              label={t("twoFactor.currentCode")}
              onChange={(value) => {
                setCode(value);
                setError(null);
              }}
              value={code}
            />
          )}
          <Button
            className="self-start"
            onClick={() => {
              setWithPassword((current) => !current);
              setError(null);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            {withPassword ? (
              t("twoFactor.useCodeInstead")
            ) : (
              <>
                <HugeiconsIcon icon={LockPasswordIcon} aria-hidden="true" />
                {t("twoFactor.usePasswordInstead")}
              </>
            )}
          </Button>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <Button
            loading={disable.isPending}
            loadingText={t("twoFactor.disabling")}
            type="submit"
            variant="destructive"
          >
            {t("twoFactor.turnOff")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}

/** New recovery codes on a current code; the old ones stop working. */
function NewCodesDialog({ onDone }: { onDone: (status: TwoFactorStatus) => void }): JSX.Element {
  const { t } = useT("settings");
  const codeId = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const replace = useMutation({
    mutationFn: (value: string) => replaceRecoveryCodes(value),
    onSuccess: (result) => {
      setCodes(result.recoveryCodes);
      onDone(result.status);
    },
    onError: (caught) => setError(codeError(caught, t)),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (replace.isPending) return;
    if (!code.trim()) {
      setError(t("twoFactor.codeInvalid"));
      return;
    }
    replace.mutate(code);
  };
  if (codes) {
    return (
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("twoFactor.codesTitle")}</DialogTitle>
          <DialogDescription>{t("twoFactor.newCodesDone")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RecoveryCodes codes={codes} />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button />}>{t("twoFactor.codesSaved")}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    );
  }
  return (
    <DialogPopup className="sm:max-w-md">
      <form className="contents" noValidate onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t("twoFactor.newCodesTitle")}</DialogTitle>
          <DialogDescription>{t("twoFactor.newCodesHint")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <CodeInput
            error={error}
            id={codeId}
            label={t("twoFactor.currentCode")}
            onChange={(value) => {
              setCode(value);
              setError(null);
            }}
            value={code}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common:actions.cancel")}
          </DialogClose>
          <Button loading={replace.isPending} type="submit">
            <HugeiconsIcon icon={Key01Icon} aria-hidden="true" />
            {t("twoFactor.newCodes")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
