// Client setup snippets. They only ever name the KIRO_API_KEY env var: never a real key.
// Checked against the current docs:
// - Claude Code: ANTHROPIC_BASE_URL overrides the API endpoint; ANTHROPIC_AUTH_TOKEN is sent as
//   "Authorization: Bearer <value>"; ANTHROPIC_MODEL is the main model, and
//   ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL are what the opus, sonnet and haiku aliases (and
//   the background tasks, on haiku) send (https://code.claude.com/docs/en/env-vars).
// - Codex: [model_providers.<id>] with name, base_url, env_key and wire_api = "responses", picked
//   by model_provider in ~/.codex/config.toml (https://developers.openai.com/codex/config-advanced).
//   model_catalog_json is a path ("~" expands) to a model list in the /v1/codex/models format;
//   Codex never fetches that list itself, and without it has no apply_patch tool.
// - SDKs: the Anthropic clients take the bare origin (they add /v1/messages themselves); the
//   OpenAI clients take the origin with /v1.

import type { CodeLanguage } from "@/lib/highlight";

// "auto" lets Kiro pick the model per task. Every account serves it, free tier included, and
// /v1/models always lists it, so the snippets run as pasted whatever the accounts hold.
export const SNIPPET_MODEL = "auto";
export const SNIPPET_KEY_ENV = "KIRO_API_KEY";

/** The APIs the request builder covers: Anthropic Messages, OpenAI Chat Completions and Responses. */
export const SNIPPET_APIS = ["messages", "chat", "responses"] as const;
export type SnippetApi = (typeof SNIPPET_APIS)[number];

export const SNIPPET_LANGUAGES = [
  "curl",
  "python",
  "node",
  "go",
  "java",
  "php",
  "ruby",
  "csharp",
] as const;
export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

/** The official SDK, or the language's plain HTTP client. */
export type SnippetClient = "sdk" | "http";

export interface RequestSnippetOptions {
  api: SnippetApi;
  language: SnippetLanguage;
  /** Ignored for a language without an SDK snippet: those always use HTTP. */
  client: SnippetClient;
}

export const SNIPPET_API_PATHS: Record<SnippetApi, string> = {
  messages: "/v1/messages",
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
};

interface LanguageInfo {
  /** The code block's title; curl has none (the caller shows "Shell"). */
  file?: string;
  highlight: CodeLanguage;
  /** Whether the official Anthropic and OpenAI SDKs have a snippet in this language. */
  sdk: boolean;
}

export const SNIPPET_LANGUAGE_INFO: Record<SnippetLanguage, LanguageInfo> = {
  curl: { highlight: "bash", sdk: false },
  python: { file: "main.py", highlight: "python", sdk: true },
  node: { file: "main.mjs", highlight: "javascript", sdk: true },
  go: { file: "main.go", highlight: "go", sdk: false },
  java: { file: "Main.java", highlight: "java", sdk: false },
  php: { file: "main.php", highlight: "php", sdk: false },
  ruby: { file: "main.rb", highlight: "ruby", sdk: false },
  csharp: { file: "Program.cs", highlight: "csharp", sdk: false },
};

/** Whose official SDK a snippet uses: Anthropic's for Messages, OpenAI's for the other two. */
export function sdkProvider(api: SnippetApi): "Anthropic" | "OpenAI" {
  return api === "messages" ? "Anthropic" : "OpenAI";
}

/** Code lines, nested as the snippet builds them (a group() result, an optional block). */
type Line = string | Line[];

function lines(...parts: Line[]): string {
  const out: string[] = [];
  const add = (part: Line) => {
    if (typeof part === "string") out.push(part);
    else for (const inner of part) add(inner);
  };
  for (const part of parts) add(part);
  return out.join("\n");
}

type Json = string | number | boolean | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/*
 * Snippets are written compact: a value goes on one line while that line stays within MAX_LINE
 * columns (about what the code block shows beside the Endpoints card), and only longer ones break
 * into one entry per line. The card stays close to the Endpoints card's height that way.
 */
const MAX_LINE = 72;

/** How one language writes a bracketed list of entries. */
interface Brackets {
  open: string;
  close: string;
  /** Inner indent of a broken list. */
  pad: string;
  /** "{ a: 1 }" rather than "{a: 1}". */
  spaced: boolean;
  /** A comma after the last entry of a broken list. */
  trailingComma: boolean;
}

const JSON_OBJECT: Brackets = {
  open: "{",
  close: "}",
  pad: "  ",
  spaced: false,
  trailingComma: false,
};
const PY_DICT: Brackets = {
  open: "{",
  close: "}",
  pad: "    ",
  spaced: false,
  trailingComma: true,
};
const PY_ARGS: Brackets = {
  open: "(",
  close: ")",
  pad: "    ",
  spaced: false,
  trailingComma: true,
};
const JS_OBJECT: Brackets = { open: "{", close: "}", pad: "  ", spaced: true, trailingComma: true };
const PHP_ARRAY: Brackets = {
  open: "[",
  close: "]",
  pad: "    ",
  spaced: false,
  trailingComma: true,
};
const RUBY_HASH: Brackets = { open: "{", close: "}", pad: "  ", spaced: true, trailingComma: true };

/** `head`, the bracketed entries and `tail`: on one line when it fits, else one entry per line. */
function group(
  indent: string,
  head: string,
  entries: string[],
  brackets: Brackets,
  tail = "",
): string[] {
  const { open, close, pad, spaced, trailingComma } = brackets;
  const inner = entries.join(", ");
  const oneLine = `${indent}${head}${open}${spaced && inner ? ` ${inner} ` : inner}${close}${tail}`;
  if (oneLine.length <= MAX_LINE || entries.length === 0) return [oneLine];
  return [
    `${indent}${head}${open}`,
    ...entries.map(
      (entry, index) =>
        `${indent}${pad}${entry}${trailingComma || index < entries.length - 1 ? "," : ""}`,
    ),
    `${indent}${close}${tail}`,
  ];
}

/** Literal syntaxes a request body is written in. */
type Syntax = "json" | "python" | "js" | "php" | "ruby";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function fieldKey(key: string, syntax: Syntax): string {
  switch (syntax) {
    case "php":
      return `"${key}" => `;
    case "js":
      return `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: `;
    case "ruby":
      return `${key}: `;
    default:
      return `${JSON.stringify(key)}: `;
  }
}

/** A value on one line, in the syntax's literal form. */
function inline(value: Json, syntax: Syntax): string {
  if (Array.isArray(value)) return `[${value.map((item) => inline(item, syntax)).join(", ")}]`;
  if (typeof value === "object") {
    const fields = Object.entries(value)
      .map(([key, item]) => fieldKey(key, syntax) + inline(item, syntax))
      .join(", ");
    if (syntax === "php") return `[${fields}]`;
    return syntax === "js" || syntax === "ruby" ? `{ ${fields} }` : `{${fields}}`;
  }
  if (typeof value === "boolean" && syntax === "python") return value ? "True" : "False";
  return JSON.stringify(value);
}

/** An object's fields as entries for group(): `"key": value` in the syntax. */
function fields(value: JsonObject, syntax: Syntax): string[] {
  return Object.entries(value).map(([key, item]) => fieldKey(key, syntax) + inline(item, syntax));
}

/** Python keyword arguments. */
function kwargs(value: JsonObject): string[] {
  return Object.entries(value).map(([key, item]) => `${key}=${inline(item, "python")}`);
}

const MESSAGES: Json = [{ role: "user", content: "Hello" }];

function requestBody(api: SnippetApi, model: string): JsonObject {
  switch (api) {
    case "messages":
      return { model, max_tokens: 1024, messages: MESSAGES };
    case "chat":
      return { model, messages: MESSAGES };
    case "responses":
      return { model, input: "Hello" };
  }
}

/** A request header; a `secret` one carries the key from the env var after `value` as a prefix. */
interface Header {
  name: string;
  value: string;
  secret?: boolean;
}

function requestHeaders(api: SnippetApi): Header[] {
  const auth: Header[] =
    api === "messages"
      ? [
          { name: "x-api-key", value: "", secret: true },
          { name: "anthropic-version", value: "2023-06-01" },
        ]
      : [{ name: "Authorization", value: "Bearer ", secret: true }];
  return [...auth, { name: "content-type", value: "application/json" }];
}

/** A header value as an expression in the language, reading the key from the env var. */
function headerValue(header: Header, language: "python" | "node" | "go" | "java" | "ruby"): string {
  if (!header.secret) return JSON.stringify(header.value);
  const env = SNIPPET_KEY_ENV;
  const prefix = header.value;
  switch (language) {
    case "python":
      return prefix ? `f"${prefix}{os.environ['${env}']}"` : `os.environ["${env}"]`;
    case "node":
      return prefix ? `\`${prefix}\${process.env.${env}}\`` : `process.env.${env}`;
    case "go":
      return prefix ? `"${prefix}"+os.Getenv("${env}")` : `os.Getenv("${env}")`;
    case "java":
      return prefix ? `"${prefix}" + System.getenv("${env}")` : `System.getenv("${env}")`;
    case "ruby":
      return prefix ? `"${prefix}#{ENV.fetch("${env}")}"` : `ENV.fetch("${env}")`;
  }
}

interface Request {
  url: string;
  headers: Header[];
  body: JsonObject;
}

function curlSnippet({ url, headers, body }: Request): string {
  const header = ({ name, value, secret }: Header) =>
    `  -H "${name}: ${value}${secret ? `$${SNIPPET_KEY_ENV}` : ""}" \\`;
  // The body's "{" stays on the -d line; a body too long for one line breaks below it.
  return lines(
    `curl "${url}" \\`,
    headers.map(header),
    group("  ", "-d '", fields(body, "json"), JSON_OBJECT, "'"),
  );
}

function pythonHttpSnippet({ url, headers, body }: Request): string {
  // requests sets content-type itself for json=.
  const headerEntries = headers
    .filter((header) => header.name !== "content-type")
    .map((header) => `"${header.name}": ${headerValue(header, "python")}`);
  return lines(
    "import os",
    "import requests  # pip install requests",
    "",
    "response = requests.post(",
    `    "${url}",`,
    group("    ", "headers=", headerEntries, PY_DICT, ","),
    group("    ", "json=", fields(body, "python"), PY_DICT, ","),
    ")",
    "print(response.json())",
  );
}

function nodeHttpSnippet({ url, headers, body }: Request): string {
  const headerEntries = headers.map(
    (header) => `${fieldKey(header.name, "js")}${headerValue(header, "node")}`,
  );
  return lines(
    `const response = await fetch("${url}", {`,
    '  method: "POST",',
    group("  ", "headers: ", headerEntries, JS_OBJECT, ","),
    group("  ", "body: JSON.stringify(", fields(body, "js"), JS_OBJECT, "),"),
    "});",
    // text(), not json(): console.log would fold the nested reply into [Object].
    "console.log(await response.text());",
  );
}

function goSnippet({ url, headers, body }: Request): string {
  return lines(
    "package main",
    "",
    "import (",
    '\t"io"',
    '\t"net/http"',
    '\t"os"',
    '\t"strings"',
    ")",
    "",
    "func main() {",
    `\turl := "${url}"`,
    // The JSON sits in a raw string; a long one breaks with the code's tabs (JSON ignores them).
    group("\t", "body := `", fields(body, "json"), { ...JSON_OBJECT, pad: "\t" }, "`"),
    '\treq, _ := http.NewRequest("POST", url, strings.NewReader(body))',
    headers.map((header) => `\treq.Header.Set("${header.name}", ${headerValue(header, "go")})`),
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tio.Copy(os.Stdout, res.Body)",
    "}",
  );
}

function javaSnippet({ url, headers, body }: Request): string {
  return lines(
    "import java.net.URI;",
    "import java.net.http.*;",
    "",
    "public class Main {",
    "    public static void main(String[] args) throws Exception {",
    `        var url = URI.create("${url}");`,
    '        var body = """',
    group("            ", "", fields(body, "json"), JSON_OBJECT, '""";'),
    "        var request = HttpRequest.newBuilder(url)",
    headers.map(
      (header) => `            .header("${header.name}", ${headerValue(header, "java")})`,
    ),
    "            .POST(HttpRequest.BodyPublishers.ofString(body))",
    "            .build();",
    "        var client = HttpClient.newHttpClient();",
    "        var response = client.send(request, HttpResponse.BodyHandlers.ofString());",
    "        System.out.println(response.body());",
    "    }",
    "}",
  );
}

function phpSnippet({ url, headers, body }: Request): string {
  const headerEntries = headers.map((h) =>
    h.secret ? `"${h.name}: ${h.value}" . getenv("${SNIPPET_KEY_ENV}")` : `"${h.name}: ${h.value}"`,
  );
  return lines(
    "<?php",
    `$ch = curl_init("${url}");`,
    "curl_setopt_array($ch, [",
    group("    ", "CURLOPT_HTTPHEADER => ", headerEntries, PHP_ARRAY, ","),
    group("    ", "CURLOPT_POSTFIELDS => json_encode(", fields(body, "php"), PHP_ARRAY, "),"),
    "]);",
    // Without CURLOPT_RETURNTRANSFER, curl_exec prints the response body itself.
    "curl_exec($ch);",
  );
}

function rubySnippet({ url, headers, body }: Request): string {
  const headerEntries = headers.map(
    (header) => `"${header.name}" => ${headerValue(header, "ruby")}`,
  );
  return lines(
    'require "json"',
    'require "net/http"',
    "",
    `uri = URI("${url}")`,
    group("", "headers = ", headerEntries, RUBY_HASH),
    group("", "body = ", fields(body, "ruby"), RUBY_HASH),
    "puts Net::HTTP.post(uri, body.to_json, headers).body",
  );
}

function csharpSnippet({ url, headers, body }: Request): string {
  const headerLines = headers
    // StringContent carries content-type.
    .filter((header) => header.name !== "content-type")
    .map((header) => {
      const value = !header.secret
        ? JSON.stringify(header.value)
        : header.value
          ? `$"${header.value}{key}"`
          : "key";
      return `client.DefaultRequestHeaders.Add("${header.name}", ${value});`;
    });
  const content = `var body = new StringContent("""${inline(body, "json")}""", Encoding.UTF8, "application/json");`;
  return lines(
    "using System.Text;",
    "",
    `var url = "${url}";`,
    `var key = Environment.GetEnvironmentVariable("${SNIPPET_KEY_ENV}");`,
    "using var client = new HttpClient();",
    headerLines,
    // A raw string on one line when it fits; a longer one needs its own lines.
    content.length <= MAX_LINE
      ? [content]
      : [
          'var body = new StringContent("""',
          group("    ", "", fields(body, "json"), JSON_OBJECT),
          '    """, Encoding.UTF8, "application/json");',
        ],
    "var response = await client.PostAsync(url, body);",
    "Console.WriteLine(await response.Content.ReadAsStringAsync());",
  );
}

function pythonSdkSnippet(origin: string, api: SnippetApi, model: string): string {
  const anthropic = api === "messages";
  const sdk = sdkProvider(api);
  const head = [
    "import os",
    `from ${sdk.toLowerCase()} import ${sdk}  # pip install ${sdk.toLowerCase()}`,
    "",
    group(
      "",
      `client = ${sdk}`,
      [
        `base_url="${anthropic ? origin : `${origin}/v1`}"`,
        `api_key=os.environ["${SNIPPET_KEY_ENV}"]`,
      ],
      PY_ARGS,
    ),
  ];
  switch (api) {
    case "messages":
      return lines(
        head,
        group(
          "",
          "message = client.messages.create",
          kwargs({ model, max_tokens: 1024, messages: MESSAGES }),
          PY_ARGS,
        ),
        "print(message.content[0].text)",
      );
    case "chat":
      return lines(
        head,
        group(
          "",
          "response = client.chat.completions.create",
          kwargs({ model, messages: MESSAGES }),
          PY_ARGS,
        ),
        "print(response.choices[0].message.content)",
      );
    case "responses":
      return lines(
        head,
        group("", "response = client.responses.create", kwargs({ model, input: "Hello" }), PY_ARGS),
        "print(response.output_text)",
      );
  }
}

function nodeSdkSnippet(origin: string, api: SnippetApi, model: string): string {
  const anthropic = api === "messages";
  const sdk = sdkProvider(api);
  const pkg = anthropic ? "@anthropic-ai/sdk" : "openai";
  const head = [
    `import ${sdk} from "${pkg}"; // npm install ${pkg}`,
    "",
    group(
      "",
      `const client = new ${sdk}(`,
      [
        `baseURL: "${anthropic ? origin : `${origin}/v1`}"`,
        `apiKey: process.env.${SNIPPET_KEY_ENV}`,
      ],
      JS_OBJECT,
      ");",
    ),
  ];
  switch (api) {
    case "messages":
      return lines(
        head,
        group(
          "",
          "const message = await client.messages.create(",
          fields({ model, max_tokens: 1024, messages: MESSAGES }, "js"),
          JS_OBJECT,
          ");",
        ),
        "console.log(message.content[0].text);",
      );
    case "chat":
      return lines(
        head,
        group(
          "",
          "const response = await client.chat.completions.create(",
          fields({ model, messages: MESSAGES }, "js"),
          JS_OBJECT,
          ");",
        ),
        "console.log(response.choices[0].message.content);",
      );
    case "responses":
      return lines(
        head,
        group(
          "",
          "const response = await client.responses.create(",
          fields({ model, input: "Hello" }, "js"),
          JS_OBJECT,
          ");",
        ),
        "console.log(response.output_text);",
      );
  }
}

/** Whether the snippet for these options uses the SDK (only where the language has one). */
export function usesSdk(options: Pick<RequestSnippetOptions, "client" | "language">): boolean {
  return options.client === "sdk" && SNIPPET_LANGUAGE_INFO[options.language].sdk;
}

/** A complete program (or curl command) that sends one request to the proxy at `origin`. */
export function buildRequestSnippet(
  origin: string,
  options: RequestSnippetOptions,
  model: string = SNIPPET_MODEL,
): string {
  const { api, language } = options;
  if (usesSdk(options)) {
    return language === "python"
      ? pythonSdkSnippet(origin, api, model)
      : nodeSdkSnippet(origin, api, model);
  }
  const request: Request = {
    url: origin + SNIPPET_API_PATHS[api],
    headers: requestHeaders(api),
    body: requestBody(api, model),
  };
  switch (language) {
    case "curl":
      return curlSnippet(request);
    case "python":
      return pythonHttpSnippet(request);
    case "node":
      return nodeHttpSnippet(request);
    case "go":
      return goSnippet(request);
    case "java":
      return javaSnippet(request);
    case "php":
      return phpSnippet(request);
    case "ruby":
      return rubySnippet(request);
    case "csharp":
      return csharpSnippet(request);
  }
}

/**
 * The models Claude Code is set to. Its own defaults (claude-*-5-5 in Claude Code 2.1) are not
 * served on free accounts, which answer them with a 404; these two are served on every account,
 * free tier included. They are environment variables, not a mapping rule on the server, so they
 * change only the client that copies them: a client that names its model keeps it, and Opus stays
 * Opus for every other client of an account that serves it.
 */
export const CLAUDE_CODE_MODELS = {
  main: "claude-sonnet-4.5",
  opus: "claude-sonnet-4.5",
  sonnet: "claude-sonnet-4.5",
  haiku: "claude-haiku-4.5",
} as const;

/** Where the Codex setup saves the /v1/codex/models list ("~" expands in Codex's config). */
export const CODEX_CATALOG_FILE = "~/.codex/kiro-models.json";

/** The Claude Code and Codex setups for a proxy reachable at `origin` (e.g. location.origin). */
export function buildToolSnippets(
  origin: string,
  model: string = SNIPPET_MODEL,
): { claudeCode: string; codexModels: string; codex: string } {
  const env = SNIPPET_KEY_ENV;
  return {
    claudeCode: lines(
      `export ANTHROPIC_BASE_URL="${origin}"`,
      `export ANTHROPIC_AUTH_TOKEN="$${env}"`,
      `export ANTHROPIC_MODEL="${CLAUDE_CODE_MODELS.main}"`,
      `export ANTHROPIC_DEFAULT_OPUS_MODEL="${CLAUDE_CODE_MODELS.opus}"`,
      `export ANTHROPIC_DEFAULT_SONNET_MODEL="${CLAUDE_CODE_MODELS.sonnet}"`,
      `export ANTHROPIC_DEFAULT_HAIKU_MODEL="${CLAUDE_CODE_MODELS.haiku}"`,
      "claude",
    ),
    // -f: an error (a wrong key) writes no file; --create-dirs: a first Codex run has no ~/.codex.
    codexModels: lines(
      `curl -fsS --create-dirs -o ${CODEX_CATALOG_FILE} \\`,
      `  -H "Authorization: Bearer $${env}" \\`,
      `  "${origin}/v1/codex/models"`,
    ),
    codex: lines(
      `model = "${model}"`,
      'model_provider = "kiro"',
      `model_catalog_json = "${CODEX_CATALOG_FILE}"`,
      "",
      "[model_providers.kiro]",
      'name = "Kiro Proxy"',
      `base_url = "${origin}/v1"`,
      `env_key = "${env}"`,
      'wire_api = "responses"',
    ),
  };
}
