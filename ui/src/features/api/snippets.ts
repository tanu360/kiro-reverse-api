// Client setup snippets. They only ever name the KIRO_API_KEY env var: never a real key.
// Checked against the current docs:
// - Claude Code: ANTHROPIC_BASE_URL overrides the API endpoint; ANTHROPIC_AUTH_TOKEN is sent as
//   "Authorization: Bearer <value>" (https://code.claude.com/docs/en/env-vars).
// - Codex: [model_providers.<id>] with name, base_url, env_key and wire_api = "responses", picked
//   by model_provider in ~/.codex/config.toml (https://developers.openai.com/codex/config-advanced).

// "auto" lets Kiro pick the model per task. Every account serves it, free tier included, and
// /v1/models always lists it, so the snippets run as pasted whatever the accounts hold.
export const SNIPPET_MODEL = "auto";
export const SNIPPET_KEY_ENV = "KIRO_API_KEY";

interface ClientSnippets {
  curl: { anthropic: string; openai: string };
  claudeCode: string;
  codex: string;
  openaiSdk: { python: string; typescript: string };
}

const lines = (...parts: string[]) => parts.join("\n");

const MESSAGES_FIELD = '"messages": [{"role": "user", "content": "Hello"}]';

/** A JSON object for curl -d: "{" stays on the -d line, the fields are indented below it. */
function curlBody(fields: string[]): string {
  return `{\n${fields.map((field) => `    ${field}`).join(",\n")}\n  }`;
}

/** Every snippet for a proxy reachable at `origin` (e.g. location.origin). */
export function buildClientSnippets(origin: string, model: string = SNIPPET_MODEL): ClientSnippets {
  const env = SNIPPET_KEY_ENV;
  const baseV1 = `${origin}/v1`;
  return {
    curl: {
      anthropic: lines(
        `curl "${origin}/v1/messages" \\`,
        `  -H "x-api-key: $${env}" \\`,
        `  -H "anthropic-version: 2023-06-01" \\`,
        `  -H "content-type: application/json" \\`,
        `  -d '${curlBody([`"model": "${model}"`, '"max_tokens": 1024', MESSAGES_FIELD])}'`,
      ),
      openai: lines(
        `curl "${origin}/v1/chat/completions" \\`,
        `  -H "Authorization: Bearer $${env}" \\`,
        `  -H "content-type: application/json" \\`,
        `  -d '${curlBody([`"model": "${model}"`, MESSAGES_FIELD])}'`,
      ),
    },
    claudeCode: lines(
      `export ANTHROPIC_BASE_URL="${origin}"`,
      `export ANTHROPIC_AUTH_TOKEN="$${env}"`,
      "claude",
    ),
    codex: lines(
      `model = "${model}"`,
      'model_provider = "kiro"',
      "",
      "[model_providers.kiro]",
      'name = "Kiro Proxy"',
      `base_url = "${baseV1}"`,
      `env_key = "${env}"`,
      'wire_api = "responses"',
    ),
    openaiSdk: {
      python: lines(
        "import os",
        "from openai import OpenAI",
        "",
        "client = OpenAI(",
        `    base_url="${baseV1}",`,
        `    api_key=os.environ["${env}"],`,
        ")",
        "",
        "response = client.chat.completions.create(",
        `    model="${model}",`,
        '    messages=[{"role": "user", "content": "Hello"}],',
        ")",
        "print(response.choices[0].message.content)",
      ),
      typescript: lines(
        'import OpenAI from "openai";',
        "",
        "const client = new OpenAI({",
        `  baseURL: "${baseV1}",`,
        `  apiKey: process.env.${env},`,
        "});",
        "",
        "const response = await client.chat.completions.create({",
        `  model: "${model}",`,
        '  messages: [{ role: "user", content: "Hello" }],',
        "});",
        "console.log(response.choices[0].message.content);",
      ),
    },
  };
}
