import { seedProxyPoolMock } from "@/features/proxy-pool/mocks";
import { mockDb, mockNowUnix } from "./db";

/*
 * The browser mock's showcase: on top of the full dataset it fills what a fresh install leaves
 * empty, so every 3.3.0 screen has something to show. Only browser.ts calls it, for the full
 * dataset; the vitest suites never see these extras.
 */

/** The 3.3.0 notes from version.json, so the update dialog shows the real release. */
const RELEASE_NOTES = [
  "🔀 Priority routing: accounts serve in an order you set, and the next one steps in only when the one before cannot serve.",
  "⏱️ Each account shows its requests per minute and today, and you can cap how many requests it starts per minute.",
  "🩹 Self-heal lifts the proxy's own bans and cooldowns after an outage, so traffic resumes on its own. It is on by default.",
  "🏷️ Accounts take a nickname, notes and tags, and the Accounts page filters and searches by them.",
  "🔑 Sign in again fixes a broken sign-in in place. The account keeps its settings, stats and history.",
  "🧬 Adding an account you already have updates it, and Review merges the copies you have. A backup is saved first.",
  "🔄 You choose how often the proxy refreshes credits and tokens in the background, or turn it off.",
  "🔔 Alerts by webhook, Telegram, Discord or Slack when credits run low, an account is banned or no account can serve.",
  "🗝️ An API key can be bound to chosen accounts, capped at a number of successful calls, and regenerated.",
  "📈 Usage by key shows each client's requests, failures, tokens and credits over 24 hours, 7 days or 30 days.",
  "🧭 Request details list every upstream attempt: the account, the endpoint, the time it took and why it moved on.",
  "📨 Custom response headers, such as X-Request-Id, on every API response.",
  "🖼️ Large images, such as full-screen screenshots, are shrunk before they reach Kiro.",
  "🎯 A model Kiro lists itself, such as gpt-5.6-sol on Pro accounts, is no longer rewritten by a partial model mapping.",
  "💭 Thinking signatures and redacted thinking pass through /v1/messages and are accepted in the history.",
  "🧾 Structured output: a JSON schema request on any of the three APIs is checked against the schema and retried once.",
  "🌐 Proxy pool: spread accounts over several outbound proxies, with health checks and failover.",
  "🗺️ Upstream domain and region: pick the Kiro API domain and override the API and sign-in regions.",
  "🧹 Log retention deletes request and error rows older than 90 days by default, the first time at the first start after this update. Overview totals stay correct.",
  "📆 Usage by key and the Overview traffic chart have an All time range. It still counts the rows that log retention deleted.",
  "📦 Release binaries for Linux and Windows (x64 and arm64) and macOS (Apple silicon and Intel), with the admin UI built in.",
  "🧯 A failed outbound proxy now shows as a Proxy error, with a plain sentence in the request details and on the Proxy pool page.",
  "🪵 Settings has a Server log card that changes the log level at once, with no restart.",
  "🧩 Codex keeps its own system prompt when it reads /v1/codex/models through model_catalog_json, and it gets the apply_patch tool.",
  "🔒 The request log keeps only masked client keys. Keys that older versions stored in full are masked at the first start.",
  "🆙 The update dialog has New, Fixes and How to update tabs. How to update opens on the way that fits this server, with the release binary for its own platform.",
  '🔧 Fixed: Claude Code in stream-json mode no longer gets two errors before each answer (thinking display "updates").',
  "🔧 Fixed: errors that a retry cannot fix tell clients not to retry, so Claude Code stops at once instead of retrying for minutes.",
  "🔧 Fixed: a streamed answer no longer starts with blank lines after a thinking block.",
  "🔧 Fixed: Chat Completions streams send the usage chunk that stream_options.include_usage asks for.",
  "🔧 Fixed: Requests files a used-up call limit as API key limit and a model no account serves as Invalid request.",
  "🔧 Fixed: the duplicate accounts dialog explains each step, phone account cards show tags on their own line, and the self-heal interval reads as a duration.",
  "🔧 Fixed: max_tokens, max_output_tokens and stop sequences now cut the answer on every API, and Kiro stops writing. A /v1/messages request without max_tokens gets the model's maximum output.",
  "🔧 Fixed: deepseek-3.2 no longer shows its DSML tool-call markup before a tool call.",
  "🔧 Fixed: budget_tokens and the reasoning effort now set how long the model thinks.",
  "🔧 Fixed: GET /v1/models/{id} works, and errors, thinking blocks and usage carry the fields the SDKs read.",
  "🔧 Fixed: the At limit hint opens on tap and from the keyboard, and an account the pool skips after errors reads Cooling down.",
  "🔧 Fixed: in priority routing, a conversation goes back to a higher-priority account as soon as that account is free again.",
  "🔧 Fixed: answers cut by a stop sequence or max_tokens report the same input tokens as whole answers, and streamed and non-streamed text match.",
  "🔧 Fixed: a wrong HTTP method on an API path answers a JSON 405, and validation errors name the field and any content type the proxy cannot read.",
  "🔧 Fixed: the outbound proxy dialog checks the host and port, and a save error shows inside the open dialog.",
  "🔧 Fixed: the Requests search is never written to the address bar, so a key you search for stays out of your browser history.",
  "🔧 Fixed: the API page's Claude Code setup sets models free accounts can use, and the Codex setup saves the model list Codex reads.",
  "🔧 Fixed: a Builder ID account imported without its provider gets the fixed Builder ID profile, so chat and model listing no longer fail with profileArn is required.",
].join("\n");

const DAY = 86_400;

export function applyShowcase(): void {
  const now = mockNowUnix();

  // The server runs 3.2.0 and 3.3.0 is out: the update notice and dialog show the real notes.
  mockDb.version = "3.2.0";
  mockDb.remoteVersion = { version: "3.3.0", changelog: RELEASE_NOTES };

  mockDb.responseHeaders = [
    { name: "X-Request-Id", value: "{request_id}", enabled: true },
    { name: "X-Kiro-Account", value: "{account_id}", enabled: true },
    { name: "X-Served-By", value: "kiro-proxy {model}", enabled: false },
  ];

  // An older sign-in of one account, so Accounts offers the duplicates review.
  const original = mockDb.accounts.find(
    (account) => account.authMethod.toLowerCase() === "idc" && account.email.trim() !== "",
  );
  if (original) {
    const id = `dup-${original.id.slice(4)}`;
    const copy = {
      ...original,
      id,
      nickname: original.nickname ? `${original.nickname} (old)` : "",
      lastRefresh: original.lastRefresh - 21 * DAY,
      expiresAt: original.expiresAt - 21 * DAY,
      enabled: false,
    };
    mockDb.accounts.push(copy);
    const secret = mockDb.secrets[original.id];
    if (secret) mockDb.secrets[id] = { ...secret, ...copy };
  }

  // A running pool: two healthy proxies, one that fails, one never checked.
  const ids = mockDb.accounts.filter((account) => account.enabled).map((account) => account.id);
  const assignments: Record<string, string> = {};
  ids.slice(0, 9).forEach((accountId, index) => {
    assignments[accountId] = index % 3 === 2 ? "p2" : "p1";
  });
  // The proxy pool's times are Unix milliseconds, as the server sends them; `now` is seconds.
  seedProxyPoolMock({
    mode: "on",
    directFallback: true,
    checkIntervalMin: 10,
    proxies: [
      {
        id: "p1",
        label: "Frankfurt residential",
        url: "socks5h://de1.proxy.northwind.studio:1080",
        username: "kiro",
        password: "showcase-secret",
        createdAt: (now - 12 * DAY) * 1000,
        health: { status: "ok", checkedAt: (now - 4 * 60) * 1000, latencyMs: 182 },
      },
      {
        id: "p2",
        label: "Virginia DC",
        url: "http://us-east.proxy.northwind.studio:3128",
        username: "",
        password: "",
        createdAt: (now - 9 * DAY) * 1000,
        health: { status: "ok", checkedAt: (now - 4 * 60) * 1000, latencyMs: 64 },
      },
      {
        id: "p3",
        label: "Singapore backup",
        url: "https://sg.proxy.northwind.studio:8443",
        username: "kiro",
        password: "showcase-secret",
        createdAt: (now - 3 * DAY) * 1000,
        health: {
          status: "failed",
          checkedAt: (now - 4 * 60) * 1000,
          failedAt: (now - 4 * 60) * 1000,
          lastError: "proxyconnect tcp: dial tcp: i/o timeout",
          errorCode: "timeout",
        },
      },
      {
        id: "p4",
        label: "",
        url: "socks5://10.0.0.24:1080",
        username: "",
        password: "",
        createdAt: (now - 20 * 60) * 1000,
        health: { status: "unknown" },
      },
    ],
    assignments,
  });
}
