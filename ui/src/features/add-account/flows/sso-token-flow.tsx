import { type FormEvent, type JSX, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
import { Textarea } from "@/components/ui/textarea";
import { importSsoToken } from "@/lib/api/auth-flows";
import { errorMessage, serverMessageText } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { FlowGuide, FormField, RegionField, SubmitButton } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import { parseRegion } from "../lib/region";
import { showBatchResult } from "../result-toast";

/** Bulk import of x-amz-sso_authn tokens. The server imports them in one long request. */
export function SsoTokenFlow(): JSX.Element {
  const { t } = useT("add-account");
  const { sessions, finishAdd } = useFlow();
  const formId = useFormId();
  const [tokens, setTokens] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [errors, setErrors] = useState<{ tokens?: string; region?: string }>({});
  const [pending, setPending] = useState(false);
  useReportBusy(pending);
  const focusAfter = useFocusAfter(pending);
  const tokensRef = useRef<HTMLTextAreaElement>(null);
  const regionRef = useRef<HTMLInputElement>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const parsed = parseRegion(region);
    const nextErrors = {
      tokens: tokens.trim() ? undefined : t("sso.tokenRequired"),
      region: parsed.ok ? undefined : t("regionInvalid"),
    };
    setErrors(nextErrors);
    if (nextErrors.tokens || !parsed.ok) {
      focusAfter(nextErrors.tokens ? tokensRef : regionRef);
      return;
    }
    const generation = sessions.generation;
    setPending(true);
    try {
      const res = await importSsoToken({ bearerToken: tokens, region: parsed.region });
      if (!sessions.isCurrent(generation)) return;
      // Each token's error is the AWS sign-in code's Chinese message, sent without a code.
      const failures = res.errors.map((message) => serverMessageText(message, t));
      showBatchResult(t, res.accounts.length, failures);
      finishAdd(res.accounts);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("failed", { error: errorMessage(error, t) }));
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
          {t("sso.step1")} <Code>view.awsapps.com/start</Code>
        </li>
        <li>{t("sso.step2")}</li>
        <li>
          {t("sso.step3")} <Code>x-amz-sso_authn</Code>
        </li>
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
      <FlowFooter>
        <SubmitButton busy={pending} formId={formId} label={t("add")} />
      </FlowFooter>
    </form>
  );
}
