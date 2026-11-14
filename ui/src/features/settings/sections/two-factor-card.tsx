import { Input as InputPrimitive } from "@base-ui/react/input";
import {
  Alert02Icon,
  InformationCircleIcon,
  Key01Icon,
  LockPasswordIcon,
  SecurityCheckIcon,
  ShieldKeyIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
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
import { cn } from "@/lib/utils";
import { SECTION_ID } from "./sections";
import { SectionQuery, SettingsGroup } from "./settings-section";
import { parseQrSvg, StyledQr } from "./styled-qr";

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

/** A code from the app has six digits. */
const CODE_LENGTH = 6;

/**
 * The six-digit field the dialogs share: six boxes over one real input, so typing, a phone's
 * code autofill and a paste all land in one field with one label. It keeps digits only, at most
 * six: a letter never shows, and a code pasted as "123 456" lands as "123456". A wrong code
 * shakes the boxes once (not under reduced motion).
 */
function CodeInput({
  id,
  value,
  onChange,
  error,
  label,
  hideLabel = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  label: string;
  /** The setup dialog's field, whose step title above already says it: screen readers only. */
  hideLabel?: boolean;
}): JSX.Element {
  const [focused, setFocused] = useState(false);
  // Bumped by each new error, so the boxes remount and shake again; the input keeps its focus.
  const [shake, setShake] = useState(0);
  useEffect(() => {
    if (error) setShake((count) => count + 1);
  }, [error]);
  const active = Math.min(value.length, CODE_LENGTH - 1);
  return (
    <Field className="min-w-0 items-stretch" invalid={error !== null}>
      <FieldLabel className={cn(hideLabel && "sr-only")} htmlFor={id}>
        {label}
      </FieldLabel>
      <div className="relative">
        <InputPrimitive
          autoComplete="one-time-code"
          autoFocus
          className="absolute inset-0 z-10 size-full cursor-text bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent"
          id={id}
          inputMode="numeric"
          maxLength={9}
          onBlur={() => setFocused(false)}
          onChange={(event) =>
            onChange(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
          }
          onFocus={() => setFocused(true)}
          spellCheck={false}
          value={value}
        />
        <div
          aria-hidden="true"
          className={cn("grid grid-cols-6 gap-2", shake > 0 && error && "animate-otp-shake")}
          key={shake}
        >
          {Array.from({ length: CODE_LENGTH }, (_, index) => {
            const digit = value[index];
            const current = focused && index === active && value.length < CODE_LENGTH;
            return (
              <div
                className={cn(
                  "flex h-12 items-center justify-center rounded-lg border bg-field font-mono text-foreground text-xl tabular-nums transition-[border-color,box-shadow] duration-150",
                  error
                    ? "border-destructive/64"
                    : current || (focused && value.length === CODE_LENGTH && index === active)
                      ? "border-field-border-focus ring-2 ring-primary/24"
                      : "border-field-border",
                )}
                // biome-ignore lint/suspicious/noArrayIndexKey: the boxes are fixed positions.
                key={index}
              >
                {digit ??
                  (current ? (
                    <span className="h-5 w-px bg-foreground motion-safe:animate-pulse" />
                  ) : (
                    <span className="size-1 rounded-full bg-muted-foreground/40" />
                  ))}
              </div>
            );
          })}
        </div>
      </div>
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
    <DialogPopup className="sm:max-w-xl">
      <form className="contents" noValidate onSubmit={submit}>
        <DialogHeader>
          {/* The sheet headers' tile: the shield in a soft purple square beside the title. */}
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-info-foreground ring-1 ring-primary/20"
            >
              <HugeiconsIcon className="size-5" icon={ShieldKeyIcon} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle>{t("twoFactor.setupTitle")}</DialogTitle>
              <DialogDescription>{t("twoFactor.setupHint")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-6">
          <SetupStep description={t("twoFactor.apps")} number={1} title={t("twoFactor.stepScan")}>
            {setup.isError ? (
              <Alert role="alert" size="sm" variant="error">
                <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
                <AlertDescription>{errorMessage(setup.error, t)}</AlertDescription>
              </Alert>
            ) : (
              <SetupSecret setup={setup.data} />
            )}
          </SetupStep>
          <SetupStep number={2} title={t("twoFactor.stepCode")}>
            <CodeInput
              error={error}
              id={codeId}
              hideLabel
              label={t("twoFactor.confirmCode")}
              onChange={(value) => {
                setCode(value);
                setError(null);
              }}
              value={code}
            />
          </SetupStep>
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

/** One numbered step of the setup dialog: a purple number, its title, then its content. */
function SetupStep({
  number,
  title,
  description,
  children,
}: {
  number: number;
  title: string;
  description?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 font-medium text-sm">
          <span
            aria-hidden="true"
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs tabular-nums"
          >
            {number}
          </span>
          {title}
        </h3>
        {description ? <p className="ps-7 text-muted-foreground text-xs">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The QR code and the key to type. The code is drawn in the app's style (StyledQr) in a soft
 * purple frame: dark modules on white in the light theme, inverted in the dark one, where "Use a
 * light code" brings the white one back for a scanner that reads dark-on-light only. A QR the
 * styling cannot read is shown as the server drew it.
 */
function SetupSecret({ setup }: { setup?: TwoFactorSetup }): JSX.Element {
  const { t } = useT("settings");
  const [light, setLight] = useState(false);
  const modules = useMemo(() => (setup ? parseQrSvg(setup.qrSvg) : null), [setup]);
  let qr: JSX.Element;
  if (!setup) qr = <Skeleton className="size-full rounded-xl" />;
  else if (modules) qr = <StyledQr label={t("twoFactor.qrAlt")} modules={modules} />;
  else {
    qr = (
      <img
        alt={t("twoFactor.qrAlt")}
        className="size-full rounded-xl [image-rendering:pixelated]"
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`}
      />
    );
  }
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <div className="flex shrink-0 flex-col items-center gap-2">
        <div
          className={cn(
            "size-52 rounded-2xl bg-linear-to-br from-primary/30 via-primary/10 to-primary/5 p-1.5 shadow-sm",
            light && "qr-light",
          )}
        >
          {qr}
        </div>
        {/* Only the dark theme draws the inverted code, so only it offers the light one. */}
        {modules ? (
          <p className="hidden text-muted-foreground text-xs dark:block">
            <Button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setLight((on) => !on)}
              type="button"
              variant="link-inline"
            >
              {light ? t("twoFactor.qrDark") : t("twoFactor.qrLight")}
            </Button>
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 self-stretch sm:justify-center">
        <p className="text-muted-foreground text-xs">{t("twoFactor.secretHint")}</p>
        <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface-2 py-1 ps-3 pe-1">
          {/* The key as the app takes it: one word, the body font, so nothing is retyped wrong. */}
          <span className="min-w-0 flex-1 py-1 text-sm break-all" translate="no">
            {setup?.secret ?? "…"}
          </span>
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
