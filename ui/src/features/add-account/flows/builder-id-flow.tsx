import { ExternalLinkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, type JSX, useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { pollBuilderId, startBuilderId } from "@/lib/api/auth-flows";
import { isApiError } from "@/lib/api/errors";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { FlowNote, FlowSteps, RegionField, SubmitButton, UrlBox } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import { parseRegion } from "../lib/region";
import { reloginRegion } from "../lib/relogin-method";
import { useReloginFlow } from "../relogin";

const DEFAULT_INTERVAL_S = 5;
/** Network failures in a row before polling gives up. */
const MAX_NETWORK_RETRIES = 3;

interface DeviceCode {
  userCode: string;
  verificationUri: string;
}

/** AWS Builder ID device-code sign-in: show the code, then poll until the user approves it. */
export function BuilderIdFlow(): JSX.Element {
  const { t } = useT("add-account");
  const { sessions, finishAdd } = useFlow();
  const relogin = useReloginFlow();
  const formId = useFormId();
  const [region, setRegion] = useState(() => reloginRegion(relogin.target));
  const [regionError, setRegionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  useReportBusy(starting);
  const focusAfter = useFocusAfter(starting);
  const regionRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  // The poll chain reads the latest render's helpers, not the ones from when it started.
  const latest = useRef({ t, relogin, finishAdd, focusAfter });
  latest.current = { t, relogin, finishAdd, focusAfter };

  // Stop polling if this view goes away while the dialog stays open.
  useEffect(() => () => sessions.stopBuilderId(), [sessions]);

  const schedule = (generation: number, intervalS: number, networkFailures: number) => {
    sessions.builderIdTimer = setTimeout(async () => {
      sessions.builderIdTimer = null;
      const sessionId = sessions.builderIdSession;
      if (!sessionId || !sessions.isCurrent(generation)) return;
      const { t: tr, relogin: again, finishAdd: finish, focusAfter: refocus } = latest.current;
      try {
        const res = await pollBuilderId({ sessionId });
        if (!sessions.isCurrent(generation) || sessions.builderIdSession !== sessionId) return;
        if (res.completed) {
          sessions.stopBuilderId();
          again.announce(res);
          finish([res.account]);
          return;
        }
        setReconnecting(false);
        // slow_down raises the interval; always follow the latest one.
        schedule(generation, res.interval || intervalS, 0);
      } catch (error) {
        if (!sessions.isCurrent(generation) || sessions.builderIdSession !== sessionId) return;
        if (isApiError(error) && error.status === 0 && networkFailures < MAX_NETWORK_RETRIES) {
          setReconnecting(true);
          schedule(generation, intervalS, networkFailures + 1);
          return;
        }
        sessions.stopBuilderId();
        setCode(null);
        setReconnecting(false);
        if (!(await again.resolveMismatch(error))) {
          toast.error(tr(again.failedKey, { error: errorMessage(error, tr) }));
        }
        // Back on the first step; the code view and its focus are gone.
        refocus(regionRef);
      }
    }, intervalS * 1000);
  };

  const onStart = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (starting) return;
    const parsed = parseRegion(region);
    if (!parsed.ok) {
      setRegionError(t("regionInvalid"));
      focusAfter(regionRef);
      return;
    }
    setRegionError(null);
    setStarting(true);
    const generation = sessions.generation;
    try {
      const res = await startBuilderId({
        region: parsed.region,
        reloginAccountId: relogin.accountId,
      });
      if (!sessions.isCurrent(generation)) return;
      sessions.stopBuilderId();
      sessions.builderIdSession = res.sessionId;
      setCode({ userCode: res.userCode, verificationUri: res.verificationUri });
      focusAfter(codeRef);
      schedule(generation, res.interval || DEFAULT_INTERVAL_S, 0);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("startFailed", { error: errorMessage(error, t) }));
        focusAfter(regionRef);
      }
    } finally {
      setStarting(false);
    }
  };

  if (code) {
    return (
      <div className="flex flex-col gap-4">
        <FlowSteps
          steps={[
            {
              state: "done",
              title: t("builderid.stepCode"),
              children: (
                // The code is the new step's main content, so it takes focus when the step opens.
                <div
                  className="flex max-w-full items-center gap-2 self-start rounded-lg outline-none focus-outline"
                  ref={codeRef}
                  tabIndex={-1}
                >
                  <span className="sr-only">{t("builderid.userCode")}</span>
                  <UserCode code={code.userCode} />
                  <CopyButton
                    label={t("builderid.copyCode")}
                    size="icon-sm"
                    value={code.userCode}
                    variant="quiet"
                  />
                </div>
              ),
            },
            {
              state: "current",
              title: t("builderid.stepApprove"),
              children: (
                <>
                  <FlowNote>{t("builderid.verifyCode")}</FlowNote>
                  <UrlBox
                    label={t("builderid.verifyUrl")}
                    showOpen={false}
                    url={code.verificationUri}
                  />
                </>
              ),
            },
            {
              state: "todo",
              title: t("stepAdded"),
              children: (
                <p
                  aria-live="polite"
                  className="flex items-center gap-2 text-muted-foreground text-sm"
                  role="status"
                >
                  <Spinner aria-hidden="true" className="size-4" />
                  {reconnecting ? t("builderid.reconnecting") : t("builderid.waiting")}
                </p>
              ),
            },
          ]}
        />
        <FlowFooter>
          <Button
            render={<a href={code.verificationUri} rel="noopener noreferrer" target="_blank" />}
          >
            {t("builderid.openPage")}
            <HugeiconsIcon aria-hidden="true" icon={ExternalLinkIcon} />
          </Button>
        </FlowFooter>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-5" id={formId} noValidate onSubmit={onStart}>
      <FlowSteps
        steps={[
          {
            state: "current",
            title: t("builderid.stepCode"),
            children: <FlowNote>{t("builderid.startNote")}</FlowNote>,
          },
          { state: "todo", title: t("builderid.stepApprove") },
          { state: "todo", title: t("stepAdded") },
        ]}
      />
      <RegionField
        disabled={starting}
        error={regionError}
        inputRef={regionRef}
        onChange={setRegion}
        value={region}
      />
      <FlowFooter>
        <SubmitButton busy={starting} formId={formId} label={t("startSignIn")} />
      </FlowFooter>
    </form>
  );
}

/**
 * The device code as one tile per character (the dash between the halves stays plain), mono and
 * large, so it reads at a glance; on a narrow phone the tiles shrink to fit the line. Screen
 * readers get the code once, whole.
 */
function UserCode({ code }: { code: string }): JSX.Element {
  const chars = Array.from(code, (char, position) => ({ char, id: `${position}${char}` }));
  return (
    <kbd className="flex min-w-0 items-center gap-1 font-mono font-semibold text-xl sm:gap-1.5">
      <span className="sr-only">{code}</span>
      {chars.map(({ char, id }) =>
        char === "-" ? (
          <span aria-hidden="true" className="px-0.5 text-muted-foreground" key={id}>
            –
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="flex h-10 w-8 min-w-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-2"
            key={id}
          >
            {char}
          </span>
        ),
      )}
    </kbd>
  );
}
