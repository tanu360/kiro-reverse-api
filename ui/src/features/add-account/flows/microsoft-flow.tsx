import { type FormEvent, type JSX, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  cancelMicrosoftSso,
  completeMicrosoftSso,
  selectMicrosoftProfile,
  startMicrosoftSso,
} from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import type { KiroProfile, MicrosoftSelectProfileResponse } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { FormField, HelpText, UrlBox } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";

type Stage = "idle" | "kiro" | "microsoft" | "profile";

/**
 * Microsoft Entra ID sign-in: the Kiro portal leg, the Microsoft leg, then a Kiro profile
 * choice when the account has several. The server keeps the login; the dialog cancels it on
 * every exit, and a response that lands after an exit is dropped and its session canceled.
 */
export function MicrosoftFlow(): JSX.Element {
  const { t } = useT("add-account");
  const display = useDisplayEmail();
  const { sessions, finishAdd } = useFlow();
  const formId = useFormId();
  const [stage, setStage] = useState<Stage>("idle");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [profiles, setProfiles] = useState<KiroProfile[]>([]);
  const [selectedArn, setSelectedArn] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The state update lands a render later; the ref blocks a second submit right away.
  const busyRef = useRef(false);
  useReportBusy(busy);

  const step = async <T,>(request: () => Promise<T>, apply: (res: T) => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const generation = sessions.generation;
    try {
      const res = await request();
      if (!sessions.isCurrent(generation)) {
        const late = (res ?? {}) as { sessionId?: string; selectionId?: string };
        if (late.sessionId || late.selectionId) {
          void cancelMicrosoftSso({
            sessionId: late.sessionId ?? "",
            selectionId: late.selectionId ?? "",
          });
        }
        return;
      }
      apply(res);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("failed", { error: errorMessage(error, t) }));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const done = (res: MicrosoftSelectProfileResponse) => {
    // The server closed the login when it saved the account; there is nothing to cancel.
    sessions.microsoftSessionId = "";
    sessions.microsoftSelectionId = "";
    toast.success(t("success", { name: display(res.account.email, res.account.id) }));
    if (res.warning) toast.warning(res.warning);
    finishAdd([res.account]);
  };

  const start = () =>
    step(startMicrosoftSso, (res) => {
      sessions.microsoftSessionId = res.sessionId;
      setAuthorizeUrl(res.authorizeUrl);
      setCallbackUrl("");
      setStage("kiro");
    });

  const complete = () => {
    const callback = callbackUrl.trim();
    if (!callback) {
      setFieldError(t("callbackRequired"));
      return;
    }
    setFieldError(null);
    return step(
      () => completeMicrosoftSso({ sessionId: sessions.microsoftSessionId, callbackUrl: callback }),
      (res) => {
        if (res.stage === "complete") {
          done(res);
        } else if (res.stage === "profile") {
          sessions.microsoftSelectionId = res.selectionId;
          setProfiles(res.profiles ?? []);
          setSelectedArn(res.profiles?.[0]?.arn ?? "");
          setStage("profile");
        } else {
          setAuthorizeUrl(res.authorizeUrl);
          setCallbackUrl("");
          setStage("microsoft");
        }
      },
    );
  };

  const selectProfile = () => {
    if (!selectedArn) {
      setFieldError(t("microsoft.profileRequired"));
      return;
    }
    setFieldError(null);
    return step(
      () =>
        selectMicrosoftProfile({
          selectionId: sessions.microsoftSelectionId,
          profileArn: selectedArn,
        }),
      done,
    );
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (stage === "idle") void start();
    else if (stage === "profile") void selectProfile();
    else void complete();
  };

  const submitLabel =
    stage === "idle"
      ? t("startSignIn")
      : stage === "profile"
        ? t("microsoft.selectProfile")
        : t("completeSignIn");

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      {stage === "profile" ? (
        <Field className="w-full" invalid={Boolean(fieldError)}>
          <FieldLabel>{t("microsoft.profileLabel")}</FieldLabel>
          <HelpText>{t("microsoft.selectProfileDesc")}</HelpText>
          <RadioGroup
            aria-label={t("microsoft.profileLabel")}
            className="w-full gap-2"
            disabled={busy}
            onValueChange={(value) => setSelectedArn(String(value))}
            value={selectedArn}
          >
            {profiles.map((profile) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI Radio inside is the control.
              <label
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-primary has-data-checked:bg-accent/40"
                key={profile.arn}
              >
                <Radio className="mt-0.5" value={profile.arn} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="break-all font-medium text-sm">
                    {profile.name || profile.arn}
                  </span>
                  <span className="text-muted-foreground text-xs">{profile.region}</span>
                  {profile.name ? (
                    <span className="break-all font-mono text-muted-foreground text-xs">
                      {profile.arn}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </RadioGroup>
          <FieldError match={Boolean(fieldError)}>{fieldError}</FieldError>
        </Field>
      ) : (
        <>
          <HelpText>{t("methods.microsoft.description")}</HelpText>
          {stage !== "idle" ? (
            <>
              <UrlBox
                label={
                  stage === "microsoft" ? t("microsoft.providerStep") : t("microsoft.portalStep")
                }
                url={authorizeUrl}
              />
              <HelpText className="text-foreground">{t("microsoft.callbackInstructions")}</HelpText>
              <FormField error={fieldError} label={t("callbackUrl")}>
                <Input
                  autoCapitalize="off"
                  autoComplete="off"
                  disabled={busy}
                  inputMode="url"
                  onChange={(event) => setCallbackUrl(event.target.value)}
                  placeholder="http://localhost:3128/..."
                  spellCheck={false}
                  value={callbackUrl}
                />
              </FormField>
            </>
          ) : null}
        </>
      )}
      <FlowFooter>
        <Button className="h-10 sm:h-8" form={formId} loading={busy} type="submit">
          {submitLabel}
        </Button>
      </FlowFooter>
    </form>
  );
}
