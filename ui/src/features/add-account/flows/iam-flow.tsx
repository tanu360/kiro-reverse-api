import { type FormEvent, type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { completeIamSso, startIamSso } from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { FormField, HelpText, RegionField, UrlBox } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
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

  const start = async () => {
    const parsed = parseRegion(region);
    const nextErrors = {
      startUrl: startUrl.trim() ? undefined : t("iam.startUrlRequired"),
      region: parsed.ok ? undefined : t("regionInvalid"),
    };
    setErrors(nextErrors);
    if (nextErrors.startUrl || !parsed.ok) return;
    const generation = sessions.generation;
    setPending(true);
    try {
      const res = await startIamSso({ startUrl: startUrl.trim(), region: parsed.region });
      if (!sessions.isCurrent(generation)) return;
      sessions.iamSession = res.sessionId;
      setAuthorizeUrl(res.authorizeUrl);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("startFailed", { error: errorMessage(error, t) }));
      }
    } finally {
      setPending(false);
    }
  };

  const complete = async () => {
    const callback = callbackUrl.trim();
    if (!callback) {
      setErrors({ callback: t("callbackRequired") });
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
      <HelpText>{t("methods.iam.description")}</HelpText>
      <FormField error={errors.startUrl} label={t("iam.startUrl")}>
        <Input
          autoCapitalize="off"
          autoComplete="url"
          disabled={started || pending}
          inputMode="url"
          onChange={(event) => setStartUrl(event.target.value)}
          placeholder={t("iam.startUrlPlaceholder")}
          spellCheck={false}
          value={startUrl}
        />
      </FormField>
      <RegionField
        disabled={started || pending}
        error={errors.region}
        onChange={setRegion}
        value={region}
      />
      {started ? (
        <>
          <UrlBox label={t("iam.loginUrl")} url={authorizeUrl} />
          <HelpText className="text-foreground">{t("iam.completeLogin")}</HelpText>
          <FormField error={errors.callback} label={t("callbackUrl")}>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              autoFocus
              disabled={pending}
              inputMode="url"
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder={t("iam.callbackUrlPlaceholder")}
              spellCheck={false}
              value={callbackUrl}
            />
          </FormField>
        </>
      ) : null}
      <FlowFooter>
        <Button className="h-10 sm:h-8" form={formId} loading={pending} type="submit">
          {started ? t("completeSignIn") : t("startSignIn")}
        </Button>
      </FlowFooter>
    </form>
  );
}
