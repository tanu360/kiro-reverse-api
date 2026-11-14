import { Alert02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type JSX, useId, useState } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { CreditAmount } from "@/components/shared/credit-amount";
import { StatStrip } from "@/components/shared/stat-strip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accountsQuery, getAccountModelsCached } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import { type ReplayResult, replayRequest, requestBodyQuery } from "@/lib/api/requests";
import { errorMessage } from "@/lib/api/server-errors";
import type { RequestRecord } from "@/lib/api/types";
import { formatBytes, formatDurationMs, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { endpointLabel } from "./requests-columns";

/**
 * Runs a logged request again on an account and model the admin picks, without streaming, and
 * shows the answer. The replay is logged as a new request marked as a replay, and it spends that
 * account's credits, which the dialog says before it runs.
 */
export function ReplayDialog({
  record,
  open,
  onOpenChange,
}: {
  record: RequestRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open && record.id !== undefined ? <ReplayForm id={record.id} record={record} /> : null}
    </Dialog>
  );
}

function ReplayForm({ id, record }: { id: number; record: RequestRecord }): JSX.Element {
  const { t, lang } = useT("requests");
  const mask = useMaskText();
  const queryClient = useQueryClient();
  const accountLabel = useId();
  const modelId = useId();
  const accounts = useQuery(accountsQuery());
  const body = useQuery(requestBodyQuery(id));
  const [accountId, setAccountId] = useState(record.accountId);
  const [model, setModel] = useState(record.model);
  const models = useQuery({
    queryKey: queryKeys.accounts.modelsCached(accountId),
    queryFn: () => getAccountModelsCached(accountId),
    enabled: accountId !== "",
  });
  const run = useMutation({
    mutationFn: () => replayRequest(id, { accountId, model: model.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
    },
  });

  const choices = (accounts.data ?? []).filter((account) => account.enabled);
  const accountItems = choices.map((account) => ({
    value: account.id,
    label: mask(account.email || account.nickname || account.id),
  }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!run.isPending && accountId && model.trim()) run.mutate();
  };

  return (
    <DialogPopup className="sm:max-w-2xl">
      <form className="contents" noValidate onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t("replay.title", { id })}</DialogTitle>
          <DialogDescription>{t("replay.hint")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <Alert role="note" size="sm" variant="warning">
            <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
            <AlertDescription>{t("replay.credits")}</AlertDescription>
          </Alert>
          <div className="grid gap-4 sm:grid-cols-2 sm:gap-3">
            <Field className="min-w-0 items-stretch">
              <FieldLabel id={accountLabel}>{t("account")}</FieldLabel>
              <Select
                items={accountItems}
                onValueChange={(next) => {
                  if (typeof next === "string") setAccountId(next);
                }}
                value={accountId}
              >
                <SelectTrigger aria-labelledby={accountLabel}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {accountItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field className="min-w-0 items-stretch">
              <FieldLabel htmlFor={modelId}>{t("model")}</FieldLabel>
              <Input
                autoComplete="off"
                id={modelId}
                list={`${modelId}-list`}
                onChange={(event) => setModel(event.target.value)}
                spellCheck={false}
                value={model}
                variant="code"
              />
              <datalist id={`${modelId}-list`}>
                {(models.data?.models ?? []).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </Field>
          </div>
          <p className="text-muted-foreground text-xs">
            {body.data
              ? t("replay.bodyKept", {
                  size: formatBytes(body.data.size, lang),
                  endpoint: endpointLabel(body.data.endpoint as RequestRecord["endpoint"], t),
                })
              : body.isError
                ? errorMessage(body.error, t)
                : t("replay.bodyLoading")}
          </p>
          {run.isError ? (
            <Alert role="alert" size="sm" variant="error">
              <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
              <AlertDescription>{errorMessage(run.error, t)}</AlertDescription>
            </Alert>
          ) : null}
          {run.data ? <ReplayOutcome result={run.data} /> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>{t("common:actions.close")}</DialogClose>
          <Button
            disabled={!accountId || !model.trim() || body.isError}
            loading={run.isPending}
            loadingText={t("replay.running")}
            type="submit"
          >
            <HugeiconsIcon icon={PlayIcon} aria-hidden="true" />
            {run.data ? t("replay.again") : t("replay.run")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}

/** The replay's status, time, tokens and credits, then the answer itself. */
function ReplayOutcome({ result }: { result: ReplayResult }): JSX.Element {
  const { t, lang } = useT("requests");
  const ok = result.status >= 200 && result.status < 300;
  const logged = result.request;
  const text =
    result.response !== undefined
      ? JSON.stringify(result.response, null, 2)
      : (result.responseText ?? "");
  return (
    <section aria-label={t("replay.result")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge dot size="sm" tone={ok ? "success" : "destructive"}>
          {t("replay.status", { status: result.status })}
        </Badge>
        {logged?.id ? (
          <span className="text-muted-foreground text-xs">
            {t("replay.logged", { id: logged.id })}
          </span>
        ) : null}
      </div>
      <StatStrip
        items={[
          { label: t("duration"), value: formatDurationMs(result.durationMs, true, lang) },
          {
            label: t("tokens"),
            value: formatNumber((logged?.inTokens ?? 0) + (logged?.outTokens ?? 0), lang),
          },
          { label: t("credits"), value: <CreditAmount digits={4} value={logged?.credits ?? 0} /> },
        ]}
      />
      <CodeBlock
        capHeight
        code={text}
        copyLabel={t("replay.copyAnswer")}
        language={result.response !== undefined ? "json" : undefined}
        title={t("replay.answer")}
        wrap
      />
    </section>
  );
}
