# @deepseek-ai/dsh-llm-shengsuanyun

English | [中文](README.zh.md)

ShengSuanYun (胜算云) router adapter for the harness LLM seam: an `@anthropic-ai/sdk` client against ShengSuanYun's Anthropic-Messages-API-compatible endpoint, plus a separate raw-`fetch` model catalog against ShengSuanYun's own listing endpoint. ShengSuanYun routes one endpoint to many backing models (DeepSeek, Qwen, GLM, Kimi, GPT, Claude, and others); this adapter is transport-only and treats every routed model uniformly through the Anthropic wire format.

The package root exposes the Cordis plugin contract and `ShengSuanYunAdapter`; catalog fetching/mapping and request/response translation helpers are not part of that root contract.

## Config

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

The plugin registers the single provider route `shengsuanyun` together with its resolved `retryPolicy`. A request selects it with `provider: shengsuanyun`; its `model` is passed through unchanged as the wire `model` string, so a new backing model behind the router reaches this adapter without a code or lifecycle change. The model catalog is fetched from `modelsURL`, filtered to entries whose `support_apis` includes `/v1/messages`, and exposed through `ctx.llm.listModels('shengsuanyun')`/`ctx.llm.resolveModelInfo('shengsuanyun', model)` for clients such as ACP editors and the Web selector — membership is advisory only, never a request gate: an unlisted model id still passes through.

`maxTokens` is the adapter-configured output cap used only when a model advertises none; a catalog entry's own `max_tokens` field wins when present, exposed as `defaultMaxTokens` on exact-model resolution. An explicit request or `AgentOptions.maxTokens` value wins over both and is serialized as `max_tokens`.

### Reasoning

Each routed model's reasoning control is looked up by longest-prefix match on its id against a fixed table (`deepseek/deepseek-v4`, `deepseek/deepseek-v3`, `openai/gpt-5.`, `ali/qwen3`, `bigmodel/glm-4.7`, `bigmodel/glm-5`, `moonshot/kimi`, `openai/o`, `anthropic/claude`), mirroring ShengSuanYun's own documented per-model reasoning axes. A model whose table entry declares an `effort` axis exposes those exact named levels (e.g. `none`/`low`/`high`/`max`) under `reasoning.efforts`; selecting one serializes as Anthropic's `output_config: {effort}`. A model with only `toggle` and/or `budget_tokens` axes instead exposes a synthetic `off`/`on` pair: `off` serializes `thinking: {type: 'disabled'}`, and `on` serializes `thinking: {type: 'enabled', budget_tokens}` when the table declares a `budget_tokens` minimum (clamped below the request's `max_tokens`), else `thinking: {type: 'adaptive'}`. A model absent from the table declares no reasoning control at all. Selecting an id the model's axis does not declare fails with `UNSUPPORTED_REASONING_EFFORT` before network I/O; omitting `reasoningEffort` sends no reasoning field and preserves the provider's own default.

## Dynamic configuration (settings + credentials)

Connection facts are not frozen at load. `resolveAdapterOptions` is the one explicit resolve step from raw config to validated facts, and the adapter re-reads them through a thunk **once per operation**: base URL, model-listing URL, request defaults, and idle budget all take effect on the next request, while an in-flight stream keeps the facts it started with. Two optional seams feed that thunk:

- **`ctx.settings`** — the plugin registers the `llm-shengsuanyun` namespace with this same `Config` schema and its `cordis.yml` entry as the composition `base`, so a `llm-shengsuanyun:` section in the user settings document overrides any field without a restart. Without a mounted settings service the entry config alone drives the adapter, unchanged. A live settings snapshot that passes the schema but fails a beyond-schema bound keeps the last good facts and logs the failure; the entry config itself still fails plugin load.
- **`ctx.credentials`** — the API key resolves per stream call, from the *same* resolved snapshot that supplies the endpoint. Configuration carries only `apiKeyEnv`, never a literal key: the reference resolves through the credential seam, and without a mounted seam through the trusted environment layers. Because credential facts travel with the connection facts, a settings snapshot the resolver rejects contributes neither its endpoint nor its key: the whole previous generation keeps serving. Every resolved key is format-checked before use, so a value no HTTP header can carry is refused with `LlmError('INVALID_CREDENTIAL')` naming the failing entry point — never any part of the key. A request with no key anywhere fails with `MISSING_CREDENTIAL` naming every configuration entry point, while the route stays registered and the catalog stays browsable.

The one registration-captured fact is the retry policy: when its resolved value changes, the plugin re-registers the route in place (same adapter instance, one synchronous section), so `ctx.llm.providerRetryPolicy('shengsuanyun')` always reports the current policy.

The plugin also declares its route in the configurable-provider directory (`ctx.llm.listConfigurableProviders()`): provider `shengsuanyun`, settings namespace `llm-shengsuanyun`, empty settings path — the whole section is the profile. It registers model discovery for that namespace (`ctx.llm.discoverModels('llm-shengsuanyun', …)`), so the Models page's "fetch models" action answers from the shared TTL-cached catalog rather than a second listing fetch; the probe's `baseURL` is ignored because the listing endpoint is the plugin's own `modelsURL`, not the Messages `baseURL`.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()` — the mandatory `User-Agent` baseline identifying the harness (see [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts)) — merged into the per-call request headers of both the Anthropic SDK call and the raw model-listing `fetch`. This adapter declares no further ShengSuanYun-specific attribution.

## Wire-format notes

- Authentication constructs the Anthropic SDK client with the resolved key as `apiKey`; the SDK's default API-key header (`x-api-key`) satisfies ShengSuanYun's documented `X-Api-Key` requirement (HTTP header names are case-insensitive).
- The client's `baseURL` is the configured endpoint with no `/v1` suffix — the SDK appends the literal path `/v1/messages` to `baseURL` itself.
- Assistant turns replay the exact native Anthropic content blocks captured from this adapter's own prior response (`replayState`) when available, preserving `thinking` signatures and tool-use ids/inputs; a turn without a stored `replayState` (e.g. produced by a different adapter) projects lossily instead: `text`/`tool-call` blocks convert directly, and `reasoning` blocks are dropped, since a fabricated `thinking` signature fails provider validation.
- `tool-result` messages become standalone user-role `tool_result` blocks, one message per result, mirroring the harness's one-result-per-message vocabulary.
- Only text content is accepted inbound; any image block fails with `UNSUPPORTED_CONTENT` before network I/O, since the catalog declares `inputModalities: ['text']` only.
- Response usage (`input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`) is already disjoint on the wire — no subtraction is needed to compute cache-read/cache-write counts.

## Errors

Anthropic SDK error classes map to stable `LlmError` codes by `instanceof`, not text matching: `AuthenticationError`/`PermissionDeniedError` → `AUTH`, `RateLimitError` → `RATE_LIMIT` with `providerRetryAfterMs` parsed from the response's `retry-after` header (seconds or HTTP-date form), `BadRequestError` → `CONTEXT_WINDOW_EXCEEDED` or `QUOTA` when the provider detail identifies one, else `INVALID_REQUEST`, `InternalServerError` → `SERVER`, `APIConnectionTimeoutError` → `TIMEOUT`, `APIConnectionError` → `TRANSPORT`, `APIUserAbortError` → `ABORTED`, any other `APIError` → `HTTP_<status>`. Every mapped error carries `requestId` from the provider's request id header when present. A stream that exhausts before a terminal `message_stop` throws `LlmError('STREAM_CLOSED')`; a completed stream whose finish opened no content blocks becomes `finish {kind: 'error'}` with code `EMPTY_RESPONSE`; a `refusal` stop reason becomes `finish {kind: 'error', failure: {code: 'REFUSAL'}}`. A configured idle read timeout throws `LlmError('TIMEOUT')`; a caller abort throws `LlmError('ABORTED')`.

## Model Experience

### ShengSuanYun-routed request

#### What the model sees

The routed backing model receives the harness system prompt, message history, tool schemas, stop sequences, and call config translated into the Anthropic Messages wire format, without adapter-authored prompt prose. A model whose reasoning axis is `effort`-based receives the selected named level in `output_config.effort`; a `toggle`/`budget_tokens` model receives an equivalent `thinking` config.

#### Token effect

Provider tokenization for the routed backing model governs exact input. Replayed `thinking`/`tool_use` blocks preserve their original token cost across turns when a prior response's `replayState` is available; a lossily-projected turn (no stored `replayState`) omits reasoning content entirely.

#### KV Cache effect

An unchanged assembled prefix is eligible for the routed backing model's own cache reuse, reported in usage when the provider supports it. A model-route change, or any upstream prompt, schema, prefix, or history change, may prevent reuse from the first changed token.

### ShengSuanYun-routed response

#### What the model sees

Text, reasoning (`thinking`), and tool-use content are translated into harness chunks for the loop to log and assemble; the native content blocks are additionally retained as `replayState` for this adapter's own next-turn replay.

#### Token effect

Generated tokens follow the request's logged reasoning selection and `maxTokens`; only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect. Changing the provider or routed model selects a different cache domain.

## Known Limitations and Deferred Work

- **Non-text, non-tool-use content blocks are skipped during streaming** — server-tool result blocks and other block types this adapter never requests reserve their index but emit no deltas or `block-end`, since the adapter requests no server tools.
- **`tool_choice` is not mapped** — not part of the core vocabulary (shared with the DeepSeek and pi-ai adapters).
- **The model-listing `fetch` does not go through `@cordisjs/plugin-http`** — no shared proxy/interception configuration; adoption is deferred until a second adapter wants it.
- **Serialization flattens tool-result content to text blocks** — plugin-added block types are skipped, and empty tool output crosses the wire as the literal `(no output)`.
