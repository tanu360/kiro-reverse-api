import { Alert02Icon, ExternalLinkIcon, Logout03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type JSX, type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { CopyField } from "@/components/shared/code-field";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { SETTINGS_ROW_X, SettingsRow, SwitchField } from "@/components/shared/settings-rows";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Spinner } from "@/components/ui/spinner";
import { queryKeys } from "@/lib/api/query-keys";
import { serverErrorCode } from "@/lib/api/server-errors";
import {
  logoutTunnel,
  TUNNEL_HOSTNAME,
  TUNNEL_HOSTNAME_MAX,
  type TunnelStatus,
  tunnelQuery,
  updateTunnel,
} from "@/lib/api/tunnel";
import { useT } from "@/lib/i18n";
import { deviceNameChars } from "@/lib/input-filters";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { SECTION_ID, sectionPagePath } from "./sections";
import {
  FieldControl,
  Hint,
  RowAction,
  SectionQuery,
  SettingsGroup,
  toastSaveFailed,
} from "./settings-section";

const FUNNEL_GUIDE = "https://tailscale.com/docs/features/tailscale-funnel";

/**
 * Settings card for the public link: Tailscale Funnel puts this server, dashboard and API alike,
 * on https://<device>.<tailnet>.ts.net. The server runs Tailscale's helper; the card shows where
 * it stands and the one thing the user must do at Tailscale (sign in, approve, turn on Funnel).
 */
export function PublicLinkCard(): JSX.Element {
  const { t } = useT("settings");
  const query = useQuery(tunnelQuery());
  return (
    <SectionQuery id={SECTION_ID.publicLink} query={query} title={t("publicLink.title")}>
      {(status) => <PublicLinkPanel status={status} />}
    </SectionQuery>
  );
}

/** Whether this page itself was opened through the public link (turning it off disconnects it). */
function openedThroughLink(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}

function PublicLinkPanel({ status }: { status: TunnelStatus }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [pending, setPending] = useState<boolean | null>(null);
  const setStatus = (next: TunnelStatus) =>
    queryClient.setQueryData(queryKeys.settings.tunnel(), next);
  const save = useMutation({
    mutationFn: updateTunnel,
    onSuccess: (next) => setStatus(next),
    onError: (error) => toastSaveFailed(error, t),
    onSettled: () => setPending(null),
  });
  const logout = useMutation({
    mutationFn: logoutTunnel,
    onSuccess: (next) => {
      setStatus(next);
      toast.success(t("publicLink.signedOut"));
    },
    onError: (error) => toastSaveFailed(error, t),
  });
  const enabled = pending ?? status.enabled;

  const toggle = async (next: boolean) => {
    if (!next && openedThroughLink(status.url)) {
      const confirmed = await confirm({
        title: t("publicLink.offTitle"),
        description: t("publicLink.offBody"),
        confirmLabel: t("publicLink.offConfirm"),
        variant: "danger",
      });
      if (!confirmed) return;
    }
    setPending(next);
    save.mutate({ enabled: next });
  };

  const signOut = async () => {
    const confirmed = await confirm({
      title: t("publicLink.signOutTitle"),
      description: t("publicLink.signOutBody"),
      confirmLabel: t("publicLink.signOut"),
      variant: "danger",
    });
    if (confirmed) logout.mutate();
  };

  return (
    <SettingsGroup
      description={t("publicLink.hint")}
      id={SECTION_ID.publicLink}
      title={t("publicLink.title")}
    >
      <SwitchField
        checked={enabled}
        description={
          <Hint
            more={
              <>
                {t("publicLink.more")}{" "}
                <a
                  className="font-medium text-foreground underline decoration-dotted underline-offset-3 hover:decoration-solid"
                  href={FUNNEL_GUIDE}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t("publicLink.guide")}
                </a>
              </>
            }
          >
            {t("publicLink.switchHint")}
          </Hint>
        }
        disabled={save.isPending || logout.isPending}
        onCheckedChange={(next) => void toggle(next)}
        title={t("publicLink.switch")}
      />
      {status.state === "off" ? null : (
        <StatusRow
          onRetry={() => save.mutate({ enabled: true })}
          retrying={save.isPending}
          status={status}
        />
      )}
      {status.enabled ? <Warnings status={status} /> : null}
      <DeviceNameRow
        // A new name from the server (a save, another tab) resets the field.
        key={status.hostname}
        status={status}
        onSave={(hostname, onRefused) =>
          save.mutate(
            { hostname },
            {
              onSuccess: () => toast.success(t("saved")),
              onError: (error) => {
                if (serverErrorCode(error) === "tunnel_hostname") onRefused();
              },
            },
          )
        }
      />
      {status.signedIn ? (
        <SettingsRow
          control={
            <RowAction>
              <Button
                loading={logout.isPending}
                onClick={() => void signOut()}
                size="sm"
                variant="danger"
              >
                <HugeiconsIcon icon={Logout03Icon} aria-hidden="true" />
                {t("publicLink.signOut")}
              </Button>
            </RowAction>
          }
          controlWidth="actions"
          description={t("publicLink.accountHint")}
          title={t("publicLink.account")}
        />
      ) : null}
    </SettingsGroup>
  );
}

/** A button that opens a Tailscale page in a new tab, with the external-link arrow. */
function TailscaleLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <Button render={<a href={href} rel="noopener noreferrer" target="_blank" />} size="sm">
      {children}
      <HugeiconsIcon icon={ExternalLinkIcon} aria-hidden="true" />
    </Button>
  );
}

/** Where the link stands, with the step the user takes at Tailscale when it waits on one. */
function StatusRow({
  status,
  onRetry,
  retrying,
}: {
  status: TunnelStatus;
  onRetry: () => void;
  retrying: boolean;
}): JSX.Element {
  const { t } = useT("settings");
  const linkLabel = useId();
  const title = t("publicLink.status");

  switch (status.state) {
    case "running":
      if (status.url) {
        // The link takes the row's width under its text: in the 18rem control slot a
        // ts.net address broke across two lines at its hyphen.
        return (
          <SettingsRow
            description={t("publicLink.linkHint")}
            status={
              <Badge live size="sm" tone="success">
                {t("publicLink.live")}
              </Badge>
            }
            title={<span id={linkLabel}>{t("publicLink.link")}</span>}
          >
            <CopyField
              className="mt-2 max-w-lg"
              copiedMessage={t("publicLink.copied")}
              labelledBy={linkLabel}
              multiline
              openHref={status.url}
              openLabel={t("publicLink.open")}
              value={status.url}
            />
          </SettingsRow>
        );
      }
      return <SettingsRow description={<Busy>{t("publicLink.starting")}</Busy>} title={title} />;
    case "downloading": {
      const percent = status.progress;
      return (
        <SettingsRow
          description={
            percent === undefined
              ? t("publicLink.downloading")
              : t("publicLink.downloadingPercent", { percent })
          }
          title={title}
        >
          {percent === undefined ? null : (
            <Meter
              aria-label={t("publicLink.progressLabel")}
              className="max-w-xs pt-1"
              value={percent}
            >
              <MeterTrack>
                <MeterIndicator />
              </MeterTrack>
            </Meter>
          )}
        </SettingsRow>
      );
    }
    case "needs-login":
      return (
        <SettingsRow
          control={
            status.authURL ? (
              <RowAction>
                <TailscaleLink href={status.authURL}>{t("publicLink.signIn")}</TailscaleLink>
              </RowAction>
            ) : undefined
          }
          controlWidth="actions"
          description={t("publicLink.needsLogin")}
          title={title}
        />
      );
    case "needs-approval":
      return (
        <SettingsRow
          control={
            status.adminURL ? (
              <RowAction>
                <TailscaleLink href={status.adminURL}>{t("publicLink.openAdmin")}</TailscaleLink>
              </RowAction>
            ) : undefined
          }
          controlWidth="actions"
          description={t("publicLink.needsApproval")}
          title={title}
        />
      );
    case "needs-funnel":
      return (
        <SettingsRow
          control={
            status.enableURL ? (
              <RowAction>
                <TailscaleLink href={status.enableURL}>
                  {t("publicLink.enableFunnel")}
                </TailscaleLink>
              </RowAction>
            ) : undefined
          }
          controlWidth="actions"
          description={t("publicLink.needsFunnel")}
          title={title}
        />
      );
    case "error":
      return (
        <SettingsRow
          control={
            <RowAction>
              <Button loading={retrying} onClick={onRetry} size="sm" variant="secondary">
                {t("publicLink.retry")}
              </Button>
            </RowAction>
          }
          controlWidth="actions"
          description={
            <span className="text-destructive-foreground">
              {status.error ?? t("publicLink.failed")}
            </span>
          }
          title={title}
        />
      );
    default:
      return <SettingsRow description={<Busy>{t("publicLink.starting")}</Busy>} title={title} />;
  }
}

/** A status line with a small spinner before it. */
function Busy({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Spinner aria-hidden="true" className="size-3" />
      {children}
    </span>
  );
}

/** What to fix before sharing the link: two-factor sign-in off, or no API key for public calls. */
function Warnings({ status }: { status: TunnelStatus }): JSX.Element | null {
  const { t } = useT("settings");
  if (status.twoFactor && status.apiKeys) return null;
  return (
    <div className={cn(SETTINGS_ROW_X, "flex flex-col gap-2 py-4")} data-slot="settings-row">
      {status.twoFactor ? null : (
        <Alert role="status" size="sm" variant="warning">
          <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
          <AlertDescription>{t("publicLink.twoFactorWarning")}</AlertDescription>
          <AlertAction>
            <Button
              render={
                <Link hash={SECTION_ID.twoFactor} to={sectionPagePath(SECTION_ID.twoFactor)} />
              }
              size="xs"
              variant="tone"
            >
              {t("publicLink.twoFactorAction")}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {status.apiKeys ? null : (
        <Alert role="status" size="sm" variant="warning">
          <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
          <AlertDescription>{t("publicLink.apiKeysWarning")}</AlertDescription>
          <AlertAction>
            <Button render={<Link to="/api" />} size="xs" variant="tone">
              {t("publicLink.apiKeysAction")}
            </Button>
          </AlertAction>
        </Alert>
      )}
    </div>
  );
}

/**
 * The device name, the first part of the link: typed as one DNS label (lowercase letters, digits,
 * hyphens) and saved on blur or Enter. A name the server refuses shows under the field.
 */
function DeviceNameRow({
  status,
  onSave,
}: {
  status: TunnelStatus;
  onSave: (hostname: string, onRefused: () => void) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const inputId = useId();
  const [draft, setDraft] = useState(status.hostname);
  const [invalid, setInvalid] = useState(false);

  const commit = () => {
    if (draft === status.hostname) {
      setInvalid(false);
      return;
    }
    if (!TUNNEL_HOSTNAME.test(draft)) {
      setInvalid(true);
      return;
    }
    onSave(draft, () => setInvalid(true));
  };

  return (
    <SettingsRow
      control={
        <FieldControl error={invalid ? t("publicLink.deviceNameInvalid") : null}>
          <Input
            autoCapitalize="none"
            autoComplete="off"
            id={inputId}
            maxLength={TUNNEL_HOSTNAME_MAX}
            onBlur={commit}
            onChange={(event) => {
              setDraft(deviceNameChars(event.target.value));
              setInvalid(false);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commit();
            }}
            placeholder={status.defaultHostname}
            spellCheck={false}
            value={draft}
          />
        </FieldControl>
      }
      description={t("publicLink.deviceNameHint", { name: draft || status.defaultHostname })}
      htmlFor={inputId}
      title={t("publicLink.deviceName")}
    />
  );
}
