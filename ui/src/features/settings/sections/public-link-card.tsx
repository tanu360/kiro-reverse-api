import {
  Alert02Icon,
  ExternalLinkIcon,
  InformationCircleIcon,
  Logout03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type JSX, type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { CopyField } from "@/components/shared/code-field";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { SETTINGS_ROW_X, SettingsRow, SwitchField } from "@/components/shared/settings-rows";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Spinner } from "@/components/ui/spinner";
import { announce } from "@/lib/announce";
import { queryKeys } from "@/lib/api/query-keys";
import { serverErrorCode } from "@/lib/api/server-errors";
import {
  logoutTunnel,
  TUNNEL_HOSTNAME,
  TUNNEL_HOSTNAME_MAX,
  type TunnelStatus,
  tunnelErrorText,
  tunnelQuery,
  updateTunnel,
} from "@/lib/api/tunnel";
import { dateTimeFormat, formatBytes } from "@/lib/format";
import { fillNodes, useT } from "@/lib/i18n";
import { deviceNameChars } from "@/lib/input-filters";
import { cn } from "@/lib/utils";
import { SECTION_ID, sectionPagePath } from "./sections";
import {
  FieldControl,
  Hint,
  RowAction,
  RowActionError,
  SectionQuery,
  SettingsGroup,
} from "./settings-section";

const FUNNEL_GUIDE = "https://tailscale.com/docs/features/tailscale-funnel";
/** The admin console's device list, for a helper that does not name the device's own page. */
const TAILSCALE_MACHINES = "https://login.tailscale.com/admin/machines";

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

function PublicLinkPanel({ status }: { status: TunnelStatus }): JSX.Element {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [pending, setPending] = useState<boolean | null>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const setStatus = (next: TunnelStatus) =>
    queryClient.setQueryData(queryKeys.settings.tunnel(), next);
  // No toasts: the switch, the status and the account row change on screen; a failure shows
  // under the row it came from (the device name's own failures stay with its field).
  const save = useMutation({
    mutationFn: updateTunnel,
    onSuccess: (next) => setStatus(next),
    onSettled: () => setPending(null),
  });
  const logout = useMutation({
    mutationFn: logoutTunnel,
    onSuccess: (next) => {
      setStatus(next);
      announce(t("publicLink.signedOut"));
    },
  });
  const enabled = pending ?? status.enabled;
  // A failed switch or Retry (an enabled change); a failed name shows in its own row.
  const failedEnabled =
    save.isError && save.variables?.enabled !== undefined ? save.variables.enabled : undefined;

  const setEnabled = (next: boolean) => {
    setPending(next);
    save.mutate({ enabled: next });
  };

  const toggle = async (next: boolean) => {
    if (!next && status.viaLink) {
      const confirmed = await confirm({
        title: t("publicLink.offTitle"),
        description: t("publicLink.offBody"),
        confirmLabel: t("publicLink.offConfirm"),
        variant: "danger",
      });
      if (!confirmed) return;
    }
    setEnabled(next);
  };

  // Try again sends the same change at once: a turn-off was already confirmed.
  const switchFailure =
    failedEnabled === undefined ? null : (
      <RowActionError
        error={save.error}
        onDismiss={save.reset}
        onRetry={() => setEnabled(failedEnabled)}
      />
    );

  const signOut = async () => {
    const confirmed = await confirm({
      title: t("publicLink.signOutTitle"),
      description: t(status.viaLink ? "publicLink.signOutBodyLink" : "publicLink.signOutBody"),
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
            more={fillNodes(t("common:text.joinSentences"), {
              first: t("publicLink.more"),
              second: (
                <a
                  className="font-medium text-foreground transition-colors duration-150 ease-out hover:text-info-foreground"
                  href={FUNNEL_GUIDE}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t("publicLink.guide")}
                </a>
              ),
            })}
          >
            {t("publicLink.switchHint")}
          </Hint>
        }
        disabled={save.isPending || logout.isPending}
        onCheckedChange={(next) => void toggle(next)}
        title={t("publicLink.switch")}
      >
        {/* A failed Retry of a failed link shows by its button instead. */}
        {status.state === "error" ? null : switchFailure}
      </SwitchField>
      {status.state === "off" ? null : (
        <StatusRow
          onRetry={() => save.mutate({ enabled: true })}
          retrying={save.isPending}
          status={status}
        >
          {status.state === "error" ? switchFailure : null}
        </StatusRow>
      )}
      {status.enabled ? <Warnings status={status} /> : null}
      <DeviceNameRow
        status={status}
        onSave={(hostname, onDone) =>
          save.mutate(
            { hostname },
            {
              onSuccess: (next) => {
                announce(t("common:toast.saved"));
                onDone({ saved: next.hostname });
              },
              onError: (error) =>
                onDone({ refused: serverErrorCode(error) === "tunnel_hostname", error }),
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
                ref={signOutRef}
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
        >
          {/* Try again signs out at once: the sign-out was already confirmed. */}
          {logout.isError ? (
            <RowActionError
              error={logout.error}
              focusTarget={signOutRef}
              onDismiss={logout.reset}
              onRetry={() => logout.mutate()}
            />
          ) : null}
        </SettingsRow>
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

/** Where the link stands: the live link, a failure, or the setup steps on the way to the link. */
function StatusRow({
  status,
  onRetry,
  retrying,
  children,
}: {
  status: TunnelStatus;
  onRetry: () => void;
  retrying: boolean;
  /** Under a failed link's reason: a failed Retry. */
  children?: ReactNode;
}): JSX.Element {
  const { t } = useT("settings");
  const linkLabel = useId();

  if (status.state === "running" && status.url) {
    // The link sits beside its text at its own width (the 18rem field slot broke a ts.net
    // address at its hyphen), and goes under the text on a narrow row.
    return (
      <SettingsRow
        control={
          <CopyField
            copiedMessage={t("publicLink.copied")}
            labelledBy={linkLabel}
            multiline
            openHref={status.url}
            openLabel={t("publicLink.open")}
            value={status.url}
            variant="outline"
          />
        }
        controlWidth="value"
        description={
          status.fallbackHelper ? (
            <>
              {t("publicLink.linkHint")}
              <span className="mt-1 block">{t("publicLink.fallbackHelper")}</span>
            </>
          ) : (
            t("publicLink.linkHint")
          )
        }
        status={
          <Badge live size="sm" tone="success">
            {t("publicLink.live")}
          </Badge>
        }
        title={<span id={linkLabel}>{t("publicLink.link")}</span>}
      />
    );
  }
  if (status.state === "error") {
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
            {tunnelErrorText(status, t) ?? t("publicLink.failed")}
          </span>
        }
        title={t("publicLink.status")}
      >
        {children}
      </SettingsRow>
    );
  }
  return <SetupRow status={status} />;
}

/** The first-time setup, in order: each waiting state stands at one of these steps. */
const SETUP_STEPS = [
  { id: "download", label: "publicLink.stepDownload" },
  { id: "connect", label: "publicLink.stepConnect" },
  { id: "signIn", label: "publicLink.stepSignIn" },
  { id: "funnel", label: "publicLink.stepFunnel" },
  { id: "live", label: "publicLink.stepLive" },
] as const;

/** The step a state stands at, as an index into SETUP_STEPS. */
function setupStep(status: TunnelStatus): number {
  switch (status.state) {
    case "downloading":
      return 0;
    case "needs-login":
    case "needs-approval":
      return 2;
    case "needs-funnel":
      return 3;
    case "running":
      // Funnel is on; the HTTPS certificate is on its way, or the link is going online.
      return 4;
    default:
      return 1;
  }
}

/**
 * The setup steps with the current one's progress or the button for what to do at Tailscale.
 * Tailscale reports "starting" again between steps (after the sign-in, say), so the steps never
 * go back while it does.
 */
function SetupRow({ status }: { status: TunnelStatus }): JSX.Element {
  const { t } = useT("settings");
  const stepsLabel = useId();
  const [reached, setReached] = useState(0);
  const derived = setupStep(status);
  if (status.state !== "starting" && derived !== reached) setReached(derived);
  const current = status.state === "starting" ? Math.max(derived, reached) : derived;

  return (
    <SettingsRow title={<span id={stepsLabel}>{t("publicLink.setup")}</span>}>
      <ol aria-labelledby={stepsLabel} className="mt-3 grid grid-cols-5">
        {SETUP_STEPS.map((step, index) => {
          const done = index < current;
          const now = index === current;
          return (
            <li
              aria-current={now ? "step" : undefined}
              className={cn(
                "relative flex flex-col items-center gap-1.5 text-center text-xs",
                now ? "font-medium text-foreground" : "text-muted-foreground",
              )}
              key={step.id}
            >
              {index > 0 ? (
                // From the previous circle's edge to this one's, 4 px clear of both.
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-[11px] right-[calc(50%+16px)] h-0.5 w-[calc(100%-32px)] rounded-full",
                    index <= current ? "bg-primary" : "bg-border",
                  )}
                />
              ) : null}
              <span
                aria-hidden="true"
                className={cn(
                  "relative grid size-6 place-items-center rounded-full border-2 font-medium text-xs",
                  done
                    ? "border-primary bg-primary text-primary-foreground"
                    : now
                      ? "border-primary bg-card text-primary"
                      : "border-border bg-card",
                )}
              >
                {done ? (
                  <HugeiconsIcon className="size-3.5" icon={Tick02Icon} strokeWidth={2} />
                ) : (
                  index + 1
                )}
              </span>
              <span>
                {t(step.label)}
                {done ? <span className="sr-only"> {t("publicLink.stepDone")}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
        <SetupDetail status={status} />
      </div>
    </SettingsRow>
  );
}

/** What the current step is doing, or the button for what to do at Tailscale. */
function SetupDetail({ status }: { status: TunnelStatus }): JSX.Element {
  const { t, lang } = useT("settings");
  const waiting = (text: string, button?: ReactNode) => (
    <>
      <p className="min-w-0 flex-1 basis-48 text-muted-foreground text-xs">{text}</p>
      {button}
    </>
  );
  const busy = (text: string) => (
    <p className="text-muted-foreground text-xs">
      <Busy>{text}</Busy>
    </p>
  );

  switch (status.state) {
    case "downloading": {
      const { downloaded, total, progress } = status;
      if (total === undefined || progress === undefined) return busy(t("publicLink.downloading"));
      const amount = t("publicLink.downloadedOf", {
        downloaded: formatBytes(downloaded ?? 0, lang),
        total: formatBytes(total, lang),
        percent: progress,
      });
      return (
        <div className="flex w-full flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-foreground">
              <Busy>{t("publicLink.downloading")}</Busy>
            </span>
            <span className="text-muted-foreground tabular-nums">{amount}</span>
          </div>
          <Meter
            aria-label={t("publicLink.progressLabel")}
            getAriaValueText={() => amount}
            value={progress}
          >
            <MeterTrack className="h-1.5">
              <MeterIndicator />
            </MeterTrack>
          </Meter>
        </div>
      );
    }
    case "needs-login":
      return status.authURL
        ? waiting(
            t("publicLink.needsLogin"),
            <TailscaleLink href={status.authURL}>{t("publicLink.signIn")}</TailscaleLink>,
          )
        : busy(t("publicLink.starting"));
    case "needs-approval":
      return waiting(
        t("publicLink.needsApproval"),
        status.adminURL ? (
          <TailscaleLink href={status.adminURL}>{t("publicLink.openAdmin")}</TailscaleLink>
        ) : undefined,
      );
    case "needs-funnel":
      return waiting(
        t("publicLink.needsFunnel"),
        status.enableURL ? (
          <TailscaleLink href={status.enableURL}>{t("publicLink.enableFunnel")}</TailscaleLink>
        ) : undefined,
      );
    case "running":
      // The link shows once it opens from the internet; a Tailscale relay that has not heard of
      // the device yet drops visitors, sometimes for minutes.
      return status.publishing ? (
        <div className="flex flex-col gap-1 text-muted-foreground text-xs">
          <p>
            <Busy>{t("publicLink.publishing")}</Busy>
          </p>
          {/* Under the text, clear of the spinner (size-3 plus Busy's gap-1.5). */}
          <p className="ps-4.5">{t("publicLink.publishingHint")}</p>
        </div>
      ) : (
        busy(t("publicLink.certificate"))
      );
    default:
      return busy(t("publicLink.starting"));
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

/**
 * What to fix before sharing the link (two-factor sign-in off, no API key for public calls), and
 * the day Tailscale's key for this device runs out, which stops the link. The key line goes once
 * key expiry is off for the device: the helper reports that within seconds.
 */
function Warnings({ status }: { status: TunnelStatus }): JSX.Element | null {
  const { t, lang } = useT("settings");
  const keyExpiry = status.state === "running" && status.url ? status.keyExpiry : undefined;
  if (status.twoFactor && status.apiKeys && !keyExpiry) return null;
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
      {keyExpiry ? (
        <Alert role="status" size="sm" variant="info">
          <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
          <AlertDescription>
            {t("publicLink.keyExpiry", {
              date: dateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(keyExpiry)),
            })}
          </AlertDescription>
          <AlertAction>
            <Button
              render={
                <a
                  href={status.machineURL ?? TAILSCALE_MACHINES}
                  rel="noopener noreferrer"
                  target="_blank"
                />
              }
              size="xs"
              variant="tone"
            >
              {t("publicLink.keyExpiryAction")}
              <HugeiconsIcon icon={ExternalLinkIcon} aria-hidden="true" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </div>
  );
}

/** The tailnet's part of a live link ("tail1234.ts.net"), or undefined while there is none. */
function tailnetDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    const dot = host.indexOf(".");
    return dot > 0 ? host.slice(dot + 1) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The device name, the first part of the link: typed as one DNS label (lowercase letters, digits,
 * hyphens) and saved on blur or Enter; an empty field saves the default name. A name the server
 * refuses shows under the field. A page that came through the link cannot change it: a new name
 * moves the link, and the page with it.
 */
function DeviceNameRow({
  status,
  onSave,
}: {
  status: TunnelStatus;
  onSave: (
    hostname: string,
    onDone: (result: { saved?: string; refused?: boolean; error?: unknown }) => void,
  ) => void;
}): JSX.Element {
  const { t } = useT("settings");
  const inputId = useId();
  const [draft, setDraft] = useState(status.hostname);
  const [synced, setSynced] = useState(status.hostname);
  // The name on its way to the server: Enter then blur must not save it twice. A save that lands
  // a new name clears it below; a failure, or a save the server answers with the current name
  // (so nothing below runs), clears it through onSave.
  const [sent, setSent] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // A save that failed for another reason than the name: shown under the row, with Try again.
  const [failure, setFailure] = useState<unknown>(null);
  const name = draft || status.defaultHostname;
  const link = `https://${name}.${tailnetDomain(status.url) ?? "<tailnet>.ts.net"}`;

  // A new name from the server (a save, another tab) resets the field, unless the user is typing
  // another one. Not remounting keeps focus in the field after Enter.
  if (status.hostname !== synced) {
    setSynced(status.hostname);
    setSent(null);
    if (draft === synced || name === sent) setDraft(status.hostname);
  }

  const commit = () => {
    if (sent !== null) return;
    if (name === status.hostname) {
      setDraft(name);
      setInvalid(false);
      return;
    }
    if (!TUNNEL_HOSTNAME.test(name)) {
      setInvalid(true);
      return;
    }
    setSent(name);
    setFailure(null);
    const current = status.hostname;
    onSave(name, ({ saved, refused, error }) => {
      if (saved === undefined || saved === current) setSent(null);
      if (refused) setInvalid(true);
      else if (error !== undefined) setFailure(error);
    });
  };

  return (
    <SettingsRow
      control={
        <FieldControl error={invalid ? t("publicLink.deviceNameInvalid") : null}>
          <Input
            autoCapitalize="none"
            autoComplete="off"
            disabled={status.viaLink}
            id={inputId}
            maxLength={TUNNEL_HOSTNAME_MAX}
            onBlur={commit}
            onChange={(event) => {
              setDraft(deviceNameChars(event.target.value));
              setInvalid(false);
              setFailure(null);
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
      description={
        status.viaLink ? t("publicLink.deviceNameLocked") : t("publicLink.deviceNameHint", { link })
      }
      htmlFor={inputId}
      title={t("publicLink.deviceName")}
    >
      {failure === null ? null : (
        <RowActionError error={failure} onDismiss={() => setFailure(null)} onRetry={commit} />
      )}
    </SettingsRow>
  );
}
