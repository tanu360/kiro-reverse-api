import { type FormEvent, type JSX, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { importCredentials } from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { FlowGuide, FormField, SubmitButton } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";

type CookieProvider = "Google" | "Github";

/** Kiro web cookie: the RefreshToken cookie of app.kiro.dev, a social sign-in. */
export function CookieFlow(): JSX.Element {
  const { t } = useT("add-account");
  const display = useDisplayEmail();
  const { sessions, finishAdd } = useFlow();
  const formId = useFormId();
  const [provider, setProvider] = useState<CookieProvider>("Google");
  const [refreshToken, setRefreshToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useReportBusy(pending);
  const focusAfter = useFocusAfter(pending);
  const tokenRef = useRef<HTMLTextAreaElement>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const token = refreshToken.trim();
    if (!token) {
      setError(t("cookie.refreshTokenMissing"));
      focusAfter(tokenRef);
      return;
    }
    setError(null);
    const generation = sessions.generation;
    setPending(true);
    try {
      const res = await importCredentials({
        refreshToken: token,
        accessToken: "",
        clientId: "",
        clientSecret: "",
        authMethod: "social",
        provider,
      });
      if (!sessions.isCurrent(generation)) return;
      toast.success(t("success", { name: display(res.account.email, res.account.id) }));
      finishAdd([res.account]);
    } catch (caught) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("failed", { error: errorMessage(caught, t) }));
        focusAfter(tokenRef);
      }
    } finally {
      setPending(false);
    }
  };

  const link = t("cookie.link");
  // The site's origin, where DevTools lists its cookies.
  const host = link.replace(/^(https?:\/\/[^/]+).*$/, "$1");
  const items = [
    { value: "Google", label: t("cookie.google") },
    { value: "Github", label: t("cookie.github") },
  ];

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      <FlowGuide title={t("cookie.howToGet")}>
        <li>
          {t("cookie.step1")}{" "}
          <Button
            render={<a href={link} rel="noopener noreferrer" target="_blank" />}
            variant="link-inline"
          >
            {link}
          </Button>
        </li>
        <li>
          {t("cookie.step2")} <Code>{host}</Code>
        </li>
        <li>
          {t("cookie.step3")} <Code>RefreshToken</Code>
        </li>
      </FlowGuide>
      <FormField label={t("cookie.provider")}>
        <Select
          disabled={pending}
          items={items}
          onValueChange={(value) => {
            if (value) setProvider(value as CookieProvider);
          }}
          value={provider}
        >
          <SelectTrigger>
            <SelectValue />
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
      <FormField error={error} label={t("cookie.refreshToken")}>
        <Textarea
          autoComplete="off"
          disabled={pending}
          onChange={(event) => setRefreshToken(event.target.value)}
          placeholder={t("cookie.refreshTokenPlaceholder")}
          ref={tokenRef}
          spellCheck={false}
          value={refreshToken}
          variant="mono"
        />
      </FormField>
      <FlowFooter>
        <SubmitButton busy={pending} busyLabel={t("adding")} formId={formId} label={t("add")} />
      </FlowFooter>
    </form>
  );
}
