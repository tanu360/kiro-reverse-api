import { type FormEvent, type JSX, useRef, useState } from "react";
import { ChoiceCard } from "@/components/shared/choice-card";
import { Code } from "@/components/shared/code";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
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
import { FlowGuide, FlowNote, FormField, SubmitButton, UrlBox } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";

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
      if (sessions.isCurrent(generation)) {
        toast.error(t("failed", { error: errorMessage(error, t) }));
        onError();
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
      focusAfter(callbackRef);
    });

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
          focusAfter(callbackRef);
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
  const busyLabel =
    stage === "idle" ? t("starting") : stage === "profile" ? t("adding") : t("completing");

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      {stage === "profile" ? (
        <Field className="w-full" invalid={Boolean(fieldError)}>
          <FieldLabel>{t("microsoft.profileLabel")}</FieldLabel>
          <FieldDescription>{t("microsoft.selectProfileDesc")}</FieldDescription>
          <RadioGroup
            aria-label={t("microsoft.profileLabel")}
            className="w-full gap-2"
            disabled={busy}
            onValueChange={(value) => setSelectedArn(String(value))}
            ref={profilesRef}
            value={selectedArn}
          >
            {profiles.map((profile) => (
              <ChoiceCard
                control={<Radio value={profile.arn} />}
                description={profile.region}
                key={profile.arn}
                title={profile.name || t("microsoft.unnamedProfile")}
              >
                <span className="break-all font-mono text-meta text-muted-foreground">
                  {profile.arn}
                </span>
              </ChoiceCard>
            ))}
          </RadioGroup>
          <FieldError match={Boolean(fieldError)}>{fieldError}</FieldError>
        </Field>
      ) : stage !== "idle" ? (
        <>
          <UrlBox
            label={stage === "microsoft" ? t("microsoft.providerStep") : t("microsoft.portalStep")}
            url={authorizeUrl}
          />
          {/* A step note, not the field hint: it stays in view while the field shows an error. */}
          <FlowNote>{t("microsoft.callbackInstructions")}</FlowNote>
          <FormField error={fieldError} label={t("callbackUrl")}>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              disabled={busy}
              inputMode="url"
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="http://localhost:3128/..."
              ref={callbackRef}
              spellCheck={false}
              value={callbackUrl}
            />
          </FormField>
        </>
      ) : (
        // Before the first request, say what follows: two browser sign-ins and two pastes.
        <FlowGuide list title={t("microsoft.guideTitle")}>
          <li>{t("microsoft.portalStep")}</li>
          <li>{t("microsoft.providerStep")}</li>
          <li>
            {t("microsoft.pasteStep")} <Code>http://localhost:3128</Code>
          </li>
        </FlowGuide>
      )}
      <FlowFooter>
        <SubmitButton busy={busy} busyLabel={busyLabel} formId={formId} label={submitLabel} />
      </FlowFooter>
    </form>
  );
}
