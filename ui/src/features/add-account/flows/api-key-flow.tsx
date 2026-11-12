import { type FormEvent, type JSX, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
import { Textarea } from "@/components/ui/textarea";
import { importCredentials } from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import type { AddedAccountRef } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { FlowNote, FormField, RegionField, SubmitButton } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import { parseApiKeyLines } from "../lib/api-key-lines";
import { parseRegion } from "../lib/region";
import { reloginRegion } from "../lib/relogin-method";
import { useReloginFlow } from "../relogin";
import { showBatchResult } from "../result-toast";

/** Kiro CLI API keys, one per line, imported one request at a time. */
export function ApiKeyFlow(): JSX.Element {
  const { t } = useT("add-account");
  const { sessions, finishAdd } = useFlow();
  const relogin = useReloginFlow();
  const formId = useFormId();
  const [keys, setKeys] = useState("");
  // An API key account's region is its key's, so a pasted key without |region keeps it.
  const [region, setRegion] = useState(() => reloginRegion(relogin.target));
  const [errors, setErrors] = useState<{ keys?: string; region?: string }>({});
  const [pending, setPending] = useState(false);
  useReportBusy(pending);
  const focusAfter = useFocusAfter(pending);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const regionRef = useRef<HTMLInputElement>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    // The server checks that the region is one Kiro API keys support.
    const parsed = parseRegion(region);
    const requests = parseApiKeyLines(keys, parsed.ok ? parsed.region : "");
    const nextErrors = {
      keys: !requests.length
        ? t("apikey.keyMissing")
        : relogin.target && requests.length > 1
          ? t("relogin.singleOnly")
          : undefined,
      region: parsed.ok ? undefined : t("regionInvalid"),
    };
    setErrors(nextErrors);
    if (nextErrors.keys || !parsed.ok) {
      focusAfter(nextErrors.keys ? keysRef : regionRef);
      return;
    }
    const generation = sessions.generation;
    setPending(true);
    if (relogin.target) {
      try {
        const res = await importCredentials({
          ...requests[0],
          reloginAccountId: relogin.accountId,
        });
        if (!sessions.isCurrent(generation)) return;
        relogin.announce(res);
        finishAdd([res.account]);
      } catch (caught) {
        if (sessions.isCurrent(generation) && !(await relogin.resolveMismatch(caught))) {
          toast.error(t(relogin.failedKey, { error: errorMessage(caught, t) }));
          focusAfter(keysRef);
        }
      } finally {
        setPending(false);
      }
      return;
    }
    const added: AddedAccountRef[] = [];
    const failures: string[] = [];
    try {
      for (const request of requests) {
        try {
          const res = await importCredentials(request);
          added.push(res.account);
        } catch (caught) {
          failures.push(errorMessage(caught, t));
        }
        if (!sessions.isCurrent(generation)) return;
      }
      if (added.length === 0) {
        toast.error(t("failed", { error: failures[0] ?? "" }));
        focusAfter(keysRef);
        return;
      }
      showBatchResult(t, added, failures);
      finishAdd(added);
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      <FlowNote>{t("apikey.help")}</FlowNote>
      <FormField
        error={errors.keys}
        hint={
          <>
            {t("apikey.keysHint")} <Code>ksk_…|eu-central-1</Code>
          </>
        }
        label={t("apikey.keysLabel")}
      >
        <Textarea
          autoComplete="off"
          disabled={pending}
          onChange={(event) => setKeys(event.target.value)}
          ref={keysRef}
          placeholder={"ksk_…\nksk_…|eu-central-1"}
          spellCheck={false}
          value={keys}
          variant="mono"
        />
      </FormField>
      <RegionField
        disabled={pending}
        error={errors.region}
        hint={
          <>
            {t("apikey.regionHint")} <Code>|region</Code>
          </>
        }
        inputRef={regionRef}
        onChange={setRegion}
        value={region}
      />
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
