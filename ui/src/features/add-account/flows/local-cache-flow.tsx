import { Upload01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ChangeEvent, type FormEvent, type JSX, type Ref, useRef, useState } from "react";
import { Code } from "@/components/shared/code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { importCredentials } from "@/lib/api/auth-flows";
import { errorMessage } from "@/lib/api/server-errors";
import { fillNodes, useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { FlowGuide, FormField, ProviderLogo, SubmitButton } from "../fields";
import { FlowFooter, useFlow, useFormId, useReportBusy } from "../flow-context";
import { useFocusAfter } from "../focus";
import {
  buildLocalCachePayload,
  isSocialProvider,
  LOCAL_PROVIDERS,
  type LocalCacheError,
  type LocalProvider,
  localCacheErrorField,
} from "../lib/local-cache";
import { useReloginFlow } from "../relogin";

/**
 * A JSON textarea with an Upload button in its bottom bar that reads a .json file into it.
 * The file input sits outside the group, so the group's click-to-focus finds the textarea.
 */
function JsonFileInput({
  file,
  value,
  onChange,
  disabled,
  placeholder,
  textareaRef,
}: {
  file: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  textareaRef: Ref<HTMLTextAreaElement>;
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
    <>
      <InputGroup>
        <InputGroupTextarea
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          ref={textareaRef}
          spellCheck={false}
          value={value}
          variant="mono"
        />
        <InputGroupAddon align="block-end">
          <Button
            aria-label={t("local.uploadFile", { file })}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            size="xs"
            variant="secondary"
          >
            <HugeiconsIcon icon={Upload01Icon} aria-hidden="true" />
            {t("local.upload")}
          </Button>
        </InputGroupAddon>
      </InputGroup>
      <input
        accept=".json,application/json"
        className="hidden"
        onChange={onFile}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
    </>
  );
}

/** Kiro IDE local cache: kiro-auth-token.json plus, for IdC, the {hash}.json client file. */
export function LocalCacheFlow(): JSX.Element {
  const { t } = useT("add-account");
  const { sessions, finishAdd } = useFlow();
  const relogin = useReloginFlow();
  const formId = useFormId();
  const [provider, setProvider] = useState<LocalProvider>("BuilderId");
  const [tokenJson, setTokenJson] = useState("");
  const [clientJson, setClientJson] = useState("");
  const [problem, setProblem] = useState<LocalCacheError | null>(null);
  const [pending, setPending] = useState(false);
  useReportBusy(pending);
  const focusAfter = useFocusAfter(pending);
  const tokenRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<HTMLTextAreaElement>(null);
  const showClient = !isSocialProvider(provider);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const built = buildLocalCachePayload({ provider, tokenJson, clientJson });
    if (!built.ok) {
      setProblem(built.error);
      focusAfter(
        localCacheErrorField(built.error.key, showClient) === "client" ? clientRef : tokenRef,
      );
      return;
    }
    setProblem(null);
    const generation = sessions.generation;
    setPending(true);
    try {
      const res = await importCredentials({
        ...built.payload,
        reloginAccountId: relogin.accountId,
      });
      if (!sessions.isCurrent(generation)) return;
      relogin.announce(res);
      finishAdd([res.account]);
    } catch (error) {
      if (sessions.isCurrent(generation) && !(await relogin.resolveMismatch(error))) {
        toast.error(t(relogin.failedKey, { error: errorMessage(error, t) }));
        focusAfter(tokenRef);
      }
    } finally {
      setPending(false);
    }
  };

  // The message goes under the textarea it is about, so it shows next to the focused field.
  const problemField = problem ? localCacheErrorField(problem.key, showClient) : null;
  const problemText = problem
    ? problem.hint
      ? t("common:text.joinSentences", {
          first: t(`local.${problem.key}`, problem.params),
          second: t(`local.${problem.hint}`),
        })
      : t(`local.${problem.key}`, problem.params)
    : null;
  const items = LOCAL_PROVIDERS.map((value) => ({
    value,
    label: t(`local.providers.${value}`),
  }));

  return (
    <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
      <FlowGuide list title={t("local.fileLocation")}>
        <li>
          {fillNodes(t("common:text.labelValue"), {
            label: t("local.windows"),
            value: <Code>%USERPROFILE%\.aws\sso\cache\</Code>,
          })}
        </li>
        <li>
          {fillNodes(t("common:text.labelValue"), {
            label: t("local.macosLinux"),
            value: <Code>~/.aws/sso/cache/</Code>,
          })}
        </li>
      </FlowGuide>
      <FormField label={t("local.provider")}>
        <Select
          disabled={pending}
          items={items}
          onValueChange={(value) => {
            if (!value) return;
            setProvider(value as LocalProvider);
            setProblem(null);
          }}
          value={provider}
        >
          <SelectTrigger>
            <SelectValue>
              {(value: string) => (
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderLogo provider={value} />
                  <span className="truncate">
                    {items.find((item) => item.value === value)?.label}
                  </span>
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <ProviderLogo provider={item.value} />
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </FormField>
      <FormField
        error={problemField === "token" ? problemText : null}
        hint={t("local.pasteOrUpload")}
        label={
          <>
            {t("local.tokenFile")}
            <Badge size="sm" tone="neutral">
              {t("common:form.required")}
            </Badge>
          </>
        }
      >
        <JsonFileInput
          disabled={pending}
          file={t("local.tokenFile")}
          onChange={setTokenJson}
          placeholder='{"refreshToken": "…"}'
          textareaRef={tokenRef}
          value={tokenJson}
        />
      </FormField>
      {showClient ? (
        <FormField
          error={problemField === "client" ? problemText : null}
          hint={provider === "Microsoft" ? t("local.clientHintMicrosoft") : t("local.clientHint")}
          label={
            <>
              {t("local.clientFile")}
              <Badge size="sm" tone="neutral">
                {provider === "Microsoft" ? t("common:form.optional") : t("common:form.required")}
              </Badge>
            </>
          }
        >
          <JsonFileInput
            disabled={pending}
            file={t("local.clientFile")}
            onChange={setClientJson}
            placeholder='{"clientId": "…", "clientSecret": "…"}'
            textareaRef={clientRef}
            value={clientJson}
          />
        </FormField>
      ) : null}
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
