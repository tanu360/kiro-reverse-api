import { describe, expect, it } from "vitest";
import { seedApiKeys } from "@/lib/mocks/fixtures";
import {
  buildRequestSnippet,
  buildToolSnippets,
  type RequestSnippetOptions,
  SNIPPET_API_PATHS,
  SNIPPET_APIS,
  SNIPPET_KEY_ENV,
  SNIPPET_LANGUAGE_INFO,
  SNIPPET_LANGUAGES,
  SNIPPET_MODEL,
  type SnippetApi,
  type SnippetLanguage,
  usesSdk,
} from "./snippets";

const ORIGIN = "https://proxy.example.com:8443";

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** Every combination the builder offers: API x language x client. */
const COMBINATIONS: RequestSnippetOptions[] = SNIPPET_APIS.flatMap((api) =>
  SNIPPET_LANGUAGES.flatMap((language) =>
    (SNIPPET_LANGUAGE_INFO[language].sdk ? (["sdk", "http"] as const) : (["http"] as const)).map(
      (client) => ({ api, language, client }),
    ),
  ),
);

const snippet = (
  api: SnippetApi,
  language: SnippetLanguage,
  options: Partial<RequestSnippetOptions> = {},
) => buildRequestSnippet(ORIGIN, { api, language, client: "http", ...options });

/** The JSON a snippet sends as a string literal: curl's -d '…', Go's `…`, Java's and C#'s """…""". */
function embeddedJson(code: string): unknown {
  const body =
    /-d '([\s\S]*?)'$/.exec(code)?.[1] ??
    /body := `([\s\S]*?)`/.exec(code)?.[1] ??
    /var body = """\n([\s\S]*?)""";/.exec(code)?.[1] ??
    /StringContent\("""\n?([\s\S]*?)\n?\s*"""/.exec(code)?.[1];
  if (body === undefined) throw new Error("no JSON body in the snippet");
  return JSON.parse(body);
}

describe("buildRequestSnippet", () => {
  it("uses the placeholder env var and the default model", () => {
    expect(SNIPPET_KEY_ENV).toBe("KIRO_API_KEY");
    expect(SNIPPET_MODEL).toBe("auto");
  });

  it("covers 30 combinations, each naming the origin once and reading the key from the env", () => {
    expect(COMBINATIONS).toHaveLength(30);
    for (const options of COMBINATIONS) {
      const code = buildRequestSnippet(ORIGIN, options);
      expect(count(code, ORIGIN), JSON.stringify(options)).toBe(1);
      expect(code, JSON.stringify(options)).toContain(SNIPPET_KEY_ENV);
      expect(code, JSON.stringify(options)).toContain('"auto"');
    }
  });

  it("calls each API's path with plain HTTP", () => {
    for (const api of SNIPPET_APIS) {
      for (const language of SNIPPET_LANGUAGES) {
        expect(snippet(api, language)).toContain(`${ORIGIN}${SNIPPET_API_PATHS[api]}`);
      }
    }
  });

  it("curl sends the Anthropic headers to Messages and a bearer key to the OpenAI APIs", () => {
    const messages = snippet("messages", "curl");
    expect(messages).toContain(`curl "${ORIGIN}/v1/messages" \\`);
    expect(messages).toContain('-H "x-api-key: $KIRO_API_KEY"');
    expect(messages).toContain('-H "anthropic-version: 2023-06-01"');
    expect(messages).toContain('-H "content-type: application/json"');
    for (const api of ["chat", "responses"] as const) {
      expect(snippet(api, "curl")).toContain('-H "Authorization: Bearer $KIRO_API_KEY"');
      expect(snippet(api, "curl")).not.toContain("x-api-key");
    }
  });

  it("sends a valid JSON body from curl, Go, Java and C#", () => {
    for (const api of SNIPPET_APIS) {
      for (const language of ["curl", "go", "java", "csharp"] as const) {
        const body = embeddedJson(snippet(api, language)) as Record<string, unknown>;
        expect(body.model).toBe("auto");
        expect(body.stream).toBeUndefined();
        if (api === "responses") expect(body.input).toBe("Hello");
        else expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
        if (api === "messages") expect(body.max_tokens).toBe(1024);
      }
    }
  });

  it("offers the SDKs only in Python and Node.js", () => {
    expect(SNIPPET_LANGUAGES.filter((language) => SNIPPET_LANGUAGE_INFO[language].sdk)).toEqual([
      "python",
      "node",
    ]);
    expect(usesSdk({ client: "sdk", language: "go" })).toBe(false);
    expect(snippet("chat", "go", { client: "sdk" })).toBe(snippet("chat", "go"));
  });

  it("points the Anthropic SDKs at the bare origin and the OpenAI SDKs at /v1", () => {
    const sdk = { client: "sdk" } as const;
    expect(snippet("messages", "python", sdk)).toContain(`base_url="${ORIGIN}",`);
    expect(snippet("messages", "python", sdk)).toContain("from anthropic import Anthropic");
    expect(snippet("messages", "node", sdk)).toContain(`baseURL: "${ORIGIN}",`);
    expect(snippet("messages", "node", sdk)).toContain('from "@anthropic-ai/sdk"');
    for (const api of ["chat", "responses"] as const) {
      expect(snippet(api, "python", sdk)).toContain(`base_url="${ORIGIN}/v1",`);
      expect(snippet(api, "python", sdk)).toContain('api_key=os.environ["KIRO_API_KEY"]');
      expect(snippet(api, "node", sdk)).toContain(`baseURL: "${ORIGIN}/v1",`);
      expect(snippet(api, "node", sdk)).toContain("apiKey: process.env.KIRO_API_KEY");
    }
    expect(snippet("responses", "python", sdk)).toContain("client.responses.create(");
    expect(snippet("chat", "node", sdk)).toContain("client.chat.completions.create({");
  });

  it("never contains a real key value", () => {
    const secrets = seedApiKeys().flatMap((k) => [k.key, k.keyMasked]);
    const tools = buildToolSnippets(ORIGIN);
    for (const code of [
      ...COMBINATIONS.map((options) => buildRequestSnippet(ORIGIN, options)),
      tools.claudeCode,
      tools.codex,
    ]) {
      for (const secret of secrets) expect(code).not.toContain(secret);
      expect(code).not.toMatch(/sk-[0-9a-f]{8,}/);
    }
  });
});

describe("compact snippets", () => {
  it("keep the request bodies on one line when they fit and break the long ones", () => {
    expect(snippet("responses", "curl")).toContain(`-d '{"model": "auto", "input": "Hello"}'`);
    expect(snippet("messages", "curl")).toContain(`  -d '{\n    "model": "auto",`);
    expect(snippet("responses", "go")).toContain('\tbody := `{"model": "auto", "input": "Hello"}`');
  });

  it("stay within 26 lines in every combination", () => {
    for (const options of COMBINATIONS) {
      const code = buildRequestSnippet(ORIGIN, options);
      expect(code.split("\n").length, JSON.stringify(options)).toBeLessThanOrEqual(26);
    }
  });
});

describe("buildToolSnippets", () => {
  const tools = buildToolSnippets(ORIGIN);

  it("Claude Code points ANTHROPIC_BASE_URL at the origin without /v1", () => {
    expect(tools.claudeCode).toBe(
      [
        `export ANTHROPIC_BASE_URL="${ORIGIN}"`,
        'export ANTHROPIC_AUTH_TOKEN="$KIRO_API_KEY"',
        "claude",
      ].join("\n"),
    );
  });

  it("Codex defines a responses provider on /v1 that reads KIRO_API_KEY", () => {
    expect(tools.codex).toBe(
      [
        'model = "auto"',
        'model_provider = "kiro"',
        "",
        "[model_providers.kiro]",
        'name = "Kiro Proxy"',
        `base_url = "${ORIGIN}/v1"`,
        'env_key = "KIRO_API_KEY"',
        'wire_api = "responses"',
      ].join("\n"),
    );
  });
});
