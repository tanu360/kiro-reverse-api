import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { routesThroughPool } from "@/features/proxy-pool/lib/pool-model";
import { PoolProxyValue } from "@/features/proxy-pool/pool-assignment";
import { proxyPoolQuery } from "@/lib/api/proxy-pool";
import { proxyQuery } from "@/lib/api/settings";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { hasMaskedProxyPassword, isValidProxyUrl, proxyDisplayUrl } from "../account-model";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";

/**
 * The account's own proxy URL; empty falls back to the proxy pool (while it is on), then the
 * global proxy. The row shows what the account really uses: its own URL, its pool proxy with a
 * Pool badge, or the global one with a Global badge, or Direct when there is no global proxy
 * either. Passwords never show: the server sends a saved one masked, the edit field holds that
 * mask, and saving the mask back keeps the password.
 */
export function ProxyRow({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(account.proxyURL);
  const [error, setError] = useState<string | null>(null);
  // While the pool carries Kiro traffic, an empty field means the pool, not the global proxy.
  const pooled = routesThroughPool(useQuery(proxyPoolQuery()).data);

  const onSubmit = () => {
    const proxyURL = value.trim();
    if (!isValidProxyUrl(proxyURL)) {
      setError(t("detail.proxyFormatError"));
      return;
    }
    setError(null);
    save.mutate({ proxyURL }, { onSuccess: () => setOpen(false) });
  };

  return (
    <EditableFieldRow
      onEdit={() => {
        setValue(account.proxyURL);
        setError(null);
        setOpen(true);
      }}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      open={open}
      saving={save.isPending}
      title={t("detail.proxyURL")}
      value={<ProxyValue accountId={account.id} proxyURL={account.proxyURL} />}
      // A proxy URL is as long as a machine ID: the edit takes the whole row, label above.
      wide
    >
      <Field invalid={error !== null}>
        <FieldLabel className="sr-only">{t("detail.proxyURL")}</FieldLabel>
        <Input
          maxLength={2048}
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          placeholder={t("detail.proxyURLPlaceholder")}
          spellCheck={false}
          value={value}
          variant="code"
        />
        {error ? <FieldError match>{error}</FieldError> : null}
        <FieldDescription>
          {t(pooled ? "detail.proxyHintPool" : "detail.proxyHint")}
        </FieldDescription>
        {hasMaskedProxyPassword(account.proxyURL) ? (
          <FieldDescription>{t("detail.proxyPasswordKept")}</FieldDescription>
        ) : null}
      </Field>
    </EditableFieldRow>
  );
}

function ProxyValue({ accountId, proxyURL }: { accountId: string; proxyURL: string }): JSX.Element {
  const { t } = useT("accounts");
  // The pool and the global proxy are read only when the account has none of its own.
  const global = useQuery({ ...proxyQuery(), enabled: !proxyURL }).data;
  const pool = useQuery({ ...proxyPoolQuery(), enabled: !proxyURL }).data;
  if (proxyURL) return <span className="font-mono">{proxyDisplayUrl(proxyURL)}</span>;
  if (routesThroughPool(pool)) return <PoolProxyValue accountId={accountId} view={pool} />;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {global === undefined ? null : global.proxyURL ? (
        <span className="min-w-0 truncate font-mono">{proxyDisplayUrl(global.proxyURL)}</span>
      ) : (
        <span className="min-w-0 truncate">{t("detail.proxyDirect")}</span>
      )}
      <Badge size="sm" tone="neutral">
        {t("detail.proxyGlobal")}
      </Badge>
    </span>
  );
}
