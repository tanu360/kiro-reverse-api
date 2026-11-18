import { type FormEvent, type JSX, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { announce } from "@/lib/announce";
import { importCredentials } from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import type { AddedAccountRef } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { FlowError, type FlowFailure, FlowGuide, FormField, SubmitButton } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import {
  type CredentialSource,
  mapCredential,
  parseCredentialsJson,
} from "../lib/credentials-mapping";
import { useReloginFlow } from "../relogin";
import { batchResultText } from "../result-text";

/** Credentials JSON: one request per item, in order. Failures keep their reasons. */
export function CredentialsFlow(): JSX.Element {
  const { t } = useT("add-account");
  const { sessions, finishAdd } = useFlow();
  const relogin = useReloginFlow();
  const formId = useFormId();
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<FlowFailure | null>(null);
  const [pending, setPending] = useState(false);
  useReportBusy(pending);
  const focusAfter = useFocusAfter(pending);
  const jsonRef = useRef<HTMLTextAreaElement>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    if (!json.trim()) {
      setError(t("credentials.empty"));
      focusAfter(jsonRef);
      return;
    }
    let items: CredentialSource[];
    try {
      items = parseCredentialsJson(json);
    } catch {
      setError(t("credentials.parseError"));
      focusAfter(jsonRef);
      return;
    }
    if (items.length === 0) {
      setError(t("credentials.noItems"));
      focusAfter(jsonRef);
      return;
    }
    if (relogin.target && items.length > 1) {
      setError(t("relogin.singleOnly"));
      focusAfter(jsonRef);
      return;
    }
    if (relogin.target) {
      const mapped = mapCredential(items[0]);
      if (mapped.kind === "missingRefreshToken") {
        setError(
          t("credentials.failureItem", { index: 1, reason: t("credentials.missingRefreshToken") }),
        );
        focusAfter(jsonRef);
        return;
      }
      setError(null);
      const generation = sessions.generation;
      setPending(true);
      try {
        const res = await importCredentials({
          ...mapped.payload,
          reloginAccountId: relogin.accountId,
        });
        if (!sessions.isCurrent(generation)) return;
        relogin.announce(res);
        finishAdd([res.account]);
      } catch (caught) {
        if (
          sessions.isCurrent(generation) &&
          !(await relogin.resolveMismatch(caught, setFailure))
        ) {
          setFailure({ error: caught });
          focusAfter(jsonRef);
        }
      } finally {
        setPending(false);
      }
      return;
    }
    setError(null);
    const generation = sessions.generation;
    setPending(true);
    const added: AddedAccountRef[] = [];
    const failures: string[] = [];
    try {
      for (const [index, item] of items.entries()) {
        const mapped = mapCredential(item);
        const fail = (reason: string) =>
          failures.push(t("credentials.failureItem", { index: index + 1, reason }));
        if (mapped.kind === "missingRefreshToken") {
          fail(t("credentials.missingRefreshToken"));
          continue;
        }
        try {
          const res = await importCredentials(mapped.payload);
          added.push(res.account);
        } catch (caught) {
          fail(errorMessage(caught, t));
        }
        if (!sessions.isCurrent(generation)) return;
      }
      if (!sessions.isCurrent(generation)) return;
      const text = batchResultText(t, added, failures);
      if (failures.length === 0) {
        announce(text);
        finishAdd(added);
        return;
      }
      // The items that went in are listed at once; the dialog stays open on the ones that failed.
      // Sending the same JSON again updates those accounts instead of adding copies.
      if (added.length > 0) finishAdd(added, { keepOpen: true });
      setFailure({ error: failures, message: text });
      focusAfter(jsonRef);
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      <FlowGuide list title={t("credentials.formatTitle")}>
        <li>{t("credentials.formats")}</li>
        <li>{t("credentials.required")}</li>
        <li>{t("credentials.optional")}</li>
      </FlowGuide>
      <FormField error={error} label={t("credentials.label")}>
        <Textarea
          autoComplete="off"
          disabled={pending}
          onChange={(event) => setJson(event.target.value)}
          ref={jsonRef}
          placeholder='[{"refreshToken":"xxx","provider":"BuilderID"}]'
          spellCheck={false}
          value={json}
          variant="mono"
        />
      </FormField>
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
