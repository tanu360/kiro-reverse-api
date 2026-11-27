import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type JSX, type ReactNode, type Ref, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { announce } from "@/lib/announce";
import { importCredentials } from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import { upstreamQuery } from "@/lib/api/settings";
import type { AddedAccountRef } from "@/lib/api/types";
import { formatList } from "@/lib/format";
import { fillNodes, useT } from "@/lib/i18n";
import { FlowError, type FlowFailure, FlowNote, FormField, SubmitButton } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import { keyRegion, parseApiKeyLines } from "../lib/api-key-lines";
import { reloginRegion } from "../lib/relogin-method";
import { useReloginFlow } from "../relogin";
import { batchResultText } from "../result-text";

/**
 * The regions Kiro serves API keys from, as a select. Until the server's list arrives it holds
 * only the current value. A re-login keeps the account's own region even when Kiro no longer
 * serves it; the flow then asks for another before sending a plain key.
 */
function ApiKeyRegionField({
  value,
  regions,
  onChange,
  error,
  hint,
  disabled,
  triggerRef,
}: {
  value: string;
  regions: readonly string[] | undefined;
  onChange: (value: string) => void;
  error?: string;
  hint: ReactNode;
  disabled: boolean;
  triggerRef: Ref<HTMLButtonElement>;
}): JSX.Element {
  const { t } = useT("add-account");
  const items = (regions ?? [value]).map((region) => ({ value: region, label: region }));
  return (
    <FormField error={error} hint={hint} label={t("region")}>
      <Select
        disabled={disabled}
        items={items}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
        value={value}
      >
        <SelectTrigger ref={triggerRef}>
          <SelectValue>{(region: string) => region}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </FormField>
  );
}

/** Kiro CLI API keys, one per line, imported one request at a time. */
export function ApiKeyFlow(): JSX.Element {
  const { t, lang } = useT("add-account");
  const { sessions, finishAdd } = useFlow();
  const relogin = useReloginFlow();
  const formId = useFormId();
  // config.KiroServiceRegions: the server turns down a key for any other region.
  const regions = useQuery(upstreamQuery()).data?.apiRegions;
  const [keys, setKeys] = useState("");
  // An API key account's region is its key's, so a pasted key without |region keeps it.
  const [region, setRegion] = useState(() => reloginRegion(relogin.target));
  const [errors, setErrors] = useState<{ keys?: string; region?: string }>({});
  const [failure, setFailure] = useState<FlowFailure | null>(null);
  const [pending, setPending] = useState(false);
  useReportBusy(pending);
  const focusAfter = useFocusAfter(pending);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const regionRef = useRef<HTMLButtonElement>(null);

  // Until the list arrives every region passes here; the server still checks it.
  const unserved = (value: string) =>
    regions !== undefined && !regions.includes(value)
      ? t("apikey.regionUnsupported", { regions: formatList(regions, lang), region: value })
      : undefined;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const requests = parseApiKeyLines(keys, region);
    const suffixes = requests.map((request) => keyRegion(request.kiroApiKey ?? ""));
    // A bar with nothing after it names no region: the server refuses it as invalid.
    const suffixError = (suffix: string) => (suffix ? unserved(suffix) : t("regionInvalid"));
    const badSuffix = suffixes.find((suffix) => suffix !== null && suffixError(suffix));
    const nextErrors = {
      keys: !requests.length
        ? t("apikey.keyMissing")
        : relogin.target && requests.length > 1
          ? t("relogin.singleOnly")
          : badSuffix !== undefined && badSuffix !== null
            ? suffixError(badSuffix)
            : undefined,
      // Only a key without |region takes the selected one.
      region: suffixes.includes(null) ? unserved(region) : undefined,
    };
    setErrors(nextErrors);
    setFailure(null);
    if (nextErrors.keys || nextErrors.region) {
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
        relogin.finish(res);
      } catch (caught) {
        if (
          sessions.isCurrent(generation) &&
          !(await relogin.resolveMismatch(caught, setFailure))
        ) {
          setFailure({ error: caught });
          focusAfter(keysRef);
        }
      } finally {
        setPending(false);
      }
      return;
    }
    const added: AddedAccountRef[] = [];
    const failures: string[] = [];
    const failedKeys: string[] = [];
    try {
      for (const request of requests) {
        try {
          const res = await importCredentials(request);
          added.push(res.account);
        } catch (caught) {
          failures.push(errorMessage(caught, t));
          failedKeys.push(request.kiroApiKey ?? "");
        }
        if (!sessions.isCurrent(generation)) return;
      }
      const text = batchResultText(t, added, failures);
      if (failures.length === 0) {
        announce(text);
        finishAdd(added);
        return;
      }
      // The keys that went in are listed at once and leave the field (the server turns down a key
      // it already has); the dialog stays open on the ones that failed.
      if (added.length > 0) {
        finishAdd(added, { keepOpen: true });
        setKeys(failedKeys.join("\n"));
      }
      setFailure({ error: failures, message: text });
      focusAfter(keysRef);
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      <FlowNote>{t("apikey.help")}</FlowNote>
      <FormField
        error={errors.keys}
        hint={fillNodes(relogin.target ? t("relogin.keyHint") : t("apikey.keysHint"), {
          example: <Code>ksk_…|eu-central-1</Code>,
        })}
        label={relogin.target ? t("relogin.keyLabel") : t("apikey.keysLabel")}
      >
        <Textarea
          autoComplete="off"
          disabled={pending}
          onChange={(event) => setKeys(event.target.value)}
          ref={keysRef}
          placeholder={relogin.target ? "ksk_…" : "ksk_…\nksk_…|eu-central-1"}
          spellCheck={false}
          value={keys}
          variant="mono"
        />
      </FormField>
      <ApiKeyRegionField
        disabled={pending}
        error={errors.region}
        hint={
          <>
            {t("apikey.regionHint")} <Code>|region</Code>
          </>
        }
        onChange={setRegion}
        regions={regions}
        triggerRef={regionRef}
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
