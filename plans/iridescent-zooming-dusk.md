# Add `llm-shengsuanyun` adapter

## Context

The spec (`/Users/zou/prj/t/log/20260819_140324_ask_question_deepseek-ai_deepseek-harness.md`) asks for a new LLM provider adapter for ShengSuanYun (胜算云), a router that exposes many backing models (DeepSeek, Qwen, GLM, Kimi, GPT, Claude, …) behind one Anthropic-Messages-compatible endpoint plus a proprietary model-listing endpoint. The spec's own code is illustrative pseudocode (wrong import sources, an inconsistent `SHENG_SUAN_YUN_BASE_URL` constant, undefined helpers) — it is being used as a requirements source, not copied literally. The spec explicitly says: if the repo already has an Anthropic SDK available, use it directly and ignore the pasted raw HTTP doc. It does — `@anthropic-ai/sdk@0.93.0` is already a `dependencies` entry in `packages/subagent/subagent-claude-code` (not yet used for the Messages API anywhere in-repo; this adapter will be the first direct consumer of it).

Goal: a new package `packages/llm/llm-shengsuanyun` (`@deepseek-ai/dsh-llm-shengsuanyun`) providing an `LlmAdapter` for provider route `shengsuanyun`, structured like `llm-deepseek` (single fixed provider, thunk-based dynamic config) but using the Anthropic SDK for transport instead of raw fetch+SSE, and a raw `fetch` for the separate model-listing endpoint.

## Package layout

Modeled on `packages/llm/llm-deepseek` (`docs/cookbook/adding-a-package.md`, `adding-an-llm-adapter.md`):

```
packages/llm/llm-shengsuanyun/
  package.json
  tsconfig.json
  README.md
  README.zh.md
  src/
    index.ts       # plugin registration (Config, thunk, apply)
    adapter.ts      # ShengSuanYunAdapter extends LlmAdapter
    catalog.ts       # model-list fetch + cost/reasoning mapping + TTL cache
    translate.ts      # RawMessageStreamEvent -> StreamChunk, serializeMessages
    types.ts          # wire types for the model-listing endpoint only
    invariant.ts        # no-op invariant companion (copy llm-deepseek's shape)
  tests/
    adapter.spec.ts
    adapter.e2e.ts          # gated on SHENGSUANYUN_API_KEY
    catalog.spec.ts
    translate.spec.ts
    dynamic-config.spec.ts
    loader-composition.spec.ts
    mock-server.ts
```

Register in `tsconfig.host.json` `references` (next to the existing `llm-deepseek`/`llm-pi-ai` lines).

`package.json`: copy `llm-deepseek/package.json` shape — `private: true`, matching root `version`, `@deepseek-ai/cordis` in peer+dev, `@deepseek-ai/dsh-llm`/`dsh-credentials`/`dsh-launch-environment`/`dsh-settings`/`dsh-timeout`/`dsh-anonymous-user-id` in peer+dev, `@anthropic-ai/sdk: "0.93.0"` + `@deepseek-ai/schemastery` in plain `dependencies`. `tsconfig.json`: extend `tsconfig.base.json`, `rootDir: src`, `outDir: lib/types`, reference every workspace dep + `vendor/cosmokit`, `vendor/cordis`, `vendor/schemastery`.

## Design decisions

**Provider route key:** `shengsuanyun` (matches npm/package naming; the spec's own `"sheng-suan-yun"` value is inconsistent with its own `SHENGSUANYUN_*` constants and not used).

**Base URLs:**
- Anthropic SDK client `baseURL: https://router.shengsuanyun.com/api` (no trailing `/v1` — confirmed via `resources/messages/messages.js`, the SDK's `Messages.create()` always posts to the literal path `/v1/messages` relative to `baseURL`, giving the correct full URL).
- Model listing: plain `fetch('https://router.shengsuanyun.com/api/v1/models', ...)`, not through the SDK.
- Both configurable via `Config.baseURL`/`Config.modelsURL` with the above as defaults, following `llm-deepseek`'s `resolveAdapterOptions()` pattern (one explicit resolve step, re-validated on every settings snapshot).

**Auth:** construct the Anthropic client with `apiKey: <resolved key>` — the SDK's default request header for `apiKey` auth is `x-api-key`, which is what ShengSuanYun's `X-Api-Key` requires (HTTP headers are case-insensitive). Resolve the key via the same `resolveApiKey()` pattern as `llm-deepseek/src/index.ts` (`ctx.credentials` → `launchEnvironmentOf(ctx)` → throw `LlmError(..., 'MISSING_CREDENTIAL')`), default env var `SHENGSUANYUN_API_KEY`.

**Attribution headers:** spread `attributionHeaders()` into the `headers` of the per-call `RequestOptions` second argument to every `messages.create()`/`.stream()` call (confirmed field on `RequestOptions`), and into the raw `fetch` call for model listing. Do not rely on an unconfirmed `defaultHeaders` client-construction option.

**Model catalog (`catalog.ts`):**
- Fetch `GET {modelsURL}`, filter to `model.support_apis?.includes('/v1/messages')`.
- `cost.input/output/cacheWrite = (pricing.prompt|completion|cache ?? 0) / 10_000`; `cost.cacheRead = 0`.
- `contextWindow: model.context_window || 4096`, `maxTokens: model.max_tokens || 4096`, `inputModalities: ['text']` always, catalog-level `api: 'anthropic-messages'` tag kept as an internal field (not part of `LlmModelInfo`, which has no such field — see below).
- Port the spec's `getReasoningOptions(id)` prefix table (`deepseek/deepseek-v4`, `deepseek/deepseek-v3`, `openai/gpt-5.`, `ali/qwen3`, `bigmodel/glm-4.7`, `bigmodel/glm-5`, `moonshot/kimi`, `openai/o`, `anthropic/claude`) verbatim as a typed `ReasoningOption[]` lookup (`{type:'toggle'}` / `{type:'effort', values}` / `{type:'budget_tokens', min?, max?}`).
- In-memory TTL cache (5 min) around the fetch+map, single in-flight-fetch de-dup; on a failed refetch with an existing cache, log and keep serving the stale entries (mirrors the "fail loud only at first load" convention used for settings snapshots elsewhere in the repo).
- `listModels()` maps each cached entry to `LlmModelInfo{provider, id, name, inputModalities:['text']}`.
- `resolveModel()` maps a cache hit to `LlmResolvedModelInfo` adding `context: {contextWindow}`, `defaultMaxTokens: maxTokens`, and `reasoning` (see next point); a cache miss (unknown model id) falls back to the `LlmAdapter` base default `{provider, id: model, name: model}` — catalog membership is advisory only, never a request gate (same convention as `llm-deepseek`).

**Reasoning mapping (`GenerateOptions.reasoningEffort` ⇄ `getReasoningOptions()`):**
The harness models reasoning as one flat selectable list (`LlmModelReasoningInfo.efforts`), but ShengSuanYun's table can list independent option axes (e.g. `anthropic/claude` has both `budget_tokens` and `effort`). Resolution:
- If the model's options include an `effort` entry: expose its non-null `values` directly as effort ids (skip `null` — that entry means "no explicit field", already covered by omitting `reasoningEffort`). On request, `reasoningEffort` maps straight to `output_config: {effort: <value>}` (the newly-confirmed Anthropic field for named effort levels, distinct from `thinking`).
- Else if the model has `toggle` and/or `budget_tokens` (no `effort`): expose a synthetic two-value list `off`/`on`. On request: `off` → `thinking: {type:'disabled'}`; `on` → `thinking: {type:'enabled', budget_tokens: <budgetOption.min ?? 1024, clamped below max_tokens>}` when a `budget_tokens` option is present, else `thinking: {type:'adaptive'}` (pure `toggle`, e.g. `bigmodel/glm-4.7`/`glm-5`).
- No `defaultEffort` is declared (preserves provider default), per the cookbook's "declare a default only when one exists."
- `reasoning: boolean` for the raw catalog fetch is computed exactly per spec: true if any option is `toggle` or `effort` type — independent of (but consistent with) the structured `resolveModel()` mapping above.
- Unsupported/unknown `reasoningEffort` ids: throw `LlmError(..., 'UNSUPPORTED_REASONING_EFFORT')`, never silently clamp (matches `llm-pi-ai`'s `resolveReasoningLevel()`).

**Message serialization (`translate.ts`, request direction):**
- `system` → Anthropic `system` (plain string).
- Text-only inbound content: reuse `contentHasImage()` (`@deepseek-ai/dsh-llm`) to reject any image block with `LlmError(..., 'UNSUPPORTED_CONTENT')` — the catalog declares `inputModalities:['text']` only, mirroring `llm-deepseek`'s `assertTextOnly()`.
- `assistant` messages: if the message carries a `replayState` produced by this same adapter (`AssistantProvenance.replayState`), use the stored native Anthropic content blocks verbatim (see replay strategy below); otherwise project `ContentBlock[]` lossily: `text`→`TextBlockParam`, `tool-call`→`ToolUseBlockParam{id, name, input: JSON.parse(arguments)}`, and drop `reasoning` blocks (an Anthropic `thinking` block requires a server-issued signature this harness does not retain in `ReasoningBlock`; replaying a fabricated one fails signature validation, so the safe fallback is to omit it).
- `tool-result` messages → `ToolResultBlockParam{tool_use_id, content: [text blocks], is_error}`.
- `tools`/`tool_choice`: straightforward `ToolSchema[]` → `Tool[]` (`input_schema` from `parameters`).
- `stop` → `stop_sequences`; `maxTokens` → `max_tokens` (required by the SDK — default from `resolveModel().defaultMaxTokens` when the caller omits it); `temperature` passed through as given (no adapter-side validation of provider-specific deprecation; an out-of-range value surfaces from the provider as `INVALID_REQUEST`). No `GenerateOptions` field needs an `UNSUPPORTED` rejection — the Anthropic Messages API covers the full surface used here.

**Replay state:** capture the response's raw Anthropic `content` blocks (as returned by the stream, reassembled) into `finish.replayState`, so a subsequent request through this adapter for the same conversation can replay exact `thinking`/`tool_use` blocks (with signatures/ids) instead of the lossy projection above.

**Streaming translation (`translate.ts`, response direction):** drive off `RawMessageStreamEvent`:
- `content_block_start` → `block-start`; for `type:'tool_use'` also seed a `tool-call-delta{id, name, argumentsDelta:''}` (mirrors the `Map<number,{id,name}>` tracking pattern in `llm-deepseek`/`llm-pi-ai`). `thinking` blocks map to `blockType:'reasoning'`. Any other block type (server-tool blocks, etc. — not expected given this adapter requests no server tools) is skipped: reserve the index, drop its deltas, and it produces no `block-end` — noted as a Known Limitation.
- `content_block_delta`: `text_delta`→`text-delta`; `thinking_delta`→`reasoning-delta`; `input_json_delta.partial_json` (already incremental text) → `argumentsDelta` passthrough; `signature_delta`/`citations_delta` retained only in the accumulated block used for `replayState`, not surfaced as harness deltas (no matching `StreamChunk` variant).
- `content_block_stop` → close the tracked block into a `ContentBlock` and emit `block-end`.
- `message_delta` → emit `usage` (mapped from `MessageDeltaUsage`; Anthropic's `input_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens` are already disjoint, unlike DeepSeek's folded `prompt_tokens` — no subtraction needed) and stash `stop_reason`/`stop_details` for the terminal chunk.
- `message_stop` → emit the terminal `finish`, mapped from the stashed `stop_reason`: `end_turn`→`stop`, `tool_use`→`tool-calls`, `max_tokens`→`max-tokens`, `stop_sequence`→`stop`, `pause_turn`→`stop` (a valid, if unusual, completion boundary; no dedicated `FinishReasonMap` entry exists for either), `refusal`→`{kind:'error', failure:{message: stop_details.explanation, code:'REFUSAL'}}`. If the SDK's async iterator exhausts before `message_stop`, throw `LlmError(..., 'STREAM_CLOSED')` (mirrors `llm-deepseek`'s missing-`[DONE]` check).
- A `stop`-kind finish with zero emitted content blocks maps to `EMPTY_RESPONSE_CODE` instead of a bare empty success, matching `llm-deepseek`'s convention.

**Error mapping (`adapter.ts`):** classify by `instanceof` on the SDK's typed error hierarchy (`core/error.d.ts`) rather than text matching (unlike `llm-pi-ai`'s fallback, which only exists because that library flattens errors to a string):
- `AuthenticationError` / `PermissionDeniedError` → `AUTH`
- `RateLimitError` → `RATE_LIMIT`, with `providerRetryAfterMs` parsed from `error.headers.get('retry-after')`
- `BadRequestError` → check `isContextWindowExceededError`/`isQuotaExceededError` (`@deepseek-ai/dsh-llm`) over the joined `error.error`/`error.message` text, else `INVALID_REQUEST`
- `InternalServerError` → `SERVER`
- `APIConnectionTimeoutError` → `TIMEOUT`
- `APIConnectionError` → `TRANSPORT`
- `APIUserAbortError` → `ABORTED`
- generic `APIError` fallback → `HTTP_${error.status}`
- `requestId` from `error.requestID`, branded via `ProviderRequestId()`.
Pass `options.signal` straight through as the SDK call's `signal`; the adapter throws `LlmError` for these classes and lets `LlmRuntime.adapterStream()`'s normalization turn it into the terminal `error`/`aborted` finish — no manual finish-chunk construction needed for thrown errors.

**Plugin registration (`index.ts`):** copy `llm-deepseek/src/index.ts`'s shape exactly: `Config` (schemastery) with `apiKeyEnv` (default `SHENGSUANYUN_API_KEY`), `baseURL`, `modelsURL`, `maxTokens` default, `streamIdleTimeoutMs` default, `retryPolicy` (`RetryPolicySchema`); thunk (`current`/`lastRaw`/`lastGood`) resolved through `resolveAdapterOptions()`; `resolveApiKey()`; `ctx.llm.registerConfigurableProviders([{provider:'shengsuanyun', displayName:'ShengSuanYun', settingsNs, settingsPath:[]}])`; `ctx.llm.registerAdapter(['shengsuanyun'], adapter)` with `registration.replace()` on retry-policy change via `installSettingsSection()`.

**`invariant.ts`:** copy `llm-deepseek/src/invariant.ts`'s shape verbatim, `PACKAGE_NAME = '@deepseek-ai/dsh-llm-shengsuanyun'`, `name = 'llm-shengsuanyun-invariant'`, with a justified "no runtime invariant" reason specific to this package (no owned mutable relationship to check — same as `llm-deepseek`).

**No comments in new source** per the user's explicit instruction, beyond the repo's mandatory module/export JSDoc (which is a separate documentation gate, not a "comment").

## Verification

- `pnpm run typecheck && pnpm run lint` for the new package.
- `pnpm run test` — unit specs: `catalog.spec.ts` (reasoning-lookup table, cost scaling, `support_apis` filtering, TTL/stale-cache behavior), `translate.spec.ts` (event-stream → `StreamChunk`, replayState round-trip, refusal/empty-response/stream-closed edge cases), `adapter.spec.ts` (error-class → `LlmError` code mapping), `dynamic-config.spec.ts` (settings hot-reload, retry-policy re-registration).
- `tests/loader-composition.spec.ts` — real-composition Loader test modeled directly on `llm-deepseek/tests/loader-composition.spec.ts` (dynamic settings+credentials reload, restart persistence, entry-config-only fallback).
- `pnpm run test:coverage` for the package (CI's 100%-per-file gate).
- `tests/adapter.e2e.ts` gated on `SHENGSUANYUN_API_KEY` (self-skips without it), hitting the real endpoint.
- A keyless snapshot fixture per repo testing policy exercising the adapter through an assembled example.
- `pnpm run build && pnpm run hygiene` (workspace constraints, publint, knip).
- Add the package to `tsconfig.host.json` references; run `pnpm install` to register the workspace.
- Write the required Agent Note under `.agents/notes/` for this non-trivial architectural addition (new capability seam member).
- Write `README.md`/`README.zh.md` following the canonical structure (`docs/cookbook/adding-a-package.md` §4): Config, Dynamic configuration, App attribution, Wire-format notes, Errors, Model Experience (request/response context blocks), Known Limitations and Deferred Work (listing the skipped-block-type and dropped-reasoning-block-on-lossy-replay limitations called out above).
