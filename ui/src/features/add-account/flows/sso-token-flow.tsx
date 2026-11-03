import { type FormEvent, type JSX, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { importSsoToken } from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { Code, FormField, HelpText, RegionField, SubmitButton } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
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

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const parsed = parseRegion(region);
    const nextErrors = {
      tokens: tokens.trim() ? undefined : t("sso.tokenRequired"),
      region: parsed.ok ? undefined : t("regionInvalid"),
    };
    setErrors(nextErrors);
    if (nextErrors.tokens || !parsed.ok) return;
    const generation = sessions.generation;
    setPending(true);
    try {
      const res = await importSsoToken({ bearerToken: tokens, region: parsed.region });
      if (!sessions.isCurrent(generation)) return;
      showBatchResult(t, res.accounts.length, res.errors);
      finishAdd(res.accounts);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("failed", { error: errorMessage(error, t) }));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      <div className="flex flex-col gap-2 text-sm">
        <span className="font-medium">{t("sso.howToGet")}</span>
        <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-muted-foreground">
          <li>
            {t("sso.step1")} <Code>view.awsapps.com/start</Code>
          </li>
          <li>{t("sso.step2")}</li>
          <li>
            {t("sso.step3")} <Code>x-amz-sso_authn</Code>
          </li>
        </ol>
      </div>
      <FormField error={errors.tokens} hint={t("sso.tokenHint")} label={t("sso.tokenLabel")}>
        <Textarea
          autoComplete="off"
          className="font-mono"
          disabled={pending}
          onChange={(event) => setTokens(event.target.value)}
          spellCheck={false}
          value={tokens}
        />
      </FormField>
      <RegionField disabled={pending} error={errors.region} onChange={setRegion} value={region} />
      <HelpText className="text-xs">{t("sso.slowHint")}</HelpText>
      <FlowFooter>
        <SubmitButton
          busy={pending}
          busyLabel={t("sso.importing")}
          formId={formId}
          label={t("add")}
        />
      </FlowFooter>
    </form>
  );
}
