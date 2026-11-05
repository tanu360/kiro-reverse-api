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

[English](README.md) • [中文](README_CN.md)

</div>

---

## 🌟 概览

**Kiro Proxy** 是一个轻量级 Go 服务，将一个或多个已授权的 **Kiro** 账号转换为本地 API 端点，支持 **OpenAI** 和 **Anthropic** 协议格式：

1. 多账号池化，按轮询方式分发请求。
2. 在 Anthropic `/v1/messages`、OpenAI `/v1/chat/completions` 与 OpenAI `/v1/responses` 与 Kiro 上游之间双向翻译。
3. 自动刷新访问令牌，端到端转发 Server-Sent Events 流。
4. 自带内嵌于二进制文件的 React 管理面板，提供账号管理、可观测性与请求审计，界面支持 English、简体中文、Tiếng Việt 与 Português (Brasil)。

> [!IMPORTANT]
> 单二进制本地代理。**非**托管服务，**不**隶属于 Amazon、AWS 或 Kiro。账号必须由你本人持有或经过合法授权方可加入账号池。

如果项目对你有帮助，欢迎点个 Star 鼓励一下。

---

## 🖼 界面预览

<table>
  <tr>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/login-dark.webp">
        <img alt="登录" src="screenshots/login-light.webp" width="100%">
      </picture>
      <br><sub><b>登录</b> — 登录页可切换主题与界面语言</sub>
    </td>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/overview-dark.webp">
        <img alt="概览" src="screenshots/overview-light.webp" width="100%">
      </picture>
      <br><sub><b>概览</b> — 各账号的实时流量、Credits 与错误</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/accounts-dark.webp">
        <img alt="账号" src="screenshots/accounts-light.webp" width="100%">
      </picture>
      <br><sub><b>账号</b> — 套餐 Credits、状态筛选、批量操作与导出</sub>
    </td>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/requests-dark.webp">
        <img alt="请求" src="screenshots/requests-light.webp" width="100%">
      </picture>
      <br><sub><b>请求</b> — 搜索、状态筛选、排序与详情视图</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/api-dark.webp">
        <img alt="接口" src="screenshots/api-light.webp" width="100%">
      </picture>
      <br><sub><b>接口</b> — API 访问控制、带限额的客户端 Key 与接入配置</sub>
    </td>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/backups-dark.webp">
        <img alt="备份" src="screenshots/backups-light.webp" width="100%">
      </picture>
      <br><sub><b>备份</b> — 手动与定时备份、一键恢复</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/proxy-dark.webp">
        <img alt="出站代理" src="screenshots/proxy-light.webp" width="100%">
      </picture>
      <br><sub><b>出站代理</b> — SOCKS5 或 HTTP，无需重启即生效</sub>
    </td>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/settings-dark.webp">
        <img alt="设置" src="screenshots/settings-light.webp" width="100%">
      </picture>
      <br><sub><b>设置</b> — 用量、账号路由、自动续写、思考、模型映射</sub>
    </td>
  </tr>
</table>

---

## ✨ 功能特性

### 🛰 API 接口

- Anthropic `/v1/messages`，原生工具调用与流式输出。
- OpenAI `/v1/chat/completions`，工具调用结构完全对齐。
- OpenAI `/v1/responses`，支持 `previous_response_id` 链式调用与已存响应回查。
- 全部端点支持 SSE 流式输出，上游瞬时错误时可在流中切换账号继续。
- 支持请求体解压（gzip / deflate），方便预压缩负载的客户端接入。

### 👥 账号池

- 多个 Kiro 账号按模型粒度轮询。
- OAuth 令牌过期前自动刷新。
- 支持多种鉴权方式：AWS Builder ID、IAM Identity Center（企业 SSO）、SSO Token、本地缓存、凭证 JSON。
- 单账号导入导出与批量操作。

### 🛡 管理面板

- React 单页应用内嵌于二进制文件，无需另行部署 Web 服务。
- 概览仪表盘带图表：流量趋势、模型分布与按账号的热力图；统计卡片区分 Kiro 账号的 Credits 用量与本代理产生的请求用量。
- 账号页支持批量操作、详情、连接测试与导出。
- 请求日志支持搜索、状态/API Key 筛选、排序、详情视图、脱敏 API Key，SQLite 持久化存档。
- 接口页管理客户端 API Key（可自定义 Key 值、启用/禁用、独立 Token/Credits 限额、重置用量），并提供 curl、Claude Code、Codex 与 OpenAI SDK 的接入示例。
- 设置页涵盖思考、模型映射、出站代理等；备份页支持定时备份与一键恢复。
- 浅色 / 深色 / 跟随系统主题；界面支持四种语言：English、简体中文、Tiếng Việt 与 Português (Brasil)。
- 从手机到桌面均可流畅使用。

### 🌐 网络

- 出站代理支持 SOCKS5 与 HTTP，热切换无需重启。
- 思考模式后缀可配置，Anthropic `thinking` 配置直通透传。

### 🧩 存储

- 单文件 SQLite（`modernc.org/sqlite`）数据库 `kiro.db`，使用 DELETE journal 模式。
- 最终请求行是仪表盘请求数、Token、Credit、成功数与失败数的统计来源。
- 已存响应保留 30 天，写盘异步进行，不阻塞请求主路径。

---

## ⚙️ 环境要求

| 组件   | 版本                 |
| ------ | -------------------- |
| Go     | 1.25+                |
| Node.js | 22+ 及 pnpm（仅从源码构建管理面板时需要） |
| 操作系统 | Linux / macOS        |
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

### 🛠 源码编译

```bash
git clone https://github.com/tanu360/kiro-reverse-api.git
cd kiro-reverse-api
cd ui && pnpm install && pnpm build && cd ..
go build -o kiro-proxy .
./kiro-proxy
```

构建管理面板需要 Node.js 22+ 与 pnpm。`go build` 会内嵌 `ui/dist` 中的内容：未构建 UI 时，`/admin` 会显示 "UI not built" 页面，API 仍可正常使用。Docker 镜像会同时构建两者。

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

## 🔧 配置

| 变量             | 用途                                | 默认值             |
| ---------------- | ----------------------------------- | ------------------ |
| `DATA_DIR`        | `kiro.db` 所在目录                  | `.`                |
| `ADMIN_PASSWORD` | 管理面板密码（覆盖配置文件）        | —                  |
| `LISTEN_HOST`    | 监听地址。默认只接受本机连接；设为 `0.0.0.0` 可接受其他机器连接。Docker 镜像已设为 `0.0.0.0` | `127.0.0.1` |
| `KIRO_TOOL_MARKUP_RESCUE` | 设为 `off` 时，不再把 Kiro 混入回复文本的工具调用标记还原为工具调用 | 开启 |

> [!WARNING]
> `kiro.db` 包含 OAuth 令牌与管理员凭证。请按敏感信息处理，切勿提交到 git、截图或聊天记录中。数据库目录请挂载为私有卷。

---

## 🕹 使用方法

打开 `http://localhost:8080/admin`，登录后添加账号即可调用 API：

```bash
# Anthropic — Claude
curl http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4.5","max_tokens":1024,"messages":[{"role":"user","content":"你好！"}]}'

# OpenAI — Chat Completions
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好！"}]}'

# OpenAI — Responses
curl http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any" \
  -d '{"model":"gpt-4o","input":"你好！"}'
```

### 📌 端点速查

| 方法     | 路径                            | 说明                                          |
| -------- | ------------------------------- | --------------------------------------------- |
| `POST`   | `/v1/messages`                  | Anthropic 协议的 Claude 补全                  |
| `POST`   | `/v1/chat/completions`          | OpenAI 协议的对话补全                         |
| `POST`   | `/v1/responses`                 | OpenAI Responses 接口（支持存储与链式调用）   |
| `GET`    | `/v1/responses/{id}`            | 读取已存储的响应                              |
| `DELETE` | `/v1/responses/{id}`            | 删除已存储的响应                              |
| `GET`    | `/v1/models`                    | 列出可用模型                                  |
| `GET`    | `/v1/stats`                     | 代理使用聚合统计                              |
| `GET`    | `/admin`                        | Web 管理面板（内嵌 SPA；`/admin/*` 下的深层链接回退到该应用） |

---

## 🔑 托管 API Key

可在「**接口**」页面（「**API 访问 → 要求 API Key**」）中要求客户端使用 API Key。每个客户端 Key 都可以单独设置限额：

- **自定义 API Key（可选）** 留空时自动生成安全的 `sk-...` Key；也可以手动输入自己的 Key 值。
- 列表与请求日志中会显示脱敏格式，例如 `sk-clb****e4yo`；完整 Key 仍会用于鉴权，并可在详情中复制。
- Token 与 Credit 限额检查使用原始精确数值；界面上的四舍五入或 K/M/B 仅用于显示。
- Token 或 Credit 限额为 `0` 表示该维度不限制。

---

## 📊 统计口径

「概览」页面与「账号」页面回答的是不同问题：

- **账号卡片**：当前配置的 Kiro 账号，使用 Kiro 服务器返回的配额字段（`usage_current / usage_limit`）。
- **请求卡片**：本代理的 SQLite `requests` 历史：`COUNT(*)`、`SUM(total_tokens)`、`SUM(credits)`。
- **成功 / 失败卡片**：同一个 `requests` 表中的最终代理请求结果。
- **账号列表卡片**：当前可见账号记录里保存的计数器（`requestCount`、`totalTokens`、`totalCredits`）。

如果旧账号或已删除账号在 `requests` 表中仍有历史行，「概览」页的「代理 Credits」可能高于当前可见账号的 Credits 总和。需要清空历史时，可使用「**设置 → 危险操作 → 重置统计**」或进行一次性数据库清理。

Token 标签可能显示为紧凑格式（如 `54.5M`、`476.5K`），但后端计算与限额检查始终使用原始数值。

---

## 🧠 思考模式

在模型名后追加后缀（默认 `-thinking`）即可启用推理，例如 `claude-sonnet-4.5-thinking`。

Claude 兼容请求如果带有顶层 `thinking` 配置，也会自动启用：

```json
{ "type": "enabled", "budget_tokens": 2048 }
{ "type": "adaptive" }
```

输出格式可在管理面板「**设置 → Thinking**」中配置。

---

## 🛰 出站代理

如果你的网络受限，可在管理面板「**设置 → 出站代理**」中配置出站代理。

| 类型     | 示例                          |
| -------- | ----------------------------- |
| SOCKS5   | `socks5://127.0.0.1:1080`     |
| HTTP     | `http://127.0.0.1:8888`       |

> [!TIP]
> 设置保存后即时生效，无需重启服务。

---

## 🔐 环境变量

| 变量             | 说明                                  | 默认值             |
| ---------------- | ------------------------------------- | ------------------ |
| `DATA_DIR`        | `kiro.db` 所在目录                    | `.`                |
| `ADMIN_PASSWORD` | 管理面板密码（覆盖配置文件）          | —                  |
| `LISTEN_HOST`    | 监听地址。默认只接受本机连接；设为 `0.0.0.0` 可接受其他机器连接。Docker 镜像已设为 `0.0.0.0` | `127.0.0.1` |
| `KIRO_TOOL_MARKUP_RESCUE` | 设为 `off` 时，不再把 Kiro 混入回复文本的工具调用标记还原为工具调用 | 开启 |

```diff
+ kiro.db                # 本地状态：配置、凭据、SQLite 历史、备份 BLOB
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
