import { Loader2Icon } from "lucide-react";
import { type FormEvent, type JSX, useEffect, useRef, useState } from "react";
import { pollBuilderId, startBuilderId } from "@/lib/api/auth-flows";
import { isApiError } from "@/lib/api/errors";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { HelpText, RegionField, SubmitButton, UrlBox } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import { parseRegion } from "../lib/region";

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
  const display = useDisplayEmail();
  const { sessions, finishAdd } = useFlow();
  const formId = useFormId();
  const [region, setRegion] = useState("us-east-1");
  const [regionError, setRegionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  useReportBusy(starting);
  const focusAfter = useFocusAfter(starting);
  const regionRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  // The poll chain reads the latest render's helpers, not the ones from when it started.
  const latest = useRef({ t, display, finishAdd, focusAfter });
  latest.current = { t, display, finishAdd, focusAfter };

  // Stop polling if this view goes away while the dialog stays open.
  useEffect(() => () => sessions.stopBuilderId(), [sessions]);

  const schedule = (generation: number, intervalS: number, networkFailures: number) => {
    sessions.builderIdTimer = setTimeout(async () => {
      sessions.builderIdTimer = null;
      const sessionId = sessions.builderIdSession;
      if (!sessionId || !sessions.isCurrent(generation)) return;
      const { t: tr, display: show, finishAdd: finish, focusAfter: refocus } = latest.current;
      try {
        const res = await pollBuilderId({ sessionId });
        if (!sessions.isCurrent(generation) || sessions.builderIdSession !== sessionId) return;
        if (res.completed) {
          sessions.stopBuilderId();
          toast.success(tr("success", { name: show(res.account.email, res.account.id) }));
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
        toast.error(tr("failed", { error: errorMessage(error, tr) }));
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
      const res = await startBuilderId({ region: parsed.region });
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
      <div className="flex flex-col gap-5">
        {/* The code is the new step's main content, so it takes focus when the step opens. */}
        <div
          className="flex flex-col items-center gap-2 rounded-xl border bg-muted/40 px-4 py-5 text-center outline-none focus-visible:border-ring"
          ref={codeRef}
          tabIndex={-1}
        >
          <span className="sr-only">{t("builderid.userCode")}</span>
          <kbd className="select-all rounded-lg border bg-background px-4 py-2 font-mono font-semibold text-2xl tracking-[0.2em] sm:text-3xl">
            {code.userCode}
          </kbd>
          <HelpText>{t("builderid.verifyCode")}</HelpText>
        </div>
        <UrlBox label={t("builderid.verifyUrl")} url={code.verificationUri} />
        <p
          aria-live="polite"
          className="flex items-center justify-center gap-2 text-muted-foreground text-sm"
          role="status"
        >
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          {reconnecting ? t("builderid.reconnecting") : t("builderid.waiting")}
        </p>
        <FlowFooter />
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onStart}>
      <HelpText>{t("methods.builderid.description")}</HelpText>
      <RegionField
        disabled={starting}
        error={regionError}
        inputRef={regionRef}
        onChange={setRegion}
        value={region}
      />
      <FlowFooter>
        <SubmitButton
          busy={starting}
          busyLabel={t("starting")}
          formId={formId}
          label={t("startSignIn")}
        />
      </FlowFooter>
    </form>
  );
}
