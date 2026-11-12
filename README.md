<div align="center">

<img src="screenshots/logo.png" alt="Kiro Proxy" width="180" />

# Kiro Proxy

#### Local proxy that converts Kiro accounts into OpenAI / Anthropic compatible endpoints.

<p>
  <a href="https://go.dev/"><img alt="Go" src="https://img.shields.io/badge/Go-1.25+-00ADD8?style=for-the-badge&logo=go&logoColor=white" /></a>
  <a href="https://www.docker.com/"><img alt="Docker" src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" /></a>
  <a href="https://www.sqlite.org/"><img alt="SQLite" src="https://img.shields.io/badge/SQLite-kiro.db-003B57?style=for-the-badge&logo=sqlite&logoColor=white" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-22C55E?style=for-the-badge" /></a>
</p>

<p>
  <a href="#-overview">Overview</a> •
  <a href="#-preview">Preview</a> •
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick&nbsp;Start</a> •
  <a href="#-configuration">Configuration</a> •
  <a href="#-usage">Usage</a> •
  <a href="#-thinking-mode">Thinking&nbsp;Mode</a> •
  <a href="#-outbound-proxy">Outbound&nbsp;Proxy</a> •
  <a href="#-safety">Safety</a>
</p>

[English](README.md) • [简体中文](README_CN.md) • [Português (Brasil)](README_PT-BR.md) • [Tiếng Việt](README_VI.md)

</div>

---

## 🌟 Overview

**Kiro Proxy** is a small Go service that turns one or more authorized **Kiro** accounts into a local API endpoint that speaks the **OpenAI** and **Anthropic** wire formats:

1. Pools multiple Kiro accounts and load-balances requests with round-robin, weights, and session affinity.
2. Translates Anthropic `/v1/messages`, OpenAI `/v1/chat/completions`, and OpenAI `/v1/responses` calls to and from Kiro upstream, including tools, thinking, reasoning effort, and web search.
3. Refreshes access tokens automatically and streams Server-Sent Events end-to-end, with keepalives and failover.
4. Ships with a React admin panel, embedded in the binary, for account management, live observability, and request audit, in English, 简体中文, Tiếng Việt, and Português (Brasil).

> [!IMPORTANT]
> Single-binary local proxy. **Not** a hosted service, **not** affiliated with Amazon, AWS, or Kiro. You must own or be authorized to use every account you add to the pool.

If this project helps you, a Star would mean a lot.

---

## 🖼 Preview

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/login-dark.webp">
    <img alt="Login" src="screenshots/en/login-light.webp" width="100%">
  </picture>
  <br><sub><b>Login</b> — sign-in with theme and language switches</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/overview-dark.webp">
    <img alt="Overview" src="screenshots/en/overview-light.webp" width="100%">
  </picture>
  <br><sub><b>Overview</b> — live traffic, credits and errors across accounts</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/accounts-dark.webp">
    <img alt="Accounts" src="screenshots/en/accounts-light.webp" width="100%">
  </picture>
  <br><sub><b>Accounts</b> — plan credits, status tabs, filters, batch actions and export</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/accounts-add-dark.webp">
    <img alt="Add account" src="screenshots/en/accounts-add-light.webp" width="100%">
  </picture>
  <br><sub><b>Add account</b> — every sign-in and import method in one dialog, each with its steps</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/accounts-detail-dark.webp">
    <img alt="Account details" src="screenshots/en/accounts-detail-light.webp" width="100%">
  </picture>
  <br><sub><b>Account details</b> — the sheet a row opens: plan credits, the last 24 hours, totals and settings</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/accounts-tester-dark.webp">
    <img alt="Model tester" src="screenshots/en/accounts-tester-light.webp" width="100%">
  </picture>
  <br><sub><b>Model tester</b> — test one model or every cached model at once; tap a row for its response and steps</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/requests-dark.webp">
    <img alt="Requests" src="screenshots/en/requests-light.webp" width="100%">
  </picture>
  <br><sub><b>Requests</b> — status tabs, search, sorting and a detail view</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/requests-detail-dark.webp">
    <img alt="Request details" src="screenshots/en/requests-detail-light.webp" width="100%">
  </picture>
  <br><sub><b>Request details</b> — the sheet a row opens: duration, credits, tokens and IDs</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/api-dark.webp">
    <img alt="API" src="screenshots/en/api-light.webp" width="100%">
  </picture>
  <br><sub><b>API</b> — API access, per-client keys with limits, highlighted client setup</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/backups-dark.webp">
    <img alt="Backups" src="screenshots/en/backups-light.webp" width="100%">
  </picture>
  <br><sub><b>Backups</b> — manual and scheduled backups, one-click restore</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/settings-1-dark.webp">
    <img alt="Settings" src="screenshots/en/settings-1-light.webp" width="100%">
  </picture>
  <br><sub><b>Settings</b> — usage, stream integrity, routing, auto-continue</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/settings-2-dark.webp">
    <img alt="Settings" src="screenshots/en/settings-2-light.webp" width="100%">
  </picture>
  <br><sub><b>Settings</b> — thinking and model mappings</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/en/settings-3-dark.webp">
    <img alt="Settings" src="screenshots/en/settings-3-light.webp" width="100%">
  </picture>
  <br><sub><b>Settings</b> — Kiro endpoint, admin password, outbound proxy</sub>
</p>

---

## ✨ Features

### 🛰 API surface

- Anthropic `/v1/messages` with native tool use and streaming, plus `/v1/messages/count_tokens`.
- OpenAI `/v1/chat/completions` with full tool-call shape parity.
- OpenAI `/v1/responses` with `previous_response_id` chaining and stored response retrieval.
- Codex-ready model list at `/v1/codex/models`, next to the standard `/v1/models`.
- SSE streaming for every endpoint, with mid-stream account failover on transient upstream errors and a keepalive every 15 seconds while the upstream is silent (long reasoning, held tool arguments).
- Anthropic's `web_search` server tool runs through Kiro's own web search, with results returned as search result blocks.
- Reasoning effort: OpenAI `reasoning_effort` and Claude `output_config.effort` (`low` to `xhigh`) turn on thinking and reach models that support effort levels; `minimal` turns it off.
- Tool-call rescue: tool calls that Kiro leaks into the answer as markup are turned back into real tool calls (switch off with `KIRO_TOOL_MARKUP_RESCUE=off`).
- Request body decompression (gzip/deflate) for clients that pre-compress payloads.

### 🧰 Request handling

- **Auto-continue** (opt-in): when an answer stops at Kiro's ~8192-token output cap without a tool call, the proxy asks Kiro to continue and appends the rest, up to 10 times.
- **Structured tool history**: earlier tool calls and results reach the model as real tool calls, so long agent sessions keep calling tools; a rejected request is retried once as plain text.
- **Prompt filter**: replaces Claude Code's built-in system prompt with a compact one, strips environment noise (env vars, git status, recent commits), and applies your own line or regex rules in order.
- **Model mappings**: ordered, drag-to-reorder rules that send any client model name to a Kiro model ID; the first match wins.
- **Stream integrity**: rejects replies that end without a stop reason or metering event, with an opt-in lenient mode for IdC and Enterprise accounts that send neither.
- **Endpoint choice**: pick a Kiro endpoint or let the proxy choose by availability, with optional fallback to the others.

### 👥 Account pool

- Multiple Kiro accounts with round-robin selection per model and a per-account weight (an account with weight N takes about N times as many new requests).
- Session affinity: follow-up turns return to the account that answered the previous turn and already holds the prompt cache; new conversations still rotate.
- Automatic OAuth token refresh ahead of expiry, safe under concurrent requests; account cooldowns survive restarts.
- Auth methods: AWS Builder ID, IAM Identity Center (Enterprise SSO), Microsoft SSO (Entra ID), SSO token, Kiro IDE local cache, credentials JSON, Kiro web cookie, and headless Kiro API keys (`ksk_…`).
- Per account: its own outbound proxy, device (machine) ID, pinned Kiro profile, model list refresh, connection test, and the real Kiro overage switch.
- Optional overage: accounts keep serving after their credits run out.
- Per-account import / export and bulk operations.

### 🛡 Admin panel

- React single-page app embedded in the binary; no separate web server to run.
- Overview dashboard that updates live: KPI cards for accounts, requests, successes and failures with hourly trends, per-minute live tiles with sparklines, traffic over time, a model-mix donut, and traffic by account as stacked bars. Its cards keep Kiro account credit usage apart from proxy request usage.
- Accounts with status tabs and counts, filters (plan, auth, region, enabled), sorting, batch actions, a detail view, connection tests, and export.
- Requests log with status tabs and counts, search (it also matches the full API key), sorting, a detail view with error categories, masked API keys, and SQLite-backed history.
- API page with client API key management (optional custom key values, enable/disable, per-key token and credit limits, usage reset) and a syntax-highlighted client setup builder: request code for the Anthropic Messages, OpenAI Chat Completions and OpenAI Responses APIs in curl, Python, Node.js, Go, Java, PHP, Ruby and C# (official SDK or plain HTTP, streaming or not) with a sample response, plus Claude Code and Codex setup.
- Settings for usage, routing, auto-continue, tool history, thinking, model mappings, prompt filter, stream integrity, endpoint, outbound proxy, admin password, and statistics reset; Backups with a schedule, upload, and one-click restore.
- Command menu (<kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd>) for pages and actions, privacy mode that masks email addresses, and an update check that reads `version.json` from the repo's `main` branch.
- Changing the admin password ends every other signed-in session.
- Light, dark, and system theme; four UI languages: English, 简体中文, Tiếng Việt, and Português (Brasil).
- Works from phones to desktops.

### 🌐 Networking

- Outbound proxy support — SOCKS5, HTTP, or HTTPS, switched live without restart, with a per-account override.
- Configurable thinking-mode suffix and Anthropic `thinking` config passthrough.

### 🧩 Storage

- Single-file SQLite (`modernc.org/sqlite`) database at `kiro.db`, using DELETE journal mode.
- Final request rows are the source of truth for dashboard request, token, credit, success, and failed totals.
- 30-day retention on stored responses, asynchronous writes off the request hot path.

---

## ⚙️ Requirements

| Component | Version              |
| --------- | -------------------- |
| Go        | 1.25 +               |
| Node.js   | 22 + with pnpm (only to build the admin UI from source) |
| OS        | Linux / macOS        |
| Container | Docker 24+ optional  |
| Storage   | Local volume on disk |

---

## 🚀 Quick Start

### 🐳 Docker Compose (recommended)

```bash
git clone https://github.com/tanu360/kiro-reverse-api.git
cd kiro-reverse-api
docker-compose up -d
```

### 🐳 Docker Run

```bash
docker run -d \
  --name kiro-proxy \
  -p 8080:8080 \
  -e ADMIN_PASSWORD=your_secure_password \
  -v /path/to/kiro-proxy-state:/app/state \
  --restart unless-stopped \
  ghcr.io/tanu360/kiro-reverse-api:latest
```

### 📦 Download a binary

Every [release](https://github.com/tanu360/kiro-reverse-api/releases) ships a ready-to-run binary for Linux, macOS and Windows on amd64 and arm64, with the admin UI built in. You need no Go, Node.js or Docker.

```bash
# Swap linux_amd64 for your platform: linux_arm64, darwin_amd64 or darwin_arm64
curl -LO https://github.com/tanu360/kiro-reverse-api/releases/latest/download/kiro-proxy_linux_amd64.tar.gz
tar -xzf kiro-proxy_linux_amd64.tar.gz
cd kiro-proxy_linux_amd64
./kiro-proxy
```

On Windows, download `kiro-proxy_windows_amd64.zip` (or `_arm64`), extract it and run `kiro-proxy.exe` from a terminal. The database is created in the current folder; set `DATA_DIR` to keep it somewhere else. `SHA256SUMS.txt` on the release lists every archive's checksum: check a download with `sha256sum -c SHA256SUMS.txt --ignore-missing` (macOS: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`). The binaries are not signed: if macOS refuses to open `kiro-proxy`, run `xattr -d com.apple.quarantine kiro-proxy`, and Windows SmartScreen may ask before the first run.

### 🛠 Build from source

```bash
git clone https://github.com/tanu360/kiro-reverse-api.git
cd kiro-reverse-api
cd ui && pnpm install && pnpm build && cd ..
go build -o kiro-proxy .
./kiro-proxy
```

The admin UI needs Node.js 22+ and pnpm to build. `go build` embeds whatever is in `ui/dist`: without the UI build, `/` shows a "UI not built" page while the API keeps working. The Docker image builds both.

### 🎨 Admin UI development

Run these from `ui/`:

| Command         | What it does                                                                    |
| --------------- | ------------------------------------------------------------------------------- |
| `pnpm dev`      | Dev server on `http://localhost:5173/admin/`; proxies `/admin/api` and `/v1` to `127.0.0.1:8080` |
| `pnpm dev:mock` | Dev server with mock data and no backend; sign in with password `12345678`       |
| `pnpm test`     | Unit and component tests (Vitest)                                               |
| `pnpm test:e2e` | Browser smoke tests against mock mode (Playwright)                              |

> [!TIP]
> `kiro.db` is auto-created on first launch. Set `DATA_DIR` to store it somewhere else; Docker uses `/app/state`. Set `ADMIN_PASSWORD` to choose the admin password. Otherwise, the first launch generates a random 8-digit password, saves it, and prints it once in the startup logs. The login page shows it until the first successful sign-in. Docker users can read it with `docker compose logs kiro-proxy`. Restarts retain the saved password. An unclaimed 48-character password from an older version is replaced once with an 8-digit password; passwords already used to sign in or explicitly configured are preserved.

---

Request bodies are limited to 32 MiB, both on the wire and after each decompression layer. Up to three encoding layers are accepted. Oversized requests return HTTP 413. At most eight compressed bodies are decompressed at once; further compressed requests wait their turn, and uncompressed requests never wait. Body reads have a 30-second deadline.

Admin password authentication allows five failed attempts per client per minute, across sign-in and `X-Admin-Password` requests; an IPv4 address or an IPv6 /64 counts as one client. After 30 failures in a minute across all clients, each client drops to one attempt per minute for the rest of that minute, which slows distributed guessing without locking anyone out. Further attempts return HTTP 429 with `Retry-After`; existing session tokens continue working. Forwarded IP headers are not trusted, so clients behind the same reverse proxy share its IP budget. Successful password checks do not consume the failure budget. Backup restores preserve an active `ADMIN_PASSWORD` override.

## 🔧 Configuration

| Variable         | Purpose                                   | Default            |
| ---------------- | ----------------------------------------- | ------------------ |
| `DATA_DIR`        | Directory for `kiro.db`                   | `.`                |
| `ADMIN_PASSWORD` | Admin panel password (overrides config)   | —                  |
| `LISTEN_HOST`    | Address to listen on. The default accepts this machine only; set `0.0.0.0` to accept other machines. The Docker image sets `0.0.0.0` | `127.0.0.1` |
| `KIRO_TOOL_MARKUP_RESCUE` | Set `off` to stop turning tool-call markup that Kiro leaks into answer text back into tool calls | on |
| `LOG_LEVEL`      | Log level: `debug`, `info`, `warn`, or `error` (overrides config) | `info` |

> [!WARNING]
> `kiro.db` holds OAuth tokens and admin credentials. Treat it as secret — keep it out of git, screenshots, and chat threads. Mount the database directory as a private volume.

---

## 🕹 Usage

Open `http://localhost:8080`, log in, add accounts, then call the API:

```bash
# Anthropic — Claude
curl http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4.5","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'

# OpenAI — Chat Completions
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'

# OpenAI — Responses
curl http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any" \
  -d '{"model":"gpt-4o","input":"Hello!"}'
```

### 📌 Endpoints at a glance

| Method   | Path                            | What it does                                  |
| -------- | ------------------------------- | --------------------------------------------- |
| `POST`   | `/v1/messages`                  | Anthropic-format Claude completions           |
| `POST`   | `/v1/messages/count_tokens`     | Anthropic-format token count                  |
| `POST`   | `/v1/chat/completions`          | OpenAI-format chat completions                |
| `POST`   | `/v1/responses`                 | OpenAI Responses API (stored + chained)       |
| `GET`    | `/v1/responses/{id}`            | Retrieve a previously stored response         |
| `DELETE` | `/v1/responses/{id}`            | Delete a stored response                      |
| `GET`    | `/v1/models`                    | List available models                         |
| `GET`    | `/v1/codex/models`              | Model list in the Codex CLI format            |
| `GET`    | `/v1/stats`                     | Aggregate proxy usage statistics              |
| `GET`    | `/health`                       | Health check                                  |
| `GET`    | `/`                             | Web admin panel (embedded SPA; page links such as `/accounts` open the app, old `/admin/*` links redirect, and a client that does not ask for HTML gets the health check) |

---

## 🔑 Managed API Keys

Require API keys from the **API** page (**API access → Require an API key**). You can create multiple client keys with independent limits:

- Leave **Custom key (optional)** blank to auto-generate a secure `sk-...` key, or enter your own key value.
- Lists and request logs show masked keys such as `sk-clb****e4yo`; the full key remains stored for authentication and copying from key detail.
- Token and credit quota checks use exact raw values. Rounded or compact UI labels are display-only.
- A token or credit limit of `0` means unlimited for that dimension.

---

## 📊 Stats Semantics

The Overview page and the Accounts page intentionally answer different questions:

- **Accounts card**: current configured Kiro accounts, using Kiro server quota fields (`usage_current / usage_limit`).
- **Requests card**: app/proxy history from SQLite `requests` rows: `COUNT(*)`, `SUM(total_tokens)`, and `SUM(credits)`.
- **Succeeded / Failed cards**: final proxy request outcomes from the same `requests` table.
- **Account cards**: current visible account counters saved on the account record (`requestCount`, `totalTokens`, `totalCredits`).

If an old/deleted account still has rows in `requests`, the Overview's **Proxy credits** can be higher than the visible account credit sum. Use **Settings → Danger zone → Reset statistics** or a one-time DB cleanup if you want historical request rows cleared.

Token labels may display compactly (`54.5M`, `476.5K`), but backend math and quota checks use raw numbers.

---

## 🧠 Thinking Mode

Append a suffix (default `-thinking`) to the model name to enable reasoning, e.g. `claude-sonnet-4.5-thinking`.

Claude-compatible requests that include a top-level `thinking` config also enable the mode automatically:

```json
{ "type": "enabled", "budget_tokens": 2048 }
{ "type": "adaptive" }
```

OpenAI `reasoning_effort` and Claude `output_config.effort` work too: `low`, `medium`, `high`, or `xhigh` turns thinking on and is passed to models that support effort levels, and `minimal` turns it off.

Output format is configured in **Settings → Thinking** in the admin panel.

---

## 🛰 Outbound Proxy

For users in restricted network regions, configure an outbound proxy in the admin panel under **Settings → Outbound proxy**.

| Type     | Example                       |
| -------- | ----------------------------- |
| SOCKS5   | `socks5://127.0.0.1:1080`     |
| HTTP     | `http://127.0.0.1:8888`       |
| HTTPS    | `https://proxy.example.com:443` |

> [!TIP]
> The setting takes effect immediately, no restart required. An account can also use its own proxy (account detail → **Account proxy**); leave it empty to use the global one.

---

## 🔐 Environment Variables

| Variable         | Description                              | Default            |
| ---------------- | ---------------------------------------- | ------------------ |
| `DATA_DIR`        | Directory for `kiro.db`                  | `.`                |
| `ADMIN_PASSWORD` | Admin panel password (overrides config)  | —                  |
| `LISTEN_HOST`    | Address to listen on. The default accepts this machine only; set `0.0.0.0` to accept other machines. The Docker image sets `0.0.0.0` | `127.0.0.1` |
| `KIRO_TOOL_MARKUP_RESCUE` | Set `off` to stop turning tool-call markup that Kiro leaks into answer text back into tool calls | on |
| `LOG_LEVEL`      | Log level: `debug`, `info`, `warn`, or `error` (overrides config) | `info` |

```diff
+ kiro.db                # local state — config, credentials, SQLite history, backup blobs
```

> [!CAUTION]
> Treat `kiro.db` as sensitive — it stores account tokens and admin credentials in plain text on disk.

---

## 🙏 Project Credits

This project is a continuation of [Quorinex/Kiro-Go](https://github.com/Quorinex/Kiro-Go). Due credit for the original work belongs to the original author; I am continuing and maintaining it forward.

The admin UI builds on open-source work from [Studio Admin](https://github.com/arhamkhnz/next-shadcn-admin-dashboard), [t3code](https://github.com/pingdotgg/t3code), [coss ui](https://github.com/cosscom/ui), [Bklit UI](https://github.com/bklit/bklit-ui) and [openstatus data-table-filters](https://github.com/openstatusHQ/data-table-filters). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for their licenses.

---

## 🛡 Safety

- ✅ Use only with accounts you are **authorized** to operate.
- ❌ Do **not** use for bulk account scraping or terms-of-service evasion.
- ❌ Do **not** add CAPTCHA bypass, identity spoofing, or rate-limit evasion.
- 🔐 Keep `kiro.db` out of git, public backups, and screenshots.
- 🧯 If upstream returns persistent auth errors, the proxy fails fast — investigate before retrying.

> [!IMPORTANT]
> For educational and research purposes only. Not affiliated with Amazon, AWS, or Kiro. Users are responsible for complying with applicable terms of service and laws. Use at your own risk.

---

## 📄 License

[MIT](./LICENSE)

---

<div align="center">
<sub>Built with ❤️ in Go · If this saved you time, drop a ⭐ on the repo.</sub>
</div>
