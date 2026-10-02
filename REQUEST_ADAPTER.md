# Kiro 请求转换层

本分支基于 tanu360/kiro-reverse-api 的 `532a90a78ba69f2a18cbb52d5458979f924f9d1d`。
对照 Kiro Account Manager 的 API 数据结构与转换流程，以 Go 重新实现统一请求构建器；服务不依赖 Electron、TypeScript 进程或客户端把文字移入系统提示的规避开关。

参考：[translator.ts](https://github.com/chaogei/Kiro-account-manager/blob/447adcdb468157312621b1f09448278bd9bca748/Kiro-account-manager/src/main/proxy/translator.ts)、[kiroApi.ts](https://github.com/chaogei/Kiro-account-manager/blob/447adcdb468157312621b1f09448278bd9bca748/Kiro-account-manager/src/main/proxy/kiroApi.ts)。参考实现自身也有历史和工具结果裁剪，本分支没有移植这些裁剪策略。

## 原因与结构

原来的转换器按序列化请求的 900KB 上限裁剪历史及当前消息，大图的 base64 就能耗尽预算，把有效文字改为 `.`。OpenAI 转换器还曾删除 `[Image N]` 标签并折叠空白。

现在 Claude、Chat Completions 和 Responses 都经过 `proxy/request_adapter.go` 的同一个负载构建器。协议适配器负责读取消息和参数，构建器负责形成 Kiro 会话格式。原有的字节预算、当前文字切片、历史裁剪和重复消息去重已删除；工具描述和作为文本承载的工具输出也没有截断上限。

完整文字、图片和文档分别作为 Kiro 的 content、images、documents 传递。历史工具调用因 Kiro 的限制需要转成上下文文本时，保留 ID、工具名、完整参数、结果和状态；当前匹配的工具调用与结果仍使用结构化格式。必要的角色交替通过插入协议确认消息完成。工具名称转换有反向映射，返回客户端时恢复名称。

## 参数与内容

| 输入 | 处理 |
|---|---|
| max_tokens / max_completion_tokens / max_output_tokens | 映射为 inferenceConfig.maxTokens；冲突和显式非正值报错。上游可能忽略限长，网关不做本地输出截断 |
| temperature、top_p | 使用可空数值区分省略与显式 0；按模型能力校验，允许的值原样传递 |
| system / developer / instructions | 转成 Kiro 系统初始化消息；关闭过滤器时保留空白和标签 |
| 文本和 inline base64 图片 | 同时保留，图片字节不会扣减文字预算 |
| Claude document、OpenAI file、Responses input_file | 转成原生 documents；文本源编码为 UTF-8 base64 |
| tools、tool_choice | 保留完整描述、参数与结果；名称适配和工具选择指令维持兼容 |
| cache_control | 消息/系统/工具边界映射为原生 cachePoint；过期和缓存效果仍由上游决定 |
| thinking、reasoning_effort、output_config | 对照模型 schema 分别使用 thinking/output_config 或 reasoning；显式 max effort 保留 |
| additional_model_request_fields | 原生模型参数扩展入口，值不被 effort 设置整包覆盖；根据模型 schema 本地校验类型、枚举和范围，最终仍受上游能力限制 |
| conversation_id | 显式会话标识保留；未提供时沿用稳定会话标识逻辑 |
| kiro_context | 传递 editorState、shellState、gitState、envState、additionalContext |

Kiro 对部分控制没有等价 API：`thinking.enabled` 的 budget_tokens 按参考实现映射为 effort 档位；tool_choice、parallel_tool_calls=false 与非严格 JSON 输出使用提示指令，不能保证等同于原生受约束解码。工具 JSON Schema 仍需遵循 Kiro 接受的结构，保留原项目已有的 schema 适配。

上述控制也受模型能力校验：Opus 5.5 使用 adaptive thinking，不支持手动思考预算、关闭思考或强制工具选择。`-thinking` 后缀使用原生思考控制，不再自动添加旧版 200000-token 思考提示。

公网 HTTP(S) 图片 URL 会下载并转换为上游要求的内联图片；不裁剪或压缩图片。下载器检查 DNS、重定向、图片格式和大小，并阻止私网及云元数据地址。普通文本 URL 和工具参数不会被抓取。PDF 按文档传递，不再作为图片解析。

未知参数、非空 stop/stop_sequences、n>1、seed、音频、严格 JSON Schema 和托管文件 ID，返回带参数名的 400。不会默默丢弃后返回成功。默认值的空停止列表、n=1 等可接受。metadata 属于客户端信封信息，不作为模型提示词。

所有上游 HTTP 400 都会立即返回，不再向其他 Kiro 端点重复发送同一个请求，也不因请求错误冷却账号。thinking signature 原样转发，但不实现 Anthropic 官方签名验证。当前能力与已验证的上游限制见 [API_COMPAT.md](API_COMPAT.md)。

HTTP 层的 32MiB 请求体限制保留，超限返回 413。模型上下文和 Kiro 网关的实际限制由上游返回错误，不通过改写用户输入来规避。管理员主动启用的系统提示过滤器仍按其设置执行。

Claude Code 在 messages 中插入的 system 消息会在原有会话位置并入相邻 user 回合；没有相邻 user 时转成独立 user 回合。合并时保留完整文字、空白、图片标签和缓存标记，并用换行分隔原消息。中途的 system 不会中断 tool_use 与 tool_result 的 ID 配对。Kiro 只有 user/assistant 角色，因此这属于协议适配，不能保证与官方 system 角色完全相同的指令优先级。

## 验证与构建

回归覆盖超过 900KB 的当前文字及历史、图片前后文字、图片标签、重复轮次、零值参数、文档、缓存边界、工具结果错误状态、完整工具调用参数、冷启动的原生思考参数，以及不支持参数的明确错误。完整包测试与 go vet 均需通过再发布。

```sh
docker run --rm -v "$PWD:/src" -w /src -e CGO_ENABLED=0 golang:1.25-alpine go test ./... -count=1
docker run --rm -v "$PWD:/src" -w /src -e CGO_ENABLED=0 golang:1.25-alpine go vet ./...
docker run --rm -v "$PWD:/src" -w /src -e CGO_ENABLED=0 golang:1.25-alpine go build -trimpath -o kiro-proxy-adapter .
docker build -f Dockerfile.adapter --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t kiro-reverse-api:request-adapter .
```

Dockerfile 固定原基础镜像摘要。部署时应保留账户数据库、管理页静态文件挂载和既有 Docker 网络，提前备份配置及数据库。恢复旧版本时可以恢复发布前的镜像配置并重新创建服务，避免覆盖发布后更新的账户数据库。
