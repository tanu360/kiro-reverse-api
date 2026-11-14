import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useId, useState } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { CopyField } from "@/components/shared/code-field";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { SettingsRow, SwitchField } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { type MetricsSettings, metricsQuery, updateMetricsSettings } from "@/lib/api/metrics";
import { queryKeys } from "@/lib/api/query-keys";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SECTION_ID } from "./sections";
import { Hint, SectionQuery, SettingsGroup, toastSaveFailed } from "./settings-section";

/** Settings card for the Prometheus /metrics endpoint: its switch, address and bearer token. */
export function MetricsCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(metricsQuery());
  return (
    <SectionQuery id={SECTION_ID.metrics} query={query} title={t("metrics.title")}>
      {(settings) => <MetricsPanel settings={settings} />}
    </SectionQuery>
  );
}

/**
 * The token as the card shows it: its first eight and last four characters around "****", so it
 * fits one line ("kpm_6f1d****8c7b"). Copy still copies the whole token.
 */
export function maskMetricsToken(token: string): string {
  return token.length > 16 ? `${token.slice(0, 8)}****${token.slice(-4)}` : token;
}

/** A scrape job for prometheus.yml with this server's address and token. */
export function scrapeConfig(origin: string, path: string, token: string): string {
  const url = new URL(origin);
  return [
    "scrape_configs:",
    "  - job_name: kiro-proxy",
    `    scheme: ${url.protocol.replace(":", "")}`,
    `    metrics_path: ${path}`,
    "    authorization:",
    "      type: Bearer",
    `      credentials: ${token}`,
    "    static_configs:",
    `      - targets: ["${url.host}"]`,
  ].join("\n");
}

function MetricsPanel({ settings }: { settings: MetricsSettings }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const urlLabel = useId();
  const tokenLabel = useId();
  const [pending, setPending] = useState<boolean | null>(null);
  const save = useMutation({
    mutationFn: updateMetricsSettings,
    onSuccess: (next, body) => {
      queryClient.setQueryData(queryKeys.settings.metrics(), next);
      toast.success(body.regenerate ? t("metrics.regenerated") : t("saved"));
    },
    onError: (error) => toastSaveFailed(error, t),
    onSettled: () => setPending(null),
  });
  const enabled = pending ?? settings.enabled;
  const origin = window.location.origin;
  const endpoint = `${origin}${settings.path}`;

  const regenerate = async () => {
    const confirmed = await confirm({
      title: t("metrics.regenerateTitle"),
      description: t("metrics.regenerateBody"),
      confirmLabel: t("metrics.regenerate"),
    });
    if (confirmed) save.mutate({ regenerate: true });
  };

  return (
    <SettingsGroup
      description={t("metrics.hint")}
      id={SECTION_ID.metrics}
      title={t("metrics.title")}
    >
      <SwitchField
        checked={enabled}
        description={<Hint more={t("metrics.more")}>{t("metrics.switchHint")}</Hint>}
        disabled={save.isPending}
        onCheckedChange={(next) => {
          setPending(next);
          save.mutate({ enabled: next });
        }}
        title={t("metrics.switch")}
      />
      {settings.enabled && settings.token ? (
        <>
          <SettingsRow
            control={<CopyField labelledBy={urlLabel} multiline value={endpoint} />}
            description={t("metrics.endpointHint")}
            title={<span id={urlLabel}>{t("metrics.endpoint")}</span>}
          />
          <SettingsRow
            control={
              // New token sits in the field beside Copy, as an icon button with its name as a
              // tooltip, so the row stays one field high.
              <CopyField
                actions={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label={t("metrics.regenerate")}
                          loading={save.isPending && pending === null}
                          onClick={() => void regenerate()}
                          size="icon-sm"
                          variant="quiet"
                        />
                      }
                    >
                      <HugeiconsIcon icon={RefreshIcon} aria-hidden="true" />
                    </TooltipTrigger>
                    <TooltipPopup>{t("metrics.regenerate")}</TooltipPopup>
                  </Tooltip>
                }
                copiedMessage={t("metrics.tokenCopied")}
                display={maskMetricsToken(settings.token)}
                labelledBy={tokenLabel}
                multiline
                value={settings.token}
              />
            }
            description={t("metrics.tokenHint")}
            title={<span id={tokenLabel}>{t("metrics.token")}</span>}
          />
          <div className="px-4 py-4 sm:px-6">
            {/* The token masked on screen, as above; Copy copies the job with the whole token. */}
            <CodeBlock
              code={scrapeConfig(origin, settings.path, maskMetricsToken(settings.token))}
              copyLabel={t("metrics.copyScrape")}
              copyValue={scrapeConfig(origin, settings.path, settings.token)}
              language="yaml"
              title={t("metrics.scrapeTitle")}
            />
          </div>
        </>
      ) : null}
    </SettingsGroup>
  );
}
