import { type FormEvent, type JSX, useRef, useState } from "react";
import { ChoiceCard } from "@/components/shared/choice-card";
import { Code } from "@/components/shared/code";
import { Field, FieldDescription, FieldError, FieldItem, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  cancelMicrosoftSso,
  completeMicrosoftSso,
  selectMicrosoftProfile,
  startMicrosoftSso,
} from "@/lib/api/auth-flows";
import { errorMessage, serverCodeMessage } from "@/lib/api/server-errors";
import type { KiroProfile, MicrosoftSelectProfileResponse } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { FlowNote, type FlowStepItem, FlowSteps, FormField, SubmitButton, UrlBox } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { stepFocus, useFocusAfter } from "../focus";
import { useReloginFlow } from "../relogin";

type Stage = "idle" | "kiro" | "microsoft" | "profile";

/**
 * Microsoft Entra ID sign-in: the Kiro portal leg, the Microsoft leg, then a Kiro profile
 * choice when the account has several. The server keeps the login; the dialog cancels it on
 * every exit, and a response that lands after an exit is dropped and its session canceled.
 */
export function MicrosoftFlow(): JSX.Element {
  const { t } = useT("add-account");
  const { sessions, finishAdd } = useFlow();
  const relogin = useReloginFlow();
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
  const focusAfter = useFocusAfter(busy);
  const callbackRef = useRef<HTMLInputElement>(null);
  const profilesRef = useRef<HTMLDivElement>(null);
  // The checked profile, or the first one; Base UI radios are focusable role="radio" elements.
  const focusProfile = () =>
    profilesRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
    profilesRef.current?.querySelector<HTMLElement>('[role="radio"]');

  const step = async <T,>(
    request: () => Promise<T>,
    apply: (res: T) => void,
    onError: () => void = () => {},
  ) => {
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
      if (!sessions.isCurrent(generation)) return;
      if (await relogin.resolveMismatch(error)) {
        // The server finished this login; a new attempt starts from the first step.
        sessions.cancelMicrosoft();
        setStage("idle");
        setAuthorizeUrl("");
        setCallbackUrl("");
        return;
      }
      toast.error(t(relogin.failedKey, { error: errorMessage(error, t) }));
      onError();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const done = (res: MicrosoftSelectProfileResponse) => {
    // The server closed the login when it saved the account; there is nothing to cancel.
    sessions.microsoftSessionId = "";
    sessions.microsoftSelectionId = "";
    relogin.announce(res);
    if (res.warning) {
      const detail = { detail: res.warningDetail };
      toast.warning(serverCodeMessage(res.warningCode, detail, t) ?? res.warning);
    }
    finishAdd([res.account]);
  };

  const start = () =>
    step(
      () => startMicrosoftSso({ reloginAccountId: relogin.accountId }),
      (res) => {
        sessions.microsoftSessionId = res.sessionId;
        setAuthorizeUrl(res.authorizeUrl);
        setCallbackUrl("");
        setStage("kiro");
        focusAfter(stepFocus(formId, callbackRef));
      },
    );

  const complete = () => {
    const callback = callbackUrl.trim();
    if (!callback) {
      setFieldError(t("callbackRequired"));
      focusAfter(callbackRef);
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
          focusAfter(focusProfile);
        } else {
          setAuthorizeUrl(res.authorizeUrl);
          setCallbackUrl("");
          setStage("microsoft");
          focusAfter(stepFocus(formId, callbackRef));
        }
      },
      () => focusAfter(callbackRef),
    );
  };

  const selectProfile = () => {
    if (!selectedArn) {
      setFieldError(t("microsoft.profileRequired"));
      focusAfter(focusProfile);
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
      () => focusAfter(focusProfile),
    );
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
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

  // The paste step of the leg in progress: its sign-in link, what to expect, then the field.
  const pasteStep = (
    <>
      <UrlBox label={t("iam.loginUrl")} url={authorizeUrl} />
      {/* A step note, not the field hint: it stays in view while the field shows an error. */}
      <FlowNote>
        {t("microsoft.callbackInstructions")} <Code>http://localhost:3128</Code>
      </FlowNote>
      <FormField error={fieldError} label={t("callbackUrl")}>
        <Input
          maxLength={2048}
          autoCapitalize="off"
          autoComplete="off"
          disabled={busy}
          inputMode="url"
          onChange={(event) => setCallbackUrl(event.target.value)}
          placeholder="http://localhost:3128/…"
          ref={callbackRef}
          spellCheck={false}
          value={callbackUrl}
        />
      </FormField>
    </>
  );
  const profileStep = (
    <Field className="w-full" invalid={Boolean(fieldError)}>
      <FieldLabel className="sr-only">{t("microsoft.profileLabel")}</FieldLabel>
      <FieldDescription>{t("microsoft.selectProfileDesc")}</FieldDescription>
      <RadioGroup
        aria-label={t("microsoft.profileLabel")}
        className="w-full gap-2"
        disabled={busy}
        onValueChange={(value) => setSelectedArn(String(value))}
        ref={profilesRef}
        value={selectedArn}
      >
        {/* Each card is a FieldItem, so its radio keeps the card's own id inside the Field. */}
        {profiles.map((profile) => (
          <FieldItem key={profile.arn}>
            <ChoiceCard
              control={(id) => <Radio id={id} value={profile.arn} />}
              description={profile.region}
              title={profile.name || t("microsoft.unnamedProfile")}
            >
              <span className="break-all font-mono text-meta text-muted-foreground">
                {profile.arn}
              </span>
            </ChoiceCard>
          </FieldItem>
        ))}
      </RadioGroup>
      <FieldError match={Boolean(fieldError)}>{fieldError}</FieldError>
    </Field>
  );
  // Two browser sign-ins, each followed by a paste, then a profile choice when there are several.
  // Before the first request every step is still to come, and the first says what each paste is.
  const order = ["kiro", "microsoft", "profile"] as const;
  const at = stage === "idle" ? -1 : order.indexOf(stage);
  const stateOf = (index: number): FlowStepItem["state"] =>
    index < at ? "done" : index === at ? "current" : "todo";
  const steps: FlowStepItem[] = [
    {
      state: stateOf(0),
      title: t("microsoft.stepPortal"),
      children:
        stage === "kiro" ? (
          pasteStep
        ) : stage === "idle" ? (
          <FlowNote>
            {t("microsoft.pasteStep")} <Code>http://localhost:3128</Code>
          </FlowNote>
        ) : null,
    },
    {
      state: stateOf(1),
      title: t("microsoft.stepProvider"),
      children: stage === "microsoft" ? pasteStep : null,
    },
    {
      state: stateOf(2),
      title: t("microsoft.stepProfile"),
      children:
        stage === "profile" ? profileStep : <FlowNote>{t("microsoft.stepProfileNote")}</FlowNote>,
    },
  ];

  return (
    // tabIndex -1: a step change focuses the form itself on touch screens (see stepFocus).
    <form
      className="flex flex-col gap-4 outline-none"
      id={formId}
      noValidate
      onSubmit={onSubmit}
      tabIndex={-1}
    >
      <FlowSteps steps={steps} />
      <FlowFooter>
        <SubmitButton busy={busy} formId={formId} label={submitLabel} />
      </FlowFooter>
    </form>
  );
}
