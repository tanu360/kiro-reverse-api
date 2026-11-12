import type { ResponseHeaderRule } from "@/lib/api/response-headers";
import type { TFunction, TParams } from "@/lib/i18n";
import { isEqual } from "./dirty";

// Mirrors config/response_headers.go: the same limits, checks, order and error codes, so the
// editor refuses what the server would.

export const MAX_RESPONSE_HEADERS = 20;
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_BYTES = 512;

/** The variables a value may use, in the order the editor offers them. */
export const RESPONSE_HEADER_VARIABLES = [
  "request_id",
  "model",
  "account_id",
  "key_id",
  "client_ip",
] as const;
export type ResponseHeaderVariable = (typeof RESPONSE_HEADER_VARIABLES)[number];

/** RFC 7230 token characters. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Hop-by-hop and framing headers, Date and Set-Cookie; Access-Control-* goes by prefix. */
const FORBIDDEN = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
  "content-length",
  "content-type",
  "content-encoding",
  "content-range",
  "date",
  "set-cookie",
]);
const FORBIDDEN_PREFIX = "access-control-";

// Every control character but tab (CR, LF, NUL, DEL...).
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export type ResponseHeaderErrorCode =
  | "response_headers_too_many"
  | "response_header_name_empty"
  | "response_header_name_invalid"
  | "response_header_name_too_long"
  | "response_header_name_forbidden"
  | "response_header_name_duplicate"
  | "response_header_value_empty"
  | "response_header_value_invalid"
  | "response_header_value_too_long"
  | "response_header_unknown_variable";

export interface ResponseHeaderProblem {
  code: ResponseHeaderErrorCode;
  /** The text's placeholders: name, max, variable. */
  params?: TParams;
}

/** Only spaces and tabs are trimmed, as on the server: a line break anywhere is refused. */
export function trimHeaderText(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function headerNameProblem(raw: string): ResponseHeaderProblem | null {
  const name = trimHeaderText(raw);
  if (name === "") return { code: "response_header_name_empty" };
  // Bytes, as Go counts them; a token is ASCII, so this is its length in characters too.
  if (utf8Length(name) > MAX_HEADER_NAME_LENGTH) {
    return { code: "response_header_name_too_long", params: { max: MAX_HEADER_NAME_LENGTH } };
  }
  if (!TOKEN.test(name)) return { code: "response_header_name_invalid", params: { name } };
  const lower = name.toLowerCase();
  if (FORBIDDEN.has(lower) || lower.startsWith(FORBIDDEN_PREFIX)) {
    return { code: "response_header_name_forbidden", params: { name } };
  }
  return null;
}

/** The first {lower_snake} placeholder that is not a variable; other braces are literal text. */
export function unknownVariable(value: string): string | null {
  let rest = value;
  for (;;) {
    const open = rest.indexOf("{");
    if (open < 0) return null;
    rest = rest.slice(open + 1);
    const end = rest.indexOf("}");
    if (end < 0) return null;
    const name = rest.slice(0, end);
    if (
      /^[a-z][a-z0-9_]*$/.test(name) &&
      !(RESPONSE_HEADER_VARIABLES as readonly string[]).includes(name)
    ) {
      return name;
    }
  }
}

export function headerValueProblem(raw: string, name = ""): ResponseHeaderProblem | null {
  const value = trimHeaderText(raw);
  if (value === "") return { code: "response_header_value_empty", params: { name } };
  if (utf8Length(value) > MAX_HEADER_VALUE_BYTES) {
    return {
      code: "response_header_value_too_long",
      params: { name, max: MAX_HEADER_VALUE_BYTES },
    };
  }
  if (CONTROL.test(value)) return { code: "response_header_value_invalid", params: { name } };
  const unknown = unknownVariable(value);
  if (unknown !== null) {
    return { code: "response_header_unknown_variable", params: { variable: unknown } };
  }
  return null;
}

/**
 * The first problem of one header among `others` (the rest of the list), in the server's order:
 * name, duplicate name, value.
 */
export function headerProblem(
  rule: Pick<ResponseHeaderRule, "name" | "value">,
  others: readonly Pick<ResponseHeaderRule, "name">[],
): ResponseHeaderProblem | null {
  const nameProblem = headerNameProblem(rule.name);
  if (nameProblem) return nameProblem;
  const name = trimHeaderText(rule.name);
  if (others.some((other) => trimHeaderText(other.name).toLowerCase() === name.toLowerCase())) {
    return { code: "response_header_name_duplicate", params: { name } };
  }
  return headerValueProblem(rule.value, name);
}

/** The first problem of the whole list and its index (-1 for the list), as the server finds it. */
export function listProblem(
  rules: readonly ResponseHeaderRule[],
): (ResponseHeaderProblem & { index: number }) | null {
  if (rules.length > MAX_RESPONSE_HEADERS) {
    return { index: -1, code: "response_headers_too_many", params: { max: MAX_RESPONSE_HEADERS } };
  }
  for (let index = 0; index < rules.length; index += 1) {
    const problem = headerProblem(rules[index], rules.slice(0, index));
    if (problem) return { index, ...problem };
  }
  return null;
}

/** The list as the server stores it: names and values trimmed of spaces and tabs. */
export function normalizeHeaders(rules: readonly ResponseHeaderRule[]): ResponseHeaderRule[] {
  return rules.map((rule) => ({
    name: trimHeaderText(rule.name),
    value: trimHeaderText(rule.value),
    enabled: rule.enabled,
  }));
}

export function sameResponseHeaders(
  a: readonly ResponseHeaderRule[],
  b: readonly ResponseHeaderRule[],
): boolean {
  return isEqual(a, b);
}

/** The settings key for each code, namespaced so t() can take it as it is. */
const PROBLEM_KEYS: Record<ResponseHeaderErrorCode, string> = {
  response_headers_too_many: "settings:responseHeaders.limit",
  response_header_name_empty: "settings:responseHeaders.error.nameEmpty",
  response_header_name_invalid: "settings:responseHeaders.error.nameInvalid",
  response_header_name_too_long: "settings:responseHeaders.error.nameTooLong",
  response_header_name_forbidden: "settings:responseHeaders.error.nameForbidden",
  response_header_name_duplicate: "settings:responseHeaders.error.nameDuplicate",
  response_header_value_empty: "settings:responseHeaders.error.valueEmpty",
  response_header_value_invalid: "settings:responseHeaders.error.valueInvalid",
  response_header_value_too_long: "settings:responseHeaders.error.valueTooLong",
  response_header_unknown_variable: "settings:responseHeaders.error.unknownVariable",
};

export function isResponseHeaderErrorCode(code: unknown): code is ResponseHeaderErrorCode {
  return typeof code === "string" && Object.hasOwn(PROBLEM_KEYS, code);
}

/**
 * The translated text for a problem, from this card or from a server 400 body (whose `name`,
 * `max` and `variable` fields fill the same placeholders). The variable shows in braces.
 */
export function problemMessage(problem: ResponseHeaderProblem, t: TFunction): string {
  const params: TParams = { ...problem.params };
  if (typeof params.variable === "string") params.variable = `{${params.variable}}`;
  return t(PROBLEM_KEYS[problem.code], params);
}

/**
 * `{name}` put in place of the selection [start, end) of `value`, and where the caret goes
 * after it. A selection past the end clamps to the end.
 */
export function insertVariable(
  value: string,
  start: number | null,
  end: number | null,
  name: ResponseHeaderVariable,
): { value: string; caret: number } {
  const from = Math.min(start ?? value.length, value.length);
  const to = Math.max(from, Math.min(end ?? from, value.length));
  const token = `{${name}}`;
  return { value: value.slice(0, from) + token + value.slice(to), caret: from + token.length };
}
