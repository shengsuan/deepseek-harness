/**
 * `ShengSuanYunAdapter`: Anthropic-SDK transport against ShengSuanYun's
 * Anthropic-Messages-API-compatible router, plus a separate raw-fetch model
 * catalog. The adapter is transport-only: connection facts arrive through a
 * thunk resolved once per operation and the API key through a per-request
 * resolver, so the registering plugin owns validation, layering, and
 * credential policy.
 *
 * @module @deepseek-ai/dsh-llm-shengsuanyun/adapter
 */

import Anthropic from '@anthropic-ai/sdk'
import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { catalogModelInfo, catalogResolvedModelInfo, ModelCatalog } from './catalog.ts'
import { serializeRequest, translate } from './translate.ts'

/** Validated connection facts for one operation. */
export interface ShengSuanYunConnectionOptions {
  /** Anthropic Messages endpoint base; the SDK appends `/v1/messages`. */
  baseURL: string
  /** Model-listing endpoint, fetched directly (not through the Anthropic SDK). */
  modelsURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret.
   */
  apiKeyEnv: CredentialRef
  /** Default per-request output cap; a model's own default and explicit request values win. */
  maxTokens: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link ShengSuanYunAdapter}: the operation-local resolution hooks the plugin owns. */
export interface ShengSuanYunAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => ShengSuanYunConnectionOptions
  /**
   * Resolve the API key for the connection facts of one request. Throws
   * `LlmError` `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: ShengSuanYunConnectionOptions) => Promise<string>
  /** Model catalog shared across requests; owns its own TTL cache and stale-serve policy. */
  catalog: ModelCatalog
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default per-request output-token cap, used only when a model advertises none. */
export const DEFAULT_MAX_TOKENS = 8_192
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function providerRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(value: string | null | undefined): ReturnType<typeof ProviderRequestId> | undefined {
  return value === null || value === undefined || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an Anthropic SDK error to a stable harness `LlmError`.
 * @param error - the error thrown by an Anthropic SDK call.
 * @param baseURL - the configured endpoint, used in the wrapped message.
 * @returns an `LlmError`; passes an already-normalized `LlmError` through unchanged.
 */
export function toLlmError(error: unknown, baseURL: string): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof Anthropic.APIUserAbortError) {
    return new LlmError('ShengSuanYun request aborted by caller', 'ABORTED', { cause: error })
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError(`ShengSuanYun API request to ${baseURL} timed out`, 'TIMEOUT', { cause: error })
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError(`ShengSuanYun API request to ${baseURL} failed`, 'TRANSPORT', { cause: error })
  }
  if (error instanceof Anthropic.APIError) {
    const id = requestId(error.requestID)
    const options = {
      ...typeof error.status === 'number' ? { status: error.status } : {},
      ...id === undefined ? {} : { requestId: id },
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new LlmError(error.message, 'AUTH', options)
    }
    if (error instanceof Anthropic.RateLimitError) {
      const delay = providerRetryAfterMs(error.headers)
      return new LlmError(error.message, 'RATE_LIMIT', {
        ...options,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
      })
    }
    if (error instanceof Anthropic.BadRequestError) {
      const detail = [error.type, error.message].filter(Boolean).join(' ')
      if (isContextWindowExceededError(detail)) return new LlmError(error.message, CONTEXT_WINDOW_EXCEEDED_CODE, options)
      if (isQuotaExceededError(detail)) return new LlmError(error.message, QUOTA_EXCEEDED_CODE, options)
      return new LlmError(error.message, 'INVALID_REQUEST', options)
    }
    if (error instanceof Anthropic.InternalServerError) {
      return new LlmError(error.message, 'SERVER', options)
    }
    return new LlmError(error.message, `HTTP_${String(error.status)}`, options)
  }
  return new LlmError(`ShengSuanYun API request to ${baseURL} failed`, 'TRANSPORT', { cause: error })
}

/**
 * `LlmAdapter` for the `shengsuanyun` provider route: one Anthropic SDK
 * client per operation (its facts may change between calls), backed by a
 * shared {@link ModelCatalog} for listing and resolution.
 *
 * One stable signal reaches both the SDK call and the returned stream.
 * Caller aborts map to `ABORTED`; the configured per-read idle watchdog maps
 * to `TIMEOUT`.
 */
export class ShengSuanYunAdapter extends LlmAdapter {
  constructor(private readonly config: ShengSuanYunAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ShengSuanYun' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entries = await this.config.catalog.list()
    return entries.map(entry => catalogModelInfo(provider, entry))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = await this.config.catalog.resolve(model)
    if (entry === undefined) {
      return { provider, id: model, name: model, inputModalities: ['text'] }
    }
    return catalogResolvedModelInfo(provider, entry)
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, watchdog.signal, connection, apiKey)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `ShengSuanYun stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('ShengSuanYun request aborted by caller', 'ABORTED', { cause: error })
      }
      throw toLlmError(error, connection.baseURL)
    } finally {
      consumer.abort('ShengSuanYun stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: ShengSuanYunConnectionOptions,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const resolved = await this.resolveModel(options.provider, options.model)
    const maxTokens = options.maxTokens ?? resolved.defaultMaxTokens ?? connection.maxTokens
    const body = serializeRequest(options, maxTokens)
    const client = new Anthropic({ apiKey, baseURL: connection.baseURL })
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>
    try {
      stream = await client.messages.create(
        { ...body, model: options.model, stream: true } as Anthropic.MessageCreateParamsStreaming,
        { headers: attributionHeaders(), signal },
      )
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw toLlmError(error, connection.baseURL)
    }
    try {
      yield* translate(stream)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw toLlmError(error, connection.baseURL)
    }
  }
}
