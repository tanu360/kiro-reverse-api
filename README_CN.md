<div align="center">

<img src="screenshots/logo.png" alt="Kiro Proxy" width="180" />

# Kiro Proxy

#### 本地代理，将 Kiro 账号转换为兼容 OpenAI / Anthropic 的接口。

<p>
  <a href="https://go.dev/"><img alt="Go" src="https://img.shields.io/badge/Go-1.25+-00ADD8?style=for-the-badge&logo=go&logoColor=white" /></a>
  <a href="https://www.docker.com/"><img alt="Docker" src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" /></a>
  <a href="https://www.sqlite.org/"><img alt="SQLite" src="https://img.shields.io/badge/SQLite-kiro.db-003B57?style=for-the-badge&logo=sqlite&logoColor=white" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-22C55E?style=for-the-badge" /></a>
</p>

<p>
  <a href="#-概览">概览</a> •
  <a href="#-界面预览">界面预览</a> •
  <a href="#-功能特性">功能特性</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-配置">配置</a> •
  <a href="#-使用方法">使用方法</a> •
  <a href="#-思考模式">思考模式</a> •
  <a href="#-出站代理">出站代理</a> •
  <a href="#-安全须知">安全须知</a>
</p>

[English](README.md) • [简体中文](README_CN.md) • [Português (Brasil)](README_PT-BR.md) • [Tiếng Việt](README_VI.md)

</div>

---

## 🌟 概览

**Kiro Proxy** 是一个轻量级 Go 服务，将一个或多个已授权的 **Kiro** 账号转换为本地 API 端点，支持 **OpenAI** 和 **Anthropic** 协议格式：

1. 多账号池化，按轮询、权重或优先级以及会话亲和对请求做负载均衡。
2. 在 Anthropic `/v1/messages`、OpenAI `/v1/chat/completions`、OpenAI `/v1/responses` 调用与 Kiro 上游之间双向翻译，涵盖工具调用、思考、推理强度与网络搜索。
3. 自动刷新访问令牌，端到端转发 Server-Sent Events 流，支持保活与故障转移。
4. 自带内嵌于二进制文件的 React 管理面板，提供账号管理、实时可观测性与请求审计，界面支持 English、简体中文、Tiếng Việt 与 Português (Brasil)。

> [!IMPORTANT]
> 单二进制本地代理。**非**托管服务，**不**隶属于 Amazon、AWS 或 Kiro。账号必须由你本人持有或经过合法授权方可加入账号池。

如果项目对你有帮助，欢迎点个 Star 鼓励一下。

---

## 🖼 界面预览

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/zh/overview-dark.webp">
    <img alt="概览" src="screenshots/zh/overview-light.webp" width="100%">
  </picture>
  <br><sub><b>概览</b> — 各账号的实时流量、Credits 与错误</sub>
</p>

<p align="center">📸 <a href="docs/SCREENSHOTS_CN.md"><b>更多截图</b></a> — 账号、请求、接口、备份与设置</p>

## ✨ 功能特性

### 🛰 API 接口

- Anthropic `/v1/messages`，原生工具调用与流式输出，另提供 `/v1/messages/count_tokens`。
- OpenAI `/v1/chat/completions`，工具调用结构完全对齐。
- OpenAI `/v1/responses`，支持 `previous_response_id` 链式调用与已存响应回查。
- `/v1/codex/models` 提供可直接用于 Codex 的模型列表，与标准的 `/v1/models` 并存。
- 全部端点支持 SSE 流式输出：上游瞬时错误时可在流中切换账号继续；上游无输出时（长时间推理、工具参数尚在缓冲）每 15 秒发送一次保活。
- Anthropic 的 `web_search` 服务端工具通过 Kiro 自带的网络搜索执行，结果以搜索结果块返回。
- 推理强度：OpenAI `reasoning_effort` 与 Claude `output_config.effort`（`low` 至 `xhigh`）会开启思考，并传递给支持强度等级的模型；`minimal` 则关闭思考。
- 结构化输出：OpenAI `response_format`（`json_object`、`json_schema`）、Claude `output_config.format` 与 Responses `text.format` 返回纯 JSON，并按 Schema 校验（见[结构化输出](#-结构化输出)）。
- Thinking 签名：在 `/v1/messages` 中，思考块会携带 Kiro 返回的 `signature`（流式输出时为 `signature_delta`），`redacted_thinking` 块原样透传。
- 工具调用还原：Kiro 以标记形式混入回复文本的工具调用会被还原为真正的工具调用（可用 `KIRO_TOOL_MARKUP_RESCUE=off` 关闭）。
- 支持请求体解压（gzip/deflate），方便预压缩负载的客户端接入。

### 🧰 请求处理

- **自动续写**（需手动开启）：回复在 Kiro 约 8192 Token 的输出上限处停止且未调用工具时，代理会请求 Kiro 继续，并追加后续内容，最多 10 次。
- **结构化工具历史**：历史中的工具调用及其结果以真实的工具调用形式发送给模型，长时间的智能体会话因此会继续调用工具；被拒绝的请求会以纯文本重试一次。
- **System Prompt 过滤**：将 Claude Code 内置的 System Prompt 替换为精简版本，去除环境噪音（环境变量、git 状态、最近提交），并按顺序应用你自定义的行级或正则规则。
- **模型映射**：有序规则，可拖拽排序，将任意客户端模型名映射到 Kiro 模型 ID；先匹配者生效。Kiro 自身列出的模型只会被写出完整模型名的规则改写，因此 `gpt-5` 这类子串规则不会改写原生模型。
- **流完整性**：拒绝既没有停止原因也没有计量事件就结束的回复；对两者都不发送的 IdC 和企业账号，可选择开启宽松模式。
- **端点选择**：指定 Kiro 端点，或由代理根据可用性自动选择，并可选择在不可用时切换到其他端点。
- **图片缩放**（默认开启）：宽或高超过 1568 px、或大于 400 KB 的图片会先缩小并重新编码，再发送给 Kiro。两个上限都可以在设置中调整。
- **响应头**：最多 20 个自定义响应头，附加到每个 API 响应上，流式响应与错误响应也不例外。值中可使用 `{request_id}`、`{model}`、`{account_id}`、`{key_id}` 与 `{client_ip}`；`{request_id}` 即请求日志中的追踪 ID。

### 👥 账号池

- 多个 Kiro 账号，支持三种路由模式。**加权**（默认）：按模型粒度轮询，并可为每个账号设置权重（权重为 N 的账号承接约 N 倍的新请求）。**优先级**：每个新请求交给能处理它、且优先级数字最小（0–999）的账号；该账号冷却中、Credits 用尽、被停用或不支持该模型时，由下一个账号接手。**先重置先用**：每个新请求交给仍有剩余 Credits、且 Credits 最先重置的账号，让重置时会过期的 Credits 先被用掉；同一天重置的账号中，剩余 Credits 最多的优先。没有剩余 Credits 的账号排在最后，仅在允许超额使用时才承接请求。
- 会话亲和（「**同一会话固定使用同一账号**」）：会话的后续轮次会回到上一轮应答的账号，该账号已持有提示缓存；新会话仍按路由模式分配。优先级模式下以优先级为先：优先级更高的账号重新空闲后，进行中会话的下一轮就会发往该账号；优先级相同的账号不会接走会话。先重置先用模式下，只有 Credits 更早一天重置的账号才会接走会话的下一轮。关闭后，每个请求都按路由模式重新选择账号。
- 可选的单账号每分钟请求上限（1 至 1000）：达到上限的账号会被跳过，所有账号都达到上限时，客户端收到 HTTP 429。没有到达 Kiro 的尝试（代理或连接失败）不计入上限。账号页实时显示每个账号的每分钟请求数与今日请求数。
- Credits 预测：根据每个账号最近 7 天的 Credits 消耗，详情中显示按此速度 Credits 何时用尽、重置时还会剩多少未用。账号列表会标出在 Credits 重置前就会用尽的账号。
- **自动恢复**（默认开启）：没有账号可用时，代理会解除由它自己施加的鉴权封禁与错误冷却并重试；两次恢复至少间隔 5 分钟，连续 5 次恢复后仍没有成功的请求就停止（两项均可调整）。Kiro 的封停（"locked your account" 的 403 也算作封停）、你手动停用的账号以及额度冷却永远不会被解除。
- OAuth 令牌在过期前自动刷新，并发请求下也安全；账号冷却状态在重启后保留。
- 后台默认每 30 分钟刷新一次用量与即将过期的令牌；可选 5 分钟至 24 小时，或选择关闭，只在手动刷新时更新用量（请求需要时令牌仍会续期）。
- 再次登录或导入已存在的账号时，会更新该账号而不是新增副本。再次添加已保存的 Kiro API Key 会被拒绝，返回 HTTP 409（已添加）；但如果它带有备注或标签且区域相同（例如把导出的文件导入回同一个后端），则会更新已保存的账号：标签合并进去，空的备注与昵称会被填上。旧版本遗留的副本（刷新令牌、Kiro API Key 或用户 ID 相同，或邮箱与登录方式都相同）会在账号页显示提示；点击「**检查**」，即可在自动备份后把每组合并为一个账号，请求记录随之保留，计数累加，备注与标签合并；保留的账号没有独立代理时，会沿用副本的独立代理。
- 每个账号菜单中的「**重新登录**」会原地替换该账号的登录凭证，并保留其 ID、设置、备注、标签与统计。重新登录会解除封禁，但你手动停用的账号仍保持停用。如果新的登录属于另一个用户，代理会先请你确认，再替换身份。如果新的登录属于账号池中的另一个账号，则直接拒绝，返回 HTTP 409（`relogin_other_account`），不提供确认：当前账号保持不变，管理面板会显示是哪个账号，以及该账号是否已改用新的令牌。
- 每个账号可添加备注（最多 2000 字符）与最多 10 个标签（每个最多 24 字符）。搜索会匹配备注与标签，标签可用于标签筛选与批量操作，导出与导入都会保留两者。
- 鉴权方式：AWS Builder ID、IAM Identity Center（企业 SSO）、Microsoft SSO（Entra ID）、SSO Token、Kiro IDE 本地缓存、凭证 JSON、Kiro 网页 Cookie，以及无界面的 Kiro API Key（`ksk_…`）。在「**添加账号**」中，每个登录链接旁都有打开图标与复制图标。
- 单账号可配置：独立的出站代理、设备（机器）ID、锁定的 Kiro Profile、模型列表刷新、连接测试，以及真实的 Kiro 超额用量开关。
- 可选超额用量：账号的 Credits 用尽后仍继续处理请求。
- 单账号导入导出与批量操作。

### 🛡 管理面板

- React 单页应用内嵌于二进制文件，无需另行部署 Web 服务。
- 实时更新的概览仪表盘：四张 KPI 卡片（账号、套餐 Credits，以及最近一小时的请求与失败），以堆叠柱状图展示最近 1 小时、6 小时、24 小时或全部时间的流量趋势，需要处理的账号列表，各账号流量，模型分布环形图，以及最活跃的账号。「**套餐 Credits**」卡片把 Kiro Credits 用量分为经由本代理使用的部分与在代理之外使用的部分。
- 账号页支持带计数的状态标签页、筛选（套餐、认证、区域、启用、标签）、按邮箱、昵称、备注与标签搜索、排序、批量操作、详情视图、连接测试、实时的每分钟请求数与今日请求数、重复账号检查与导出。
- 请求日志支持带计数的状态标签页、搜索（也会匹配完整的 API Key）、排序、含错误分类的详情视图、追踪 ID 与每次上游尝试的时间线（账号、端点、耗时、结果、故障转移）、脱敏 API Key，以及基于 SQLite 的历史记录。 请求详情可打开所属对话（按顺序列出各轮、每轮所用账号、故障转移和合计），并把日志筛选到该对话；「**重放**」可用你选择的账号和模型再次运行一条已记录的请求（参见 [对话与重放](#-对话与重放)）。
- 接口页管理客户端 API Key（可自定义 Key 值、启用/禁用、按 Key 设置 Token、Credits 与调用次数限额、每分钟请求数、过期时间、允许的模型、按账号或标签绑定账号、按 Key 设置路由模式、重新生成、重置用量），提供「**各 API Key 用量**」图表，以及语法高亮的接入示例生成器：为 Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses 接口生成 curl、Python、Node.js、Go、Java、PHP、Ruby 与 C# 请求代码（官方 SDK 或纯 HTTP，可选流式）及示例响应，另含 Claude Code 与 Codex 配置。
- 设置页涵盖用量与后台刷新、账号路由（路由模式、会话亲和、单账号限额）、自动续写、工具历史、图片缩放、自动恢复、Thinking、模型映射、System Prompt 过滤、流完整性、Kiro 端点、上游域名与区域、出站代理、代理池、响应头、告警、服务器日志、管理员密码、两步验证登录、Prometheus 指标、日志保留与重置统计；备份页支持定时备份、上传与一键恢复。
- Credits 不足、账号被封禁或没有账号可处理请求时，通过 Webhook、Telegram、Discord 或 Slack 发送告警，并可选每日用量摘要（见[告警](#-告警)）。
- 命令菜单（<kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd>）可快速打开页面和执行操作；隐私模式可隐藏邮箱地址；支持读取仓库 `main` 分支上的 `version.json` 检查更新。
- 修改管理员密码会结束其他所有已登录的会话。
- 支持用身份验证器应用进行两步验证登录，并提供 10 个一次性恢复码（参见 [两步验证登录](#-两步验证登录)）。
- 浅色 / 深色 / 跟随系统主题；界面支持四种语言：English、简体中文、Tiếng Việt 与 Português (Brasil)。
- 从手机到桌面均可流畅使用。

### 🌐 网络

- 支持出站代理：SOCKS5、HTTP 或 HTTPS，热切换无需重启，并可按账号单独设置。已保存的代理密码显示为 `********`。
- 代理池：没有自有代理的账号各自从代理池分到一个代理，支持健康检查、每个代理单独的开关、连续三次失败后转到健康代理，并把全局代理和账号代理作为「检测到的代理」一并检查（参见 [代理池](#-代理池)）。
- 上游域名与区域（「**设置 → 上游域名与区域**」）：将对话与网络搜索发往 `runtime.{region}.kiro.dev`，而不是 `q.{region}.amazonaws.com`（用量与模型列表仍走 AWS）；还可为所有账号统一覆盖 API 区域（`us-east-1` 或 `eu-central-1`），或 Builder ID 与 IAM Identity Center 令牌的刷新区域。区域与账号不匹配时请求会失败，但账号不会因此被封禁。
- 思考模式后缀可配置，Anthropic `thinking` 配置直通透传。

### 🧩 存储

- 单文件 SQLite（`modernc.org/sqlite`）数据库 `kiro.db`，使用 DELETE journal 模式。
- 最终请求行，加上日志保留删除记录前汇总的数据，是仪表盘请求数、Token、Credit、成功数与失败数的统计来源。
- 日志保留：超过 90 天（可设为 1 至 365 天，设为 0 则永久保留）的请求与错误日志会分小批删除，服务启动两分钟后执行一次，之后每天一次。
- 已存响应保留 30 天，写盘异步进行，不阻塞请求主路径。
- 为重放保存请求内容 30 天：每条最多 2 MiB，压缩存储，客户端 API Key 已打码，总量最多 256 MiB（最旧的先删）。

---

## ⚙️ 环境要求

| 组件   | 版本                 |
| ------ | -------------------- |
| Go     | 1.25+                |
| Node.js | 22+ 及 pnpm（仅从源码构建管理面板时需要） |
| 操作系统 | Linux / macOS / Windows |
| 容器   | Docker 24+（可选）   |
| 存储   | 本地磁盘卷           |

---

## 🚀 快速开始

### 🐳 Docker Compose（推荐）

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

### 📦 下载预编译二进制

每个 [Release](https://github.com/tanu360/kiro-reverse-api/releases) 都附带可直接运行的 Linux、macOS 和 Windows 二进制文件（x64 与 arm64），已内置管理面板，无需安装 Go、Node.js 或 Docker。

```bash
# 将 linux-x64 换成你的平台：linux-arm64、macos-apple-silicon 或 macos-intel
curl -LO https://github.com/tanu360/kiro-reverse-api/releases/latest/download/kiro-proxy-linux-x64.tar.gz
tar -xzf kiro-proxy-linux-x64.tar.gz
cd kiro-proxy-linux-x64
./kiro-proxy
```

Windows 用户请下载 `kiro-proxy-windows-x64.zip`（或 `kiro-proxy-windows-arm64.zip`），解压后在终端中运行 `kiro-proxy.exe`。数据库默认创建在当前目录，可通过 `DATA_DIR` 存放到其他位置。服务监听 `127.0.0.1:8080`：8080 端口被占用时设置 `PORT`，需要接受其他机器连接时设置 `LISTEN_HOST=0.0.0.0`。Release 中的 `SHA256SUMS.txt` 列出了每个压缩包的校验值，可用 `sha256sum -c SHA256SUMS.txt --ignore-missing` 校验下载的文件（macOS：`shasum -a 256 -c SHA256SUMS.txt --ignore-missing`）。二进制文件未签名：如果 macOS 阻止运行，请执行 `xattr -d com.apple.quarantine kiro-proxy`；Windows SmartScreen 可能在首次运行前要求确认。

### 🛠 源码编译

```bash
git clone https://github.com/tanu360/kiro-reverse-api.git
cd kiro-reverse-api
cd ui && pnpm install && pnpm build && cd ..
go build -o kiro-proxy .
./kiro-proxy
```

构建管理面板需要 Node.js 22+ 与 pnpm。`go build` 会内嵌 `ui/dist` 中的内容：未构建 UI 时，`/` 会显示 "UI not built" 页面，API 仍可正常使用。Docker 镜像会同时构建两者。

### 🎨 管理面板开发

以下命令在 `ui/` 目录下运行：

| 命令            | 说明                                                                            |
| --------------- | ------------------------------------------------------------------------------- |
| `pnpm dev`      | 开发服务器，地址 `http://localhost:5173/admin/`；将 `/admin/api` 与 `/v1` 代理到 `127.0.0.1:8080` |
| `pnpm dev:mock` | 使用模拟数据的开发服务器，无需后端；登录密码 `12345678`                          |
| `pnpm test`     | 单元与组件测试（Vitest）                                                        |
| `pnpm test:e2e` | 基于模拟模式的浏览器冒烟测试（Playwright）                                      |

> [!TIP]
> 首次运行会自动创建 `kiro.db`。可通过 `DATA_DIR` 指定存储目录；Docker 使用 `/app/state`。通过 `ADMIN_PASSWORD` 设置管理密码；未设置时，首次启动会生成并保存 8 位随机数字密码，在启动日志中显示一次，并在登录页面显示至首次成功登录。Docker 用户可运行 `docker compose logs kiro-proxy` 查看。重启后保留已保存的密码。旧版本生成且尚未用于登录的 48 字符密码会一次性替换为 8 位数字密码；已用于登录或显式设置的密码保持不变。

---

请求体上限为 32 MiB，传输时与每一层解压后均受此限制。最多接受三层编码。超出上限的请求返回 HTTP 413。同一时间最多解压八个压缩请求体；其余压缩请求排队等待，未压缩的请求从不等待。读取请求体的时限为 30 秒。

管理员密码验证允许每个客户端每分钟失败五次，登录与 `X-Admin-Password` 请求合并计数；一个 IPv4 地址或一个 IPv6 /64 网段算作一个客户端。若所有客户端在一分钟内累计失败 30 次，则在该分钟剩余时间内每个客户端降为每分钟一次尝试，以减缓分布式猜测，同时不会把任何人锁在门外。超出限制的尝试返回 HTTP 429 并附带 `Retry-After`；已有的会话令牌继续有效。代理不信任转发的 IP 头，因此位于同一反向代理之后的客户端共享该代理 IP 的额度。密码验证成功不消耗失败额度。恢复备份时会保留当前生效的 `ADMIN_PASSWORD` 覆盖设置。

## 🔧 配置

| 变量             | 用途                                | 默认值             |
| ---------------- | ----------------------------------- | ------------------ |
| `DATA_DIR`        | `kiro.db` 所在目录                  | `.`                |
| `ADMIN_PASSWORD` | 管理面板密码（覆盖配置文件）        | —                  |
| `LISTEN_HOST`    | 监听地址。默认只接受本机连接；设为 `0.0.0.0` 可接受其他机器连接。Docker 镜像已设为 `0.0.0.0` | `127.0.0.1` |
| `PORT`           | 监听端口，1–65535（覆盖配置文件）。无效值会被忽略，并在启动时给出警告。Docker 中请改端口映射的宿主机一侧 | `8080` |
| `KIRO_TOOL_MARKUP_RESCUE` | 设为 `off` 时，不再把 Kiro 混入回复文本的工具调用标记还原为工具调用 | 开启 |
| `LOG_LEVEL`      | 日志级别：`debug`、`info`、`warn` 或 `error`（覆盖配置文件） | `info` |
| `ADMIN_RESET_2FA` | 设为 `1` 时，启动时关闭管理员两步验证登录，用于应用和恢复码都丢失的情况。用完请移除：设置期间每次启动都会再次关闭 | — |

> [!WARNING]
> `kiro.db` 包含 OAuth 令牌与管理员凭证。请按敏感信息处理，切勿提交到 git、截图或聊天记录中。数据库目录请挂载为私有卷。

---

## 🕹 使用方法

打开 `http://localhost:8080`，登录后添加账号即可调用 API：

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
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"Hello!"}]}'

# OpenAI — Responses
curl http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any" \
  -d '{"model":"claude-sonnet-4.5","input":"Hello!"}'
```

免费账号会对 Claude Code 默认的 `claude-*-5-5` 模型返回 404，因此请把 `ANTHROPIC_MODEL` 和 `ANTHROPIC_DEFAULT_*_MODEL` 变量设为你的账号可用的模型，例如 `claude-sonnet-4.5`。

使用 Codex 时，请把 `/v1/codex/models` 保存为文件，并在 `~/.codex/config.toml` 中把 `model_catalog_json` 设为该文件的路径；否则 Codex 没有 `apply_patch` 工具。

### 📌 端点速查

| 方法     | 路径                            | 说明                                          |
| -------- | ------------------------------- | --------------------------------------------- |
| `POST`   | `/v1/messages`                  | Anthropic 协议的 Claude 补全                  |
| `POST`   | `/v1/messages/count_tokens`     | Anthropic 协议的 Token 计数                   |
| `POST`   | `/v1/chat/completions`          | OpenAI 协议的对话补全                         |
| `POST`   | `/v1/responses`                 | OpenAI Responses 接口（支持存储与链式调用）   |
| `GET`    | `/v1/responses/{id}`            | 读取已存储的响应                              |
| `DELETE` | `/v1/responses/{id}`            | 删除已存储的响应                              |
| `GET`    | `/v1/models`                    | 列出可用模型                                  |
| `GET`    | `/v1/codex/models`              | Codex CLI 格式的模型列表                      |
| `GET`    | `/v1/stats`                     | 代理使用聚合统计                              |
| `GET`    | `/metrics`                      | Prometheus 指标，默认关闭，需 Bearer Token（参见 [Prometheus 指标](#-prometheus-指标)） |
| `GET`    | `/health`                       | 健康检查                                      |
| `GET`    | `/`                             | Web 管理面板（内嵌 SPA；`/accounts` 等页面链接直接打开应用，旧的 `/admin/*` 链接会重定向，不请求 HTML 的客户端得到健康检查） |

---

## 🔑 托管 API Key

可在「**接口**」页面（「**API 访问 → 要求 API Key**」）中要求客户端使用 API Key。可以创建多个客户端 Key，每个 Key 单独设置限额：

- **自定义 API Key（可选）** 留空时自动生成安全的 `sk-...` Key；也可以手动输入自己的 Key 值。
- 列表与请求日志中会显示脱敏格式，例如 `sk-clb****e4yo`；完整 Key 仍会保存，用于鉴权，并可在 Key 详情中复制。
- Token 与 Credit 限额检查使用原始精确数值；界面上四舍五入或紧凑格式的标签仅用于显示。
- Token、Credit 或调用次数限额为 `0` 表示该维度不限制。
- **调用次数限额**只统计成功的调用；失败的请求、`/v1/models` 与 `count_tokens` 不计入。次数用完的 Key 会收到 HTTP 429，直到你提高限额或重置用量。
- 在「**账号 → 仅限所选账号**」中可将 Key 绑定到部分账号，可逐个选择，也可按标签选择：带有该 Key 任一标签的账号都会加入，之后才打上标签的账号也一样。该 Key 的请求只使用这些账号，绝不会转到其他账号（这些账号都不可用时返回 HTTP 503；Key 的标签没有匹配到任何账号时，错误信息会单独说明），其模型列表也只显示这些账号支持的模型。
- 「**路由模式**」可为 Key 在其账号范围内单独设置路由模式（加权、优先级或先重置先用），或跟随「**设置**」。冷却、封禁、模型检查与单账号限额照常生效。拥有自己账号范围或路由模式的 Key 会单独记录会话绑定，其他 Key 发送同一会话时不会把它挪走。
- 「**每分钟请求数**」限制 Key 在滑动的一分钟内可发起的请求数（`0` 表示不限）。每个发往 `/v1/messages`、`/v1/chat/completions` 与 `/v1/responses` 的请求都计入，失败的也算；`/v1/models` 与 `count_tokens` 不计入。超过上限时客户端收到 HTTP 429，`Retry-After` 为距离可再次发起请求的秒数，与单账号限额一致。
- 「**过期时间**」让 Key 在你按本地时间选定的时刻停止工作（以 Unix 时间保存）。此后其客户端收到 HTTP 401 `API key expired at … UTC`，正在流式输出的响应仍会完成，接口页将该 Key 显示为「**已过期**」。清空时间即可让 Key 恢复使用。
- 「**允许的模型**」把 Key 限制在部分模型上。检查的是请求经 Thinking 后缀与模型映射处理后实际使用的模型（不区分大小写），而不是客户端发送的名称：`claude-haiku-4-5`、`claude-haiku-4.5-thinking` 以及指向 `claude-haiku-4.5` 的映射都算作 `claude-haiku-4.5`，任何别名都无法访问列表之外的模型。其他模型返回 HTTP 403（Anthropic 接口为 `permission_error`，OpenAI 接口的 code 为 `model_not_allowed`），`/v1/models` 也只列出允许的模型。
- 「**重新生成 API Key**」会为 Key 生成新值，旧值立即失效；名称、限额、绑定的账号与用量保持不变。
- 「**各 API Key 用量**」以图表展示每个 Key 在 24 小时、7 天、30 天或全部时间内的请求数、Token 与 Credits，区分成功与失败，并单独列出无 API Key、无效 API Key 与已删除 API Key 的请求。

---

## 📊 统计口径

「概览」页面与「账号」页面回答的是不同问题：

- **账号卡片**：当前配置的 Kiro 账号，按状态分组（可用、需处理、已封禁、已禁用）。
- **套餐 Credits 卡片**：本月 Kiro 服务器返回的配额字段，按所有账号汇总（`usage_current / usage_limit`）。进度条把已用 Credits 分为「**代理**」（经由本代理发出的请求所用的 Credits）与「**代理外**」（其余部分），并显示「**剩余**」。
- **请求 / 失败卡片**：最近一小时内完成的代理请求，并与前一小时对比。
- **账号页**：每个账号记录上保存的计数器（`requestCount`、`totalTokens`、`totalCredits`）。
- **日志保留**：旧记录删除前，其总量会先汇总保存，因此「**套餐 Credits**」卡片、模型分布与 `/v1/stats` 仍会计入它们；被删除的每一天还会保留当天的汇总，因此「各 API Key 用量」与概览的流量图在 7 天、30 天和全部时间范围中仍会显示这些日子；请求页只显示保留下来的记录。

如果旧账号或已删除账号在 `requests` 表中仍有历史行，它们的 Credits 仍会计入「**代理**」。此时「**代理**」可能偏高，「**代理外**」可能偏低。需要清空历史请求行时，可使用「**设置 → 危险操作 → 重置统计**」或进行一次性数据库清理。

Token 标签可能显示为紧凑格式（如 `54.5M`、`476.5K`），但后端计算与限额检查始终使用原始数值。

---

## 🧠 思考模式

在模型名后追加后缀（默认 `-thinking`）即可启用推理，例如 `claude-sonnet-4.5-thinking`。

Claude 兼容请求如果带有顶层 `thinking` 配置，也会自动启用：

```json
{ "type": "enabled", "budget_tokens": 2048 }
{ "type": "adaptive" }
```

OpenAI `reasoning_effort` 与 Claude `output_config.effort` 同样可用：`low`、`medium`、`high` 或 `xhigh` 会开启思考，并传递给支持强度等级的模型；`minimal` 则关闭思考。

在 `/v1/messages` 中使用默认的思考块输出格式时，思考块会携带 Kiro 返回的 `signature`（流式输出时为 `signature_delta`），`redacted_thinking` 块原样透传。Kiro 并不总会返回这两者。开启思考时，客户端回传的思考块会以文本形式重放给 Kiro，哪些轮次保留思考遵循 Anthropic 的规则；其中的签名与 `redacted_thinking` 块会被丢弃。

输出格式可在管理面板「**设置 → Thinking**」中配置。

---

## 🧾 结构化输出

Kiro 没有 JSON 模式，因此代理会要求模型输出 JSON，去掉代码块围栏，按 Schema 校验回答；不匹配时在同一账号上重试一次。

| 接口             | 字段                                                           |
| ---------------- | -------------------------------------------------------------- |
| Chat Completions | `response_format`：`json_object` 或 `json_schema`              |
| Messages         | `output_config.format`（或 `output_format`）：`json_schema`    |
| Responses        | `text.format`：`json_object` 或 `json_schema`                  |

在 Chat 与 Messages 中，推理内容不会混入回答，而是以 `reasoning_content` 或思考块返回。Schema 最大 32 KiB，不支持的格式类型返回 HTTP 400。`count_tokens` 会计入代理追加的 JSON 指令。

---

## 🛰 出站代理

如果你的网络受限，可在管理面板「**设置 → 出站代理**」中配置出站代理。

| 类型     | 示例                          |
| -------- | ----------------------------- |
| SOCKS5   | `socks5://127.0.0.1:1080`     |
| HTTP     | `http://127.0.0.1:8888`       |
| HTTPS    | `https://proxy.example.com:443` |

> [!TIP]
> 设置保存后即时生效，无需重启服务。单个账号也可以使用独立代理（账号详情 → **账号代理**）；留空则使用全局代理。已保存的密码显示为 `********`，原样保存该脱敏值会保留原密码。

账号的独立代理与全局代理有 15 秒的连接时限；连接失败时，请求会立即转到另一个账号。如果请求因为没有收到 Kiro 的应答而失败（代理故障，或无法连接 Kiro、Kiro 未按时应答），客户端会收到 HTTP 503 与固定文本：`outbound proxy failed: <reason>`（例如 `proxy refused the tunnel` 或 `connection timed out`）、`upstream connection failed` 或 `upstream request timed out`。这些文本不会包含上游 URL 或代理地址；服务器日志与请求日志保留完整错误。连接失败永远不会导致账号被封禁，只会计入短暂的错误冷却。

### 🔁 代理池

「**设置 → 代理池**」把没有自有代理的账号分配到最多 100 个代理（`http`、`https`、`socks5` 或 `socks5h`）。每个账号会一直使用分到的代理，新账号会分到账号最少的健康代理。健康检查通过每个代理连接 Kiro 自己的主机，默认每 10 分钟一次；刷新 Token 与该账号的请求走同一条路线。

- **三次机会。** 只有连续三次检查或连接失败后，代理才会退出轮换，它的账号转到健康代理；一次成功即清零计数。请求在代理上失败时仍会立即换一条路线重试：只有该账号转到另一个健康代理，代理记一次失败。自动停用的代理在检查通过后立即恢复。代理失败绝不会封禁账号或让账号冷却。
- **开关。** 每个代理都有自己的开关。关闭的代理不会被使用或检查，它的账号立即转走，检查也不会把它重新打开。
- **检测到的代理。** 全局出站代理和账号自有代理作为「检测到的代理」显示，像池内代理一样接受检查并统计失败次数。它们绝不共享给其他账号：不带登录信息的代理只有在你点击「**加入代理池**」后才会加入，带登录信息的代理不能加入。
- 卡片统计健康、异常（失败中但仍在轮换）、已自动禁用和已关闭的代理数量。

优先顺序依次为：账号自有代理、代理池、全局代理、直连。没有健康的池内代理时，请求返回 HTTP 503 `no healthy outbound proxy in the pool`；若开启了「**没有健康代理时回退**」，则改走全局代理，未设置全局代理时直连。

---

## 🔐 两步验证登录

「**设置 → 两步验证登录**」在输入管理员密码后，还要求输入身份验证器应用（Google Authenticator、1Password、Aegis 等）中的 6 位验证码。

- 「**开启**」会显示二维码和文本形式的密钥。用应用中的验证码确认后，会一次性显示 10 个恢复码，请妥善保存。开启后会结束其他所有已登录的会话。
- 之后登录时，输入密码后还需输入验证码；恢复码可代替验证码使用一次。验证码遵循 RFC 6238（SHA-1，30 秒），允许前后各一个时间步的时钟误差，每个验证码只能用一次。错误的验证码与错误的密码计入同一个尝试次数限制。
- 「**关闭**」需要当前验证码或管理员密码。「**生成新恢复码**」会替换旧的恢复码。
- 开启期间，用 `X-Admin-Password` 发送密码的脚本会收到 HTTP 401 `totp_required`：请用 `POST /admin/api/session` 和 `{"password": "…", "code": "123456"}` 登录，再用 `X-Admin-Token` 发送 Token。
- 被锁在外面？用 `ADMIN_RESET_2FA=1` 启动一次服务器即可关闭两步验证并记录一条警告；用密码登录后请移除该变量。`ADMIN_PASSWORD` 和首次运行密码照常可用。

密钥和管理员密码一样保存在 `kiro.db` 中；恢复码只保存 SHA-256 哈希。两者都不会写入日志。

---

## 📈 Prometheus 指标

「**设置 → Prometheus 指标**」以 Prometheus 文本格式提供 `GET /metrics`。默认关闭；开启时会生成一个 Bearer Token，卡片中显示该 Token 和现成的 `prometheus.yml` 抓取配置。没有 Token 时返回 401，关闭时返回 404。「**生成新 Token**」会立即替换 Token。

| 指标 | 类型 | 标签 |
| ---- | ---- | ---- |
| `kiro_requests_total` | counter | `outcome`、`status`、`model`、`account`、`api_key` |
| `kiro_tokens_total` | counter | `kind`（input、output、cache_read、cache_write）、`model`、`account`、`api_key` |
| `kiro_credits_total` | counter | `model`、`account`、`api_key` |
| `kiro_request_duration_seconds` | histogram | `endpoint`、`outcome` |
| `kiro_upstream_errors_total` | counter | `category`（请求日志的错误类型）、`account` |
| `kiro_account_state`、`kiro_accounts` | gauge | `account`、`state`（active、cooldown、over_limit、banned、disabled） |
| `kiro_account_usage_ratio` | gauge | `account` |
| `kiro_proxy_state`、`kiro_proxy_failures`、`kiro_proxy_latency_seconds`、`kiro_proxies` | gauge | `proxy`、`kind`（pool、detected）、`state` |
| `kiro_build_info`、`kiro_uptime_seconds` | gauge | `version` |

`account` 是账号的邮箱，`api_key` 是客户端 API Key 的 ID（绝不是 Key 本身）。计数器在服务器启动时从零开始。

---

## 🧵 对话与重放

每个已路由的请求都带有所属对话：即会话亲和键，同一段对话的每一轮都相同。请求详情中的「**对话**」按顺序列出各轮、每轮所用账号和模型、故障转移，以及 Token、额度和耗时的合计。「**在日志中查看**」会把请求页筛选到该对话。

「**重放**」用你选择的账号和模型再次运行一条已记录的请求（不使用流式输出），并显示回答。重放会作为标记为重放的新请求记录，并消耗该账号的额度。重放需要请求内容：服务器保存请求内容 30 天，每条最多 2 MiB，总量最多 256 MiB，客户端 API Key 已打码。仅限管理员使用。

---

## 🔔 告警

「**设置 → 告警**」会在以下情况向 Webhook、Telegram、Discord 或 Slack 渠道（最多 20 个）发送消息：

- 某个账号的 Credits 用量越过阈值（默认 80、90 与 100 %）：每个阈值只发一次，Credits 重置后重新计算；
- 所有已启用且未被封禁账号的总 Credits 用量越过阈值，两次告警之间至少间隔冷却时间（默认 60 分钟）；
- 账号被封禁：Kiro 封停了该账号，或其登录失效。每次封禁只告警一次：账号经自动恢复或「**重新登录**」解除封禁后，如果期间没有成功处理任何请求、又因同一原因被封禁，不会再次告警；
- 连续一分钟没有任何已启用的账号能处理请求；
- 每天一次的「**每日用量摘要**」：此前 24 小时的请求数、失败数、Credits 与 Token 用量，最忙的三个账号与三个 Key，以及需要关注的账号（被封禁、Credits 用尽，或会在 Credits 重置前用尽）。

每日摘要默认关闭，需要手动开启。发送时间按你的本地时间选择，服务器以 UTC 保存（默认 UTC 09:00），因此夏令时开始或结束时，按你的时间会前后移动一小时。服务器在发送时间宕机的话，会在重新启动后补发，最多晚 3 小时，同一天绝不会发送两次。摘要的「**发送测试**」会立即把最近 24 小时的摘要发送到所有已开启的渠道，不计为当天的摘要。

没有开启任何渠道时不做检查；「**发送测试**」会向渠道发送一次测试消息。告警经由全局出站代理发送，但发往本机或局域网接收端（`localhost`、不含点的主机名、以 `.localhost`、`.local`、`.lan`、`.internal` 或 `.home.arpa` 结尾的主机名，或者回环、私有、链路本地 IP 地址）的告警会直连。Webhook 收到的是 JSON POST，包含 `event`、`severity`、`title`、`text`、`data` 与 `ts`，并带有 `X-Kiro-Proxy-Event` 请求头。设置签名密钥后，`X-Kiro-Proxy-Signature: sha256=<hex>` 携带请求体的 HMAC-SHA256。已保存的 URL、令牌与密钥不会再次显示。

---

## 🔐 环境变量

| 变量             | 说明                                  | 默认值             |
| ---------------- | ------------------------------------- | ------------------ |
| `DATA_DIR`        | `kiro.db` 所在目录                    | `.`                |
| `ADMIN_PASSWORD` | 管理面板密码（覆盖配置文件）          | —                  |
| `LISTEN_HOST`    | 监听地址。默认只接受本机连接；设为 `0.0.0.0` 可接受其他机器连接。Docker 镜像已设为 `0.0.0.0` | `127.0.0.1` |
| `PORT`           | 监听端口，1–65535（覆盖配置文件）。无效值会被忽略，并在启动时给出警告。Docker 中请改端口映射的宿主机一侧 | `8080` |
| `KIRO_TOOL_MARKUP_RESCUE` | 设为 `off` 时，不再把 Kiro 混入回复文本的工具调用标记还原为工具调用 | 开启 |
| `LOG_LEVEL`      | 日志级别：`debug`、`info`、`warn` 或 `error`（覆盖配置文件） | `info` |
| `ADMIN_RESET_2FA` | 设为 `1` 时，启动时关闭管理员两步验证登录，用于应用和恢复码都丢失的情况。用完请移除：设置期间每次启动都会再次关闭 | — |

```diff
+ kiro.db                # local state — config, credentials, SQLite history, backup blobs
```

> [!CAUTION]
> `kiro.db` 是敏感文件，账号令牌与管理员凭证以明文形式落盘存储，请严加保护。

---

## 🙏 项目致谢

本项目是 [Quorinex/Kiro-Go](https://github.com/Quorinex/Kiro-Go) 的延续。原始项目的贡献与功劳归原作者所有；我在此基础上继续维护和推进。

管理面板基于以下开源项目：[Studio Admin](https://github.com/arhamkhnz/next-shadcn-admin-dashboard)、[t3code](https://github.com/pingdotgg/t3code)、[coss ui](https://github.com/cosscom/ui)、[Bklit UI](https://github.com/bklit/bklit-ui) 与 [openstatus data-table-filters](https://github.com/openstatusHQ/data-table-filters)。许可证详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

## 🛡 安全须知

- ✅ 仅用于你**有权限**操作的账号。
- ❌ **不得**用于批量账号爬取或绕过服务条款。
- ❌ **不得**叠加 CAPTCHA 绕过、身份伪造、限流绕过等行为。
- 🔐 `kiro.db` 切勿出现在 git、公开备份与截图中。
- 🧯 若上游持续返回鉴权错误，代理会快速失败，请先排查再重试。

> [!IMPORTANT]
> 本项目仅供学习与研究使用，与 Amazon、AWS 或 Kiro 无关联。用户需自行确保符合相关服务条款与法律法规，使用风险自负。

---

## 📄 开源许可

[MIT](./LICENSE)

---

<div align="center">
<sub>用 ❤️ 与 Go 构建 · 如果项目帮你省了时间，请回仓库点个 ⭐</sub>
</div>
