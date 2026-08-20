# Agent Note: 基于 Anthropic Messages 协议格式的胜算云路由适配器

Status: implemented

[English](2026-08-19-shengsuanyun-anthropic-router-adapter.md) | 中文

## 问题

[基于提供方路由的 LLM 适配器](../architecture/2026-07-14-provider-routed-llm-adapters.md)让提供方成为与模型无关的注册键，因此一个前置多个后端模型的路由只需要一个适配器，而不必为每个后端模型各配一个。胜算云是这样一种路由：它在同一个说 Anthropic Messages 协议格式的端点背后暴露 DeepSeek、Qwen、GLM、Kimi、GPT 和 Claude 等模型，并附带一个独立的自有模型列表端点。现有的每个适配器都是真正的孿生实现——`dsh-llm-deepseek` 手写 fetch 与 SSE 解析，`dsh-llm-pi-ai` 委托给一个提供方抽象库——但都没有验证过由第三方*客户端 SDK* 驱动 harness 自身转换层的场景,也没有哪个现有适配器的 catalog 需要在同一提供方内部调和互不一致的按后端模型区分的推理轴。

`@anthropic-ai/sdk` 已经是仓库依赖（被 `dsh-subagent-claude-code` 使用），但此前没有直接的 Messages API 消费者，因此本适配器也是 harness 代码首次将 `RawMessageStreamEvent` 转换为 `StreamChunk` 的地方。

## 决策

`dsh-llm-shengsuanyun` 注册唯一的提供方路由 `shengsuanyun`，并按操作构造一个 `@anthropic-ai/sdk` 客户端，其 `baseURL` 设为配置的端点（不带 `/v1` 后缀——SDK 自身会追加字面路径 `/v1/messages`）。`apiKey` 为解析出的凭据；SDK 默认的 `x-api-key` 请求标头满足胜算云文档要求的 `X-Api-Key`（HTTP 标头名不区分大小写）。模型字符串到达路由时不会与 catalog 校验——catalog 成员关系仅供参考,与所有其他适配器的约定一致——因此路由背后新增的后端模型无需任何代码变更即可被本适配器使用。

模型 catalog 是一次独立的原始 `fetch`，请求 `modelsURL`，过滤为 `support_apis` 包含 `/v1/messages` 的条目，通过将 `pricing.{prompt,completion,cache}` 除以协议的 10,000 缩放因子完成成本映射，并进行 TTL 缓存（5 分钟、单飞、存在旧缓存时对刷新失败进行陈旧数据兜底服务）。每个模型的推理控制方式，按其 id 的最长前缀匹配一份固定表查得，该表对应胜算云自身文档中各模型的推理轴（`deepseek/deepseek-v4`、`deepseek/deepseek-v3`、`openai/gpt-5.`、`ali/qwen3`、`bigmodel/glm-4.7`、`bigmodel/glm-5`、`moonshot/kimi`、`openai/o`、`anthropic/claude`）。若某模型的条目声明了 `effort` 轴，则会在 `reasoning.efforts` 下公开这些确切的具名等级，分发到 Anthropic 的 `output_config: {effort}` 字段；仅有 `toggle`/`budget_tokens` 轴的模型则公开一组合成的 `off`/`on`，分发到 `thinking: {type: 'disabled'|'enabled'|'adaptive'}`（当表中声明了最小值时，`budget_tokens` 会被限制在请求 `max_tokens` 之下）。不在表中的模型不声明任何推理控制；为模型的轴未声明的 id 选择推理强度会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败,与 `dsh-llm-pi-ai` 的 `resolveReasoningLevel()` 做法一致。

assistant 轮次序列化会在可用时回放本适配器自身上一次响应 `finish.replayState` 中捕获的原生 Anthropic 内容块，跨轮次保留 `thinking` 签名与工具调用的 id/输入。没有存储 `replayState` 的轮次——由另一适配器产生,或早于本功能的历史记录——则改为有损投影：`text`/`tool-call` 块直接转换，`reasoning` 块被丢弃，因为伪造的 `thinking` 签名会导致 Anthropic 服务端校验失败。`tool-result` 消息会变为独立的 user 角色 `tool_result` 块，一条消息对应一个结果，对应 harness 「一条消息一个结果」的词汇约定。仅接受文本内容作为输入（任何图片块都会在网络 I/O 前以 `UNSUPPORTED_CONTENT` 失败），因为 catalog 只声明 `inputModalities: ['text']`。

流式转换遵循与 Anthropic SDK 自身文档协议相同的 `content_block_start`/`_delta`/`_stop`、`message_delta`、`message_stop` 事件序列；流在到达 `message_stop` 之前耗尽会抛出 `STREAM_CLOSED`，已完成流若其 finish 未开启任何内容块会映射为 `EMPTY_RESPONSE_CODE`（这两条约定均已由 `dsh-llm-deepseek` 确立）。本适配器从未请求过的 server-tool 等其他块类型会保留其索引位但不产生任何增量或 `block-end`——这是一条记录在案的已知限制，而非转换缺口，因为适配器自身的请求从未开启过这类块。响应 usage（`input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`）在协议上已经互不重叠，不同于 DeepSeek 折叠的 `prompt_tokens`，因此无需做减法。

错误按 `instanceof` 而非文本匹配对 SDK 的类型化错误层级分类——`AuthenticationError`/`PermissionDeniedError` → `AUTH`；`RateLimitError` → `RATE_LIMIT`，`providerRetryAfterMs` 从 `retry-after` 标头解析；`BadRequestError` → 经由共享的 detail 分类器判定为 `CONTEXT_WINDOW_EXCEEDED`/`QUOTA`/`INVALID_REQUEST`；`InternalServerError` → `SERVER`；`APIConnectionTimeoutError` → `TIMEOUT`；`APIConnectionError` → `TRANSPORT`；`APIUserAbortError` → `ABORTED`；其他 `APIError` → `HTTP_<status>`，每个都在提供方请求 id 标头存在时携带 `requestId`。

动态配置（`ctx.settings`、`ctx.credentials`）与注册期捕获的重试策略完全遵循 `dsh-llm-deepseek` 已确立的 thunk 模式：连接事实按每次操作解析一次，进行中的流保留其起始事实，被 resolver 拒绝的 settings 快照既不贡献自己的端点，也不贡献自己的密钥。

## 已考虑的替代方案

- **原始 `fetch` + 手写 SSE 解析器**，与 `dsh-llm-deepseek` 自身的内部实现一致。已否决：该 SDK 已是仓库依赖，说明文档明确要求在可用时使用它，且这样做能验证孿生适配器设计此前刻意未覆盖的 SDK 消费者模式。
- **按后端模型家族各配一个适配器**（一个 DeepSeek 形态的适配器、一个 Claude 形态的适配器等），与原生提供方适配器的粒度一致。已否决：胜算云自身的传输层对所有后端模型统一使用 Anthropic Messages 协议格式，因此按家族拆分适配器只会重复完全相同的转换层而不带来任何能力提升，并会削弱该路由「新增后端模型无需代码变更」这一自身价值。
- **路由级（而非模型级）推理默认值**，与最初的 `dsh-llm-pi-ai` 形态一致。基于与[逐模型推理声明 Agent Note](2026-08-08-pi-ai-per-model-reasoning-declarations.md)在上游否决该方案相同的理由而否决：胜算云自身的后端模型对其接受哪些推理轴意见不一，因此单一路由级开关无法设置而不破坏路由的一部分。

## 后果

- harness 获得了一种路由式提供方，其后端模型集合可以在不修改 Cordis 插件的情况下增长，并已针对所有其他适配器共同验证的同一套 `StreamChunk` 词汇完成验证。
- Models 页的「获取模型」动作经由 `ctx.llm.registerModelDiscovery` 查询 `llm-shengsuanyun` namespace，由与 `listModels()` 相同的 TTL 缓存 catalog 直接回答——不发起第二次列表请求，且探测请求里的 `baseURL` 被忽略，因为列表端点是插件自己的 `modelsURL`，而非 Messages 的 `baseURL`。
- `@anthropic-ai/sdk` 现在在仓库内除 `dsh-subagent-claude-code` 之外多了一个 Messages API 消费者，因此一次改变 `OutputConfig`、错误类形态或流事件类型的 SDK 升级，也会被本包的类型检查与测试捕获，而不仅仅是 subagent 后端。
- 前缀表推理查询是一个需要维护的产物，而非从 catalog 响应派生：胜算云侧对某后端模型推理轴的变更需要在本包中做相应的表编辑，否则会静默退化为「无推理控制」，直至被修正。
- 未映射 `tool_choice`（与 `dsh-llm-deepseek`、`dsh-llm-pi-ai` 共享此缺口）；模型列表 `fetch` 未经过 `@cordisjs/plugin-http`，因此在有第二个适配器需要之前，没有共享的 proxy/拦截配置。

## 测试

单元测试覆盖推理查询表、成本缩放、`support_apis` 过滤、TTL/陈旧缓存行为，事件流到 `StreamChunk` 的转换（包括 replay-state 往返与拒绝/空响应/流中断等边界情况），以及 SDK 错误类到 `LlmError` code 的映射。一个真实组合的 Loader 测试覆盖 settings/凭据热重载、重试策略重新注册与重启后的持久化。一个 keyless 快照 fixture 通过一个已组装示例验证该适配器，并有一个受 `SHENGSUANYUN_API_KEY` 门控的 e2e 测试请求真实端点。
