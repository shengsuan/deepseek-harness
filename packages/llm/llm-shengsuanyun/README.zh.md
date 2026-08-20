# @deepseek-ai/dsh-llm-shengsuanyun

[English](README.md) | 中文

harness LLM（大语言模型）seam 的胜算云（ShengSuanYun）路由适配器：使用 `@anthropic-ai/sdk` 客户端调用胜算云与 Anthropic Messages API 兼容的端点，并通过独立的原始 `fetch` 访问胜算云自有的模型列表端点。胜算云将同一端点路由到多个后端模型（DeepSeek、Qwen、GLM、Kimi、GPT、Claude 等）；本适配器只负责传输层，对所有被路由的模型统一使用 Anthropic 协议格式处理。

包根入口导出 Cordis 插件约定与 `ShengSuanYunAdapter`；catalog 抓取／映射与请求/响应转换 helper 不属于该根约定。

## 配置

```yaml
- id: llm-shengsuanyun
  name: '@deepseek-ai/dsh-llm-shengsuanyun'
  config:
    apiKeyEnv: SHENGSUANYUN_API_KEY  # default; resolved per request via ctx.credentials, then the environment
    baseURL: https://router.shengsuanyun.com/api  # optional; $SHENGSUANYUN_BASE_URL then the public router when omitted
    modelsURL: https://router.shengsuanyun.com/api/v1/models  # optional; public listing endpoint by default
    maxTokens: 8192           # optional positive per-request output cap; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    retryPolicy:               # optional; omission uses bounded normal defaults
      mode: always             # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
```

该插件注册唯一提供方路由 `shengsuanyun`，同时注册解析后的 `retryPolicy`。请求使用 `provider: shengsuanyun` 选择该路由；其 `model` 会原样传递为协议 `model` 字符串，因此路由背后新增的后端模型无需任何代码或生命周期变更即可被本适配器使用。模型 catalog 从 `modelsURL` 抓取，过滤为 `support_apis` 包含 `/v1/messages` 的条目，并通过 `ctx.llm.listModels('shengsuanyun')` / `ctx.llm.resolveModelInfo('shengsuanyun', model)` 公开给 ACP 编辑器与 Web 选择器等客户端——catalog 成员关系仅供参考，绝不作为请求门槛：未列出的模型 id 仍会原样传递。

`maxTokens` 是适配器配置的输出上限，仅在模型未声明自身上限时使用；catalog 条目自带的 `max_tokens` 字段存在时优先生效，并在精确模型解析时公开为 `defaultMaxTokens`。显式的请求值或 `AgentOptions.maxTokens` 值优先于二者，并会序列化为 `max_tokens`。

### 推理（Reasoning）

每个被路由模型的推理控制方式，按其 id 的最长前缀匹配一份固定表（`deepseek/deepseek-v4`、`deepseek/deepseek-v3`、`openai/gpt-5.`、`ali/qwen3`、`bigmodel/glm-4.7`、`bigmodel/glm-5`、`moonshot/kimi`、`openai/o`、`anthropic/claude`）查得，该表对应胜算云自身文档中各模型的推理轴。若某模型的表条目声明了 `effort` 轴，则会在 `reasoning.efforts` 下公开这些确切的具名等级（例如 `none`/`low`/`high`/`max`）；选中其一会序列化为 Anthropic 的 `output_config: {effort}`。仅声明 `toggle` 和/或 `budget_tokens` 轴的模型则公开一组合成的 `off`/`on`：`off` 序列化为 `thinking: {type: 'disabled'}`；`on` 在表中声明了 `budget_tokens` 最小值时序列化为 `thinking: {type: 'enabled', budget_tokens}`（会被限制在请求 `max_tokens` 之下），否则序列化为 `thinking: {type: 'adaptive'}`。不在表中的模型不声明任何推理控制。为模型的轴未声明的 id 选择推理强度会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败；省略 `reasoningEffort` 则不发送任何推理字段，保留提供方自身的默认行为。

## 动态配置（settings + credentials）

连接事实不在加载时冻结。`resolveAdapterOptions` 是从原始配置到已校验事实的唯一显式 resolve 步骤，适配器经由一个 thunk **每操作重读一次**：base URL、模型列表 URL、请求默认值与 idle 预算都在下一次请求生效，进行中的流则保持其起始事实。两个可选 seam 供给该 thunk：

- **`ctx.settings`**——插件用同一份 `Config` schema 注册 `llm-shengsuanyun` namespace，并以其 `cordis.yml` 条目为组合 `base`，因此用户设置文档中的 `llm-shengsuanyun:` 分节可以免重启覆盖任何字段。未挂载 settings 服务时，仅由 entry 配置驱动适配器，行为不变。存活 settings 快照若通过 schema 却违反 schema 之外的约束，则保留最后可用事实并记录失败；entry 配置本身仍会使插件加载失败。
- **`ctx.credentials`**——API 密钥按每次 stream 调用解析，取自与端点*同一*份解析后的快照。配置只携带 `apiKeyEnv`，从不携带字面密钥：该引用经凭据 seam 解析，未挂载 seam 时则经受信环境层解析。由于凭据事实与连接事实同行，被 resolver 拒绝的 settings 快照既不贡献自己的端点，也不贡献自己的密钥：整个先前世代继续服务。每个解析出的密钥在使用前都会被校验格式，因此 HTTP 标头无法承载的值会以 `LlmError('INVALID_CREDENTIAL')` 被拒绝，点名失败的入口，但绝不透露密钥的任何部分。任何地方都没有密钥的请求以 `MISSING_CREDENTIAL` 失败，并点名每个配置入口，同时路由保持注册、catalog 保持可浏览。

唯一在注册期捕获的事实是重试策略：其解析值变化时，插件原地重新注册该路由（同一适配器实例、一个同步区段），因此 `ctx.llm.providerRetryPolicy('shengsuanyun')` 始终报告当前策略。

该插件还会在可配置提供方目录（`ctx.llm.listConfigurableProviders()`）中声明自己的路由：提供方为 `shengsuanyun`，settings namespace 为 `llm-shengsuanyun`，settings path 为空——整个分节就是 profile。它还为该 namespace 注册了模型发现（`ctx.llm.discoverModels('llm-shengsuanyun', …)`），因此 Models 页的"获取模型"动作直接由共享的 TTL 缓存 catalog 回答，而不会发起第二次列表请求；探测请求里的 `baseURL` 会被忽略，因为列表端点是插件自己的 `modelsURL`，而不是 Messages 的 `baseURL`。

## 应用归因

每个请求都携带 dsh-llm `attributionHeaders()` 的共享归因标头，即用于识别 harness 的必需 `User-Agent` 基线（见 [dsh-llm § 应用归因](../llm/README.md#app-attribution-attributionts)），会合并进 Anthropic SDK 调用与模型列表原始 `fetch` 调用各自的请求标头中。本适配器未声明任何进一步的胜算云特定归因。

## 协议格式说明

- 鉴权通过用解析出的密钥作为 `apiKey` 构造 Anthropic SDK 客户端完成；SDK 默认的 API 密钥标头（`x-api-key`）满足胜算云文档要求的 `X-Api-Key`（HTTP 标头名不区分大小写）。
- 客户端的 `baseURL` 是配置的端点，不带 `/v1` 后缀——SDK 会自行在 `baseURL` 后追加字面路径 `/v1/messages`。
- assistant 轮次在可用时会回放本适配器自身上一次响应捕获的原生 Anthropic 内容块（`replayState`），保留 `thinking` 签名与工具调用的 id/输入；没有存储 `replayState` 的轮次（例如由另一适配器产生）则改为有损投影：`text`/`tool-call` 块直接转换，`reasoning` 块被丢弃，因为伪造的 `thinking` 签名会导致提供方校验失败。
- `tool-result` 消息会变为独立的 user 角色 `tool_result` 块，一个结果对应一条消息，对应 harness 「一条消息一个结果」的词汇约定。
- 仅接受文本内容作为输入；任何图片块都会在网络 I/O 前以 `UNSUPPORTED_CONTENT` 失败，因为 catalog 只声明 `inputModalities: ['text']`。
- 响应 usage（`input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`）在协议上已经互不重叠——计算 cache-read/cache-write 数量无需做减法。

## 错误

Anthropic SDK 的错误类会按 `instanceof` 而非文本匹配映射为稳定的 `LlmError` code：`AuthenticationError`/`PermissionDeniedError` → `AUTH`；`RateLimitError` → `RATE_LIMIT`，`providerRetryAfterMs` 从响应的 `retry-after` 标头解析（秒数或 HTTP 日期形式）；`BadRequestError` → 提供方详细信息能识别时为 `CONTEXT_WINDOW_EXCEEDED` 或 `QUOTA`，否则为 `INVALID_REQUEST`；`InternalServerError` → `SERVER`；`APIConnectionTimeoutError` → `TIMEOUT`；`APIConnectionError` → `TRANSPORT`；`APIUserAbortError` → `ABORTED`；其他 `APIError` → `HTTP_<status>`。每个被映射的错误在提供方请求 id 标头存在时都会携带 `requestId`。流在到达终结的 `message_stop` 之前耗尽会抛出 `LlmError('STREAM_CLOSED')`；已完成流若其 finish 未开启任何内容块，会变为 code 为 `EMPTY_RESPONSE` 的 `finish {kind: 'error'}`；`refusal` 停止原因会变为 `finish {kind: 'error', failure: {code: 'REFUSAL'}}`。配置的 idle 读取超时会抛出 `LlmError('TIMEOUT')`；调用方 abort 会抛出 `LlmError('ABORTED')`。

## 模型体验

### 胜算云路由请求

#### 模型看到的内容

被路由的后端模型会收到 harness 系统提示词、消息历史、工具 schema、stop sequence 和调用配置，均已转换为 Anthropic Messages 协议格式，不含适配器撰写的提示词文本。推理轴为 `effort` 型的模型会在 `output_config.effort` 中收到所选具名等级；`toggle`/`budget_tokens` 型模型会收到等效的 `thinking` 配置。

#### Token 影响

精确输入取决于被路由后端模型自身的 tokenization。当上一响应的 `replayState` 可用时，回放的 `thinking`/`tool_use` 块会在多轮之间保留其原始 token 开销；没有存储 `replayState` 的有损投影轮次会完全省略推理内容。

#### KV Cache 影响

未更改的已组装前缀可用于被路由后端模型自身的 cache 复用，在提供方支持时通过 usage 报告。模型路由变更，或任何上游提示词、schema、前缀或历史变更，都可能使从首个发生变化的 token 起的复用失效。

### 胜算云路由响应

#### 模型看到的内容

文本、推理（`thinking`）与工具调用内容会转换为 harness 分片，供 loop 记录和组装；原生内容块还会作为 `replayState` 保留，供本适配器在下一轮自行回放。

#### Token 影响

生成 token 遵循请求中已记录的推理选择和 `maxTokens`；只有 loop 保留的块会影响后续输入。

#### KV Cache 影响

loop 保留的响应块会追加到下一个请求，并保留其较早可复用前缀；已丢弃块不会影响后续 cache。更改提供方或被路由模型会选择不同 cache 域。

## 已知限制与暂缓事项

- **流式过程中会跳过非文本、非工具调用的内容块**：本适配器从未请求过的 server-tool 结果块等其他块类型会保留其索引位，但不产生任何增量或 `block-end`，因为适配器不会请求任何 server tool。
- **未映射 `tool_choice`**：它不属于核心词汇（与 DeepSeek、pi-ai 适配器共享此取舍）。
- **模型列表 `fetch` 未经过 `@cordisjs/plugin-http`**：没有共享 proxy／拦截配置；采用暂缓到第二个适配器需要该功能时。
- **序列化会将工具结果内容展平为文本块**：会跳过插件添加的块类型，空工具输出会以字面 `(no output)` 通过协议发送。
