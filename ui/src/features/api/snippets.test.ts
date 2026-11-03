import { describe, expect, it } from "vitest";
import { seedApiKeys } from "@/lib/mocks/fixtures";
import { buildClientSnippets, SNIPPET_KEY_ENV, SNIPPET_MODEL } from "./snippets";

const ORIGIN = "https://proxy.example.com:8443";

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe("buildClientSnippets", () => {
  const snippets = buildClientSnippets(ORIGIN);
  const all = [
    snippets.curl.anthropic,
    snippets.curl.openai,
    snippets.claudeCode,
    snippets.codex,
    snippets.openaiSdk.python,
    snippets.openaiSdk.typescript,
  ];

  it("uses the placeholder env var and the default model", () => {
    expect(SNIPPET_KEY_ENV).toBe("KIRO_API_KEY");
    expect(SNIPPET_MODEL).toBe("claude-sonnet-5");
  });

  it("puts the origin in every snippet exactly once", () => {
    for (const snippet of all) expect(count(snippet, ORIGIN)).toBe(1);
  });

  it("curl calls the Anthropic and OpenAI endpoints with the key from the env", () => {
    expect(snippets.curl.anthropic).toContain(`"${ORIGIN}/v1/messages"`);
    expect(snippets.curl.anthropic).toContain('-H "x-api-key: $KIRO_API_KEY"');
    expect(snippets.curl.anthropic).toContain('-H "anthropic-version: 2023-06-01"');
    expect(snippets.curl.anthropic).toContain('-H "content-type: application/json"');
    expect(snippets.curl.anthropic).toContain('"max_tokens": 1024');
    expect(snippets.curl.anthropic).toContain('"model": "claude-sonnet-5"');
    expect(snippets.curl.openai).toContain(`"${ORIGIN}/v1/chat/completions"`);
    expect(snippets.curl.openai).toContain('-H "Authorization: Bearer $KIRO_API_KEY"');
  });

  it("curl request bodies are valid JSON", () => {
    for (const snippet of [snippets.curl.anthropic, snippets.curl.openai]) {
      const body = /-d '([\s\S]*)'$/.exec(snippet)?.[1];
      expect(body).toBeDefined();
      const parsed = JSON.parse(body ?? "") as { messages: unknown[] };
      expect(parsed.messages).toEqual([{ role: "user", content: "Hello" }]);
    }
  });

  it("Claude Code points ANTHROPIC_BASE_URL at the origin without /v1", () => {
    expect(snippets.claudeCode).toBe(
      [
        `export ANTHROPIC_BASE_URL="${ORIGIN}"`,
        'export ANTHROPIC_AUTH_TOKEN="$KIRO_API_KEY"',
        "claude",
      ].join("\n"),
    );
  });

  it("Codex defines a responses provider on /v1 that reads KIRO_API_KEY", () => {
    expect(snippets.codex).toBe(
      [
        'model = "claude-sonnet-5"',
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

  it("the OpenAI SDK snippets use /v1 and read KIRO_API_KEY from the env", () => {
    expect(snippets.openaiSdk.python).toContain(`base_url="${ORIGIN}/v1"`);
    expect(snippets.openaiSdk.python).toContain('api_key=os.environ["KIRO_API_KEY"]');
    expect(snippets.openaiSdk.python).toContain("client.chat.completions.create(");
    expect(snippets.openaiSdk.typescript).toContain(`baseURL: "${ORIGIN}/v1"`);
    expect(snippets.openaiSdk.typescript).toContain("apiKey: process.env.KIRO_API_KEY");
    expect(snippets.openaiSdk.typescript).toContain("new OpenAI(");
  });

  it("never contains a real key value", () => {
    const secrets = seedApiKeys().flatMap((k) => [k.key, k.keyMasked]);
    for (const snippet of all) {
      for (const secret of secrets) expect(snippet).not.toContain(secret);
      expect(snippet).not.toMatch(/sk-[0-9a-f]{8,}/);
    }
  });
});
