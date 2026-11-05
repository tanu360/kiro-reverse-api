import { type FormEvent, type JSX, useRef, useState } from "react";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Input } from "@/components/ui/input";
import { completeIamSso, startIamSso } from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { FlowNote, FormField, RegionField, SubmitButton, UrlBox } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import { parseRegion } from "../lib/region";

/**
 * IAM Identity Center SSO: start a login, open the URL, then paste the failed 127.0.0.1
 * callback URL. A failed completion stays on step 2; the server keeps the session for 10 min.
 */
export function IamFlow(): JSX.Element {
  const { t } = useT("add-account");
  const display = useDisplayEmail();
  const { sessions, finishAdd } = useFlow();
  const formId = useFormId();
  const [startUrl, setStartUrl] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [errors, setErrors] = useState<{ startUrl?: string; region?: string; callback?: string }>(
    {},
  );
  const [pending, setPending] = useState(false);
  useReportBusy(pending);
  const focusAfter = useFocusAfter(pending);
  const startUrlRef = useRef<HTMLInputElement>(null);
  const regionRef = useRef<HTMLInputElement>(null);
  const callbackRef = useRef<HTMLInputElement>(null);

  const start = async () => {
    const parsed = parseRegion(region);
    const nextErrors = {
      startUrl: startUrl.trim() ? undefined : t("iam.startUrlRequired"),
      region: parsed.ok ? undefined : t("regionInvalid"),
    };
    setErrors(nextErrors);
    if (nextErrors.startUrl || !parsed.ok) {
      focusAfter(nextErrors.startUrl ? startUrlRef : regionRef);
      return;
    }
    const generation = sessions.generation;
    setPending(true);
    try {
      const res = await startIamSso({ startUrl: startUrl.trim(), region: parsed.region });
      if (!sessions.isCurrent(generation)) return;
      sessions.iamSession = res.sessionId;
      setAuthorizeUrl(res.authorizeUrl);
      focusAfter(callbackRef);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("startFailed", { error: errorMessage(error, t) }));
        focusAfter(startUrlRef);
      }
    } finally {
      setPending(false);
    }
  };

  const complete = async () => {
    const callback = callbackUrl.trim();
    if (!callback) {
      setErrors({ callback: t("callbackRequired") });
      focusAfter(callbackRef);
      return;
    }
    setErrors({});
    const generation = sessions.generation;
    setPending(true);
    try {
      const res = await completeIamSso({ sessionId: sessions.iamSession, callbackUrl: callback });
      if (!sessions.isCurrent(generation)) return;
      toast.success(t("success", { name: display(res.account.email, res.account.id) }));
      finishAdd([res.account]);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("failed", { error: errorMessage(error, t) }));
        focusAfter(callbackRef);
      }
    } finally {
      setPending(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    void (authorizeUrl ? complete() : start());
  };

  const started = Boolean(authorizeUrl);
  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      {started ? (
        <>
          {/* The start URL and region are fixed once the login starts; one line recalls them. */}
          <FlowNote>
            <TruncatedText>
              {t("iam.summary", { url: startUrl.trim(), region: region.trim() })}
            </TruncatedText>
          </FlowNote>
          <UrlBox label={t("iam.loginUrl")} url={authorizeUrl} />
          <FormField error={errors.callback} hint={t("iam.completeLogin")} label={t("callbackUrl")}>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              disabled={pending}
              inputMode="url"
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder={t("iam.callbackUrlPlaceholder")}
              ref={callbackRef}
              spellCheck={false}
              value={callbackUrl}
            />
          </FormField>
        </>
      ) : (
        <>
          <FormField error={errors.startUrl} label={t("iam.startUrl")}>
            <Input
              autoCapitalize="off"
              autoComplete="url"
              disabled={pending}
              inputMode="url"
              onChange={(event) => setStartUrl(event.target.value)}
              placeholder={t("iam.startUrlPlaceholder")}
              ref={startUrlRef}
              spellCheck={false}
              value={startUrl}
            />
          </FormField>
          <RegionField
            disabled={pending}
            error={errors.region}
            inputRef={regionRef}
            onChange={setRegion}
            value={region}
          />
        </>
      )}
      <FlowFooter>
        <SubmitButton
          busy={pending}
          busyLabel={started ? t("completing") : t("starting")}
          formId={formId}
          label={started ? t("completeSignIn") : t("startSignIn")}
        />
      </FlowFooter>
    </form>
  );
}
