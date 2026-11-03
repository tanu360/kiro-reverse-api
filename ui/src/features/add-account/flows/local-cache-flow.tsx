import { UploadIcon } from "lucide-react";
import { type ChangeEvent, type FormEvent, type JSX, useRef, useState } from "react";
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
import { Code, FormAlert, FormField, HelpText, SubmitButton } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import {
  buildLocalCachePayload,
  isSocialProvider,
  LOCAL_PROVIDERS,
  type LocalCacheError,
  type LocalProvider,
} from "../lib/local-cache";

/** A JSON textarea with an Upload button that reads a .json file into it. */
function JsonFileInput({
  file,
  value,
  onChange,
  disabled,
}: {
  file: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}): JSX.Element {
  const { t } = useT("add-account");
  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    picked.text().then(onChange, () => toast.error(t("local.readFailed")));
  };

  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-start">
      <Textarea
        autoComplete="off"
        className="font-mono"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("local.pasteOrUpload")}
        spellCheck={false}
        value={value}
      />
      <input
        accept=".json,application/json"
        className="hidden"
        onChange={onFile}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
      <Button
        aria-label={t("local.uploadFile", { file })}
        className="h-10 shrink-0 sm:h-8"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        size="sm"
        variant="outline"
      >
        <UploadIcon aria-hidden="true" />
        {t("local.upload")}
      </Button>
    </div>
  );
}

/** Kiro IDE local cache: kiro-auth-token.json plus, for IdC, the {hash}.json client file. */
export function LocalCacheFlow(): JSX.Element {
  const { t } = useT("add-account");
  const display = useDisplayEmail();
  const { sessions, finishAdd } = useFlow();
  const formId = useFormId();
  const [provider, setProvider] = useState<LocalProvider>("BuilderId");
  const [tokenJson, setTokenJson] = useState("");
  const [clientJson, setClientJson] = useState("");
  const [problem, setProblem] = useState<LocalCacheError | null>(null);
  const [pending, setPending] = useState(false);
  useReportBusy(pending);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const built = buildLocalCachePayload({ provider, tokenJson, clientJson });
    if (!built.ok) {
      setProblem(built.error);
      return;
    }
    setProblem(null);
    const generation = sessions.generation;
    setPending(true);
    try {
      const res = await importCredentials(built.payload);
      if (!sessions.isCurrent(generation)) return;
      toast.success(t("success", { name: display(res.account.email, res.account.id) }));
      finishAdd([res.account]);
    } catch (error) {
      if (sessions.isCurrent(generation)) {
        toast.error(t("failed", { error: errorMessage(error, t) }));
      }
    } finally {
      setPending(false);
    }
  };

  const showClient = !isSocialProvider(provider);
  const items = LOCAL_PROVIDERS.map((value) => ({
    value,
    label: t(`local.providers.${value}`),
  }));

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      <HelpText>{t("methods.local.description")}</HelpText>
      <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
        <span className="font-medium">{t("local.fileLocation")}</span>
        <span className="text-muted-foreground">
          {t("local.windows")}: <Code>%USERPROFILE%\.aws\sso\cache\</Code>
        </span>
        <span className="text-muted-foreground">
          {t("local.macosLinux")}: <Code>~/.aws/sso/cache/</Code>
        </span>
      </div>
      <FormField label={t("local.provider")}>
        <Select
          disabled={pending}
          items={items}
          onValueChange={(value) => {
            if (value) setProvider(value as LocalProvider);
          }}
          value={provider}
        >
          <SelectTrigger className="h-10 sm:h-8">
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
      <FormField
        label={
          <>
            <span className="font-mono">{t("local.tokenFile")}</span>
            <span className="font-normal text-muted-foreground text-xs">
              {t("local.tokenRequired")}
            </span>
          </>
        }
      >
        <JsonFileInput
          disabled={pending}
          file={t("local.tokenFile")}
          onChange={setTokenJson}
          value={tokenJson}
        />
      </FormField>
      {showClient ? (
        <FormField
          label={
            <>
              <span className="font-mono">{t("local.clientFile")}</span>
              <span className="font-normal text-muted-foreground text-xs">
                {provider === "Microsoft"
                  ? t("local.clientOptionalMicrosoft")
                  : t("local.clientRequired")}
              </span>
            </>
          }
        >
          <JsonFileInput
            disabled={pending}
            file={t("local.clientFile")}
            onChange={setClientJson}
            value={clientJson}
          />
        </FormField>
      ) : null}
      {problem ? (
        <FormAlert>
          {t(`local.${problem.key}`, problem.params)}
          {problem.hint ? ` ${t(`local.${problem.hint}`)}` : null}
        </FormAlert>
      ) : null}
      <FlowFooter>
        <SubmitButton busy={pending} busyLabel={t("adding")} formId={formId} label={t("add")} />
      </FlowFooter>
    </form>
  );
}
