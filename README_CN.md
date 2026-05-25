<div align="center">

<img src="screenshots/logo.png" alt="Kiro Proxy" width="180" />

# Kiro Proxy

#### 本地代理，将 Kiro 账号转换为兼容 OpenAI / Anthropic 的接口。

<p>
  <a href="https://go.dev/"><img alt="Go" src="https://img.shields.io/badge/Go-1.25+-00ADD8?style=for-the-badge&logo=go&logoColor=white" /></a>
  <a href="https://www.docker.com/"><img alt="Docker" src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" /></a>
  <a href="https://www.sqlite.org/"><img alt="SQLite" src="https://img.shields.io/badge/SQLite-WAL-003B57?style=for-the-badge&logo=sqlite&logoColor=white" /></a>
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
  <a href="#-环境变量">环境变量</a> •
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
4. 自带精致的 Web 管理面板，提供账号管理、可观测性与请求审计。

> [!IMPORTANT]
> 单二进制本地代理。**非**托管服务，**不**隶属于 Amazon、AWS 或 Kiro。账号必须由你本人持有或经过合法授权方可加入账号池。

如果项目对你有帮助，欢迎点个 Star 鼓励一下。

---

## 🖼 界面预览

> 截图会根据你的 GitHub 主题自动切换浅色 / 深色版本。

<table>
  <tr>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/login-dark.webp">
        <img alt="登录" src="screenshots/login-light.webp" width="100%">
      </picture>
      <br><sub><b>🔐 登录</b> — 简洁、随主题切换</sub>
    </td>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/monitor-dark.webp">
        <img alt="实时监控" src="screenshots/monitor-light.webp" width="100%">
      </picture>
      <br><sub><b>📈 实时监控</b> — RPM、错误率、流量热力图</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/accounts-dark.webp">
        <img alt="账号池" src="screenshots/accounts-light.webp" width="100%">
      </picture>
      <br><sub><b>👥 账号池</b> — 多账号、轮询、自动刷新令牌</sub>
    </td>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/requests-dark.webp">
        <img alt="请求日志" src="screenshots/requests-light.webp" width="100%">
      </picture>
      <br><sub><b>📜 请求日志</b> — 分页搜索、状态筛选、完整审计</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/api-dark.webp">
        <img alt="API 测试台" src="screenshots/api-light.webp" width="100%">
      </picture>
      <br><sub><b>🛰 API 测试台</b> — 面板内直接调试接口</sub>
    </td>
    <td width="50%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/backups-dark.webp">
        <img alt="备份" src="screenshots/backups-light.webp" width="100%">
      </picture>
      <br><sub><b>💾 备份</b> — 快照、定时备份、一键恢复</sub>
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/settings-dark.webp">
        <img alt="设置" src="screenshots/settings-light.webp" width="70%">
      </picture>
      <br><sub><b>⚙️ 设置</b> — 思考模式、出站代理、主题、多语言</sub>
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

- 实时可观测性：RPM、错误率、模型分布、流量热力图。
- 请求日志支持分页搜索、状态筛选，SQLite 持久化存档。
- 内置 API 测试台，无需离开面板即可调试接口。
- 快照与定时备份，支持一键恢复。
- 主题感知 UI（浅色 / 深色 / 跟随系统），具备友好的缓存头。
- 内建 i18n：英文与简体中文同源同步。

### 🌐 网络

- 出站代理支持 SOCKS5 与 HTTP，热切换无需重启。
- 思考模式后缀可配置，Anthropic `thinking` 配置直通透传。

### 🧩 存储

- SQLite（`modernc.org/sqlite`）启用 WAL 模式，承载请求历史与已存响应。
- 已存响应保留 30 天，写盘异步进行，不阻塞请求主路径。

---

## ⚙️ 环境要求

| 组件   | 版本                 |
| ------ | -------------------- |
| Go     | 1.25+                |
| 操作系统 | Linux / macOS        |
| 容器   | Docker 24+（可选）   |
| 存储   | 本地磁盘卷           |

---

## 🚀 快速开始

### 🐳 Docker Compose（推荐）

```bash
git clone https://github.com/tanu360/kiro-reverse-api.git
cd kiro-reverse-api
mkdir -p data
docker-compose up -d
```

### 🐳 Docker Run

```bash
docker run -d \
  --name kiro-proxy \
  -p 8080:8080 \
  -e ADMIN_PASSWORD=your_secure_password \
  -v /path/to/data:/app/data \
  --restart unless-stopped \
  ghcr.io/tanu360/kiro-reverse-api:latest
```

### 🛠 源码编译

```bash
git clone https://github.com/tanu360/kiro-reverse-api.git
cd kiro-reverse-api
go build -o kiro-proxy .
./kiro-proxy
```

> [!TIP]
> 首次运行会自动在 `data/config.json` 生成配置，挂载 `/app/data` 以持久化。默认管理密码为 `changeme`，对外暴露前请通过 `ADMIN_PASSWORD` 环境变量或管理面板进行修改。

---

## 🔧 配置

| 变量             | 用途                                | 默认值             |
| ---------------- | ----------------------------------- | ------------------ |
| `CONFIG_PATH`    | 配置文件路径                        | `data/config.json` |
| `ADMIN_PASSWORD` | 管理面板密码（覆盖配置文件）        | —                  |

> [!WARNING]
> `data/config.json` 包含 OAuth 令牌与管理员凭证。请按敏感信息处理，切勿提交到 git、截图或聊天记录中。`data/` 目录请挂载为私有卷。

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
| `GET`    | `/admin`                        | Web 管理面板                                  |

---

## 🧠 思考模式

在模型名后追加后缀（默认 `-thinking`）即可启用推理，例如 `claude-sonnet-4.5-thinking`。

Claude 兼容请求如果带有顶层 `thinking` 配置，也会自动启用：

```json
{ "type": "enabled", "budget_tokens": 2048 }
{ "type": "adaptive" }
```

输出格式可在管理面板「**设置 → 思考模式**」中配置。

---

## 🛰 出站代理

如果你的网络受限，可在管理面板「**设置 → 出站代理设置**」中配置出站代理。

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
| `CONFIG_PATH`    | 配置文件路径                          | `data/config.json` |
| `ADMIN_PASSWORD` | 管理面板密码（覆盖配置文件）          | —                  |

```diff
+ data/                  # 本地状态：配置、SQLite、快照
- data/config.json       # 切勿提交到 git
```

> [!CAUTION]
> `data/config.json` 是敏感文件，账号令牌与管理员凭证以明文形式落盘存储，请严加保护。

---

## 🙏 项目致谢

本项目是 [Quorinex/Kiro-Go](https://github.com/Quorinex/Kiro-Go) 的延续。原始项目的贡献与功劳归原作者所有；我在此基础上继续维护和推进。

---

## 🛡 安全须知

- ✅ 仅用于你**有权限**操作的账号。
- ❌ **不得**用于批量账号爬取或绕过服务条款。
- ❌ **不得**叠加 CAPTCHA 绕过、身份伪造、限流绕过等行为。
- 🔐 `data/config.json` 切勿出现在 git、备份与截图中。
- 🧯 若上游持续返回鉴权错误，代理会快速失败，请先排查再重试。

> [!IMPORTANT]
> 本项目仅供学习与研究使用，与 Amazon、AWS 或 Kiro 无关联。用户需自行确保符合相关服务条款与法律法规，使用风险自负。

---

## 📄 开源许可

MIT。详见 [LICENSE](./LICENSE)。

---

<div align="center">
<sub>用 ❤️ 与 Go 构建 · 如果项目帮你省了时间，请回仓库点个 ⭐</sub>
</div>
