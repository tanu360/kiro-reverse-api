import type { JSX } from "react";
import {
  AnthropicLogo,
  ClaudeCodeLogo,
  ClineLogo,
  CodexLogo,
  KiloCodeLogo,
  OpencodeLogo,
  RooCodeLogo,
} from "@/components/shared/brand-logos";
import { MakerLogo } from "@/components/shared/model-logo";
import {
  REQUEST_CLIENTS,
  type RequestClient,
  type RequestEndpoint,
  type RequestRecord,
} from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isKnownEndpoint } from "./request-model";

type Mark = (props: { className?: string }) => JSX.Element;

/** Each coding tool's mark (the client the server named from the User-Agent). */
const CLIENT_MARKS: Record<RequestClient, Mark> = {
  "claude-code": ClaudeCodeLogo,
  codex: CodexLogo,
  opencode: OpencodeLogo,
  cline: ClineLogo,
  "roo-code": RooCodeLogo,
  "kilo-code": KiloCodeLogo,
};

/**
 * Each client API's mark, for a request from a tool the server did not name: Claude, OpenAI
 * (it follows the theme) and Codex for Responses.
 */
const ENDPOINT_MARKS: Record<RequestEndpoint, Mark> = {
  // The company behind each API, by its mark: Anthropic for the Messages API, OpenAI for both
  // of OpenAI's.
  claude: AnthropicLogo,
  openai: ({ className }) => <MakerLogo className={className} maker="openai" />,
  responses: ({ className }) => <MakerLogo className={className} maker="openai" />,
};

export function isKnownClient(client: string | undefined): client is RequestClient {
  return client !== undefined && (REQUEST_CLIENTS as readonly string[]).includes(client);
}

/**
 * Who called, as the table names it: the coding tool when the server knew it ("Claude Code"),
 * else the client API it called ("Claude API"); null when neither is known.
 */
export function requestCaller(
  record: Pick<RequestRecord, "client" | "endpoint">,
): { key: string; Mark: Mark } | null {
  if (isKnownClient(record.client)) {
    return { key: CLIENT_KEYS[record.client], Mark: CLIENT_MARKS[record.client] };
  }
  if (isKnownEndpoint(record.endpoint)) {
    return { key: ENDPOINT_KEYS[record.endpoint], Mark: ENDPOINT_MARKS[record.endpoint] };
  }
  return null;
}

// The keys written out, not built from the id, so the locale checks see each one in use.
const CLIENT_KEYS: Record<RequestClient, string> = {
  "claude-code": "client.claude-code",
  codex: "client.codex",
  opencode: "client.opencode",
  cline: "client.cline",
  "roo-code": "client.roo-code",
  "kilo-code": "client.kilo-code",
};

const ENDPOINT_KEYS: Record<RequestEndpoint, string> = {
  claude: "client.claude",
  openai: "client.openai",
  responses: "client.responses",
};

/** The caller's mark and name on one line; nothing when neither is known. */
export function CallerLabel({
  record,
  className,
}: {
  record: Pick<RequestRecord, "client" | "endpoint">;
  /** Layout and type classes (indent, text-meta). */
  className?: string;
}): JSX.Element | null {
  const { t } = useT("requests");
  const caller = requestCaller(record);
  if (!caller) return null;
  const { Mark } = caller;
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      data-slot="request-caller"
    >
      <Mark className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{t(caller.key)}</span>
    </span>
  );
}
