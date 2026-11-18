import { type FormEvent, type JSX, useRef, useState } from "react";
import { AwsLogo } from "@/components/shared/brand-logos";
import { Code } from "@/components/shared/code";
import { Textarea } from "@/components/ui/textarea";
import { announce } from "@/lib/announce";
import { importSsoToken, reloginSsoToken } from "@/lib/api/auth-flows";
import { serverMessageText } from "@/lib/api/server-errors";
import { fillNodes, useT } from "@/lib/i18n";
import {
  FlowError,
  type FlowFailure,
  FlowGuide,
  FormField,
  GuideLink,
  RegionField,
  SubmitButton,
} from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import { parseRegion } from "../lib/region";
import { reloginRegion } from "../lib/relogin-method";
import { useReloginFlow } from "../relogin";
import { batchResultText } from "../result-text";

/** The AWS access portal, where the SSO cookie is set (a host name, the same in every language). */
const SSO_START = "view.awsapps.com/start";

/** Bulk import of x-amz-sso_authn tokens. The server imports them in one long request. */
export function SsoTokenFlow(): JSX.Element {
  const { t } = useT("add-account");
  const { sessions, finishAdd } = useFlow();
  const relogin = useReloginFlow();
  const formId = useFormId();
  const [tokens, setTokens] = useState("");
  const [region, setRegion] = useState(() => reloginRegion(relogin.target));
  const [errors, setErrors] = useState<{ tokens?: string; region?: string }>({});
  const [failure, setFailure] = useState<FlowFailure | null>(null);
  const [pending, setPending] = useState(false);
  useReportBusy(pending);
  const focusAfter = useFocusAfter(pending);
  const tokensRef = useRef<HTMLTextAreaElement>(null);
  const regionRef = useRef<HTMLInputElement>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const parsed = parseRegion(region);
    const lines = tokens.split("\n").filter((line) => line.trim()).length;
    const nextErrors = {
      tokens: !lines
        ? t("sso.tokenRequired")
        : relogin.target && lines > 1
          ? t("relogin.singleOnly")
          : undefined,
      region: parsed.ok ? undefined : t("regionInvalid"),
    };
    setErrors(nextErrors);
    setFailure(null);
    if (nextErrors.tokens || !parsed.ok) {
      focusAfter(nextErrors.tokens ? tokensRef : regionRef);
      return;
    }
    const generation = sessions.generation;
    setPending(true);
    if (relogin.accountId) {
      try {
        const res = await reloginSsoToken({
          bearerToken: tokens,
          region: parsed.region,
          reloginAccountId: relogin.accountId,
        });
        if (!sessions.isCurrent(generation)) return;
        relogin.finish(res);
      } catch (error) {
        if (sessions.isCurrent(generation) && !(await relogin.resolveMismatch(error, setFailure))) {
          setFailure({ error });
          focusAfter(tokensRef);
        }
      } finally {
        setPending(false);
      }
      return;
    }
    try {
      const res = await importSsoToken({ bearerToken: tokens, region: parsed.region });
      if (!sessions.isCurrent(generation)) return;
      // Each token's error is the AWS sign-in code's Chinese message, sent without a code.
      const failures = res.errors.map((message) => serverMessageText(message, t));
      const text = batchResultText(t, res.accounts, failures);
      if (failures.length === 0) {
        announce(text);
        finishAdd(res.accounts);
        return;
      }
      // The tokens that went in are listed at once; the dialog stays open on the ones that failed.
      if (res.accounts.length > 0) finishAdd(res.accounts, { keepOpen: true });
      setFailure({ error: failures, message: text });
      focusAfter(tokensRef);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        setFailure({ error });
        focusAfter(tokensRef);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      <FlowGuide title={t("sso.howToGet")}>
        <li>
          {fillNodes(t("sso.step1"), {
            link: (
              <GuideLink href={`https://${SSO_START}`} logo={<AwsLogo className="size-4" />}>
                {SSO_START}
              </GuideLink>
            ),
          })}
        </li>
        <li>{t("sso.step2")}</li>
        <li>{fillNodes(t("sso.step3"), { cookie: <Code>x-amz-sso_authn</Code> })}</li>
      </FlowGuide>
      <FormField error={errors.tokens} hint={t("sso.tokenHint")} label={t("sso.tokenLabel")}>
        <Textarea
          autoComplete="off"
          disabled={pending}
          onChange={(event) => setTokens(event.target.value)}
          ref={tokensRef}
          spellCheck={false}
          value={tokens}
          variant="mono"
        />
      </FormField>
      <RegionField
        disabled={pending}
        error={errors.region}
        inputRef={regionRef}
        onChange={setRegion}
        value={region}
      />
      <FlowError failure={failure} />
      <FlowFooter>
        <SubmitButton
          busy={pending}
          formId={formId}
          label={relogin.target ? t("relogin.submit") : t("add")}
        />
      </FlowFooter>
    </form>
  );
}
