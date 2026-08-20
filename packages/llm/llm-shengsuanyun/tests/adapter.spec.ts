import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Anthropic from '@anthropic-ai/sdk'
import LlmRuntime, {
  createUserMessage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as LlmShengSuanYun from '@deepseek-ai/dsh-llm-shengsuanyun'
import { ShengSuanYunAdapter, toLlmError } from '@deepseek-ai/dsh-llm-shengsuanyun'
import { ModelCatalog } from '../src/catalog.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import type { Behavior } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function harness(baseURL: string, config: object = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmShengSuanYun, { baseURL, modelsURL: `${baseURL}/v1/models`, apiKeyEnv: 'test_key_env', ...config })
  return ctx
}

/** Direct adapter over a static resolver, bypassing plugin/settings composition. */
function adapterOf(config: Partial<LlmShengSuanYun.ShengSuanYunConnectionOptions> & { apiKey?: string } = {}): ShengSuanYunAdapter {
  const { apiKey, ...rest } = config
  const connection: LlmShengSuanYun.ShengSuanYunConnectionOptions = {
    baseURL: 'http://127.0.0.1:1',
    modelsURL: 'http://127.0.0.1:1/v1/models',
    apiKeyEnv: credentialRef('SHENGSUANYUN_API_KEY'),
    maxTokens: 8_192,
    streamIdleTimeoutMs: 300_000,
    retryPolicy: { mode: 'always', initialDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.25 },
    ...rest,
  }
  return new ShengSuanYunAdapter({
    options: () => connection,
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
    catalog: new ModelCatalog(() => connection.modelsURL, () => {}),
  })
}

function noRetryHeaders(): Record<string, string> {
  return { 'x-should-retry': 'false' }
}

describe('ShengSuanYunAdapter against a mock server', () => {
  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, {
      model: 'anthropic/claude-test',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })

    expect(server.requests[0]).toMatchObject({
      model: 'anthropic/claude-test',
      max_tokens: 8_192,
      stream: true,
    })
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
    expect(server.headers[0]?.authorization).toBeUndefined()
    expect(server.headers[0]?.['x-api-key']).toBe('k')
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 2 }])
    const ctx = await harness(server.url)

    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'shengsuanyun',
      model: 'anthropic/claude-test',
      messages: [],
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('uses the configured maxTokens default and preserves an explicit request cap', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const ctx = await harness(server.url, { maxTokens: 32_000 })

    await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    await assemble(ctx, { model: 'anthropic/claude-test', messages: [], maxTokens: 4_096 })

    expect(server.requests[0]).toMatchObject({ max_tokens: 32_000 })
    expect(server.requests[1]).toMatchObject({ max_tokens: 4_096 })
  })

  it('prefers a resolved model default cap over the adapter-wide default', async () => {
    const catalogServer = await mockServer([])
    // wireModel default max_tokens is 8_192, distinct from the adapter default.
    const modelsServer = await (await import('./mock-server.ts')).mockModelsServer({
      data: [(await import('./mock-server.ts')).wireModel({ id: 'anthropic/claude-test', max_tokens: 2_048 })],
    })
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { modelsURL: modelsServer.url, maxTokens: 32_000 })

    await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(server.requests[0]).toMatchObject({ max_tokens: 2_048 })
    await catalogServer.close()
  })

  it('falls back to {provider, id, name, inputModalities} for an unlisted model', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    await expect(ctx.llm.resolveModelInfo('shengsuanyun', 'unlisted/model'))
      .resolves.toEqual({ provider: 'shengsuanyun', id: 'unlisted/model', name: 'unlisted/model', inputModalities: ['text'] })
  })

  it('lists and resolves models through the catalog', async () => {
    const { mockModelsServer, wireModel } = await import('./mock-server.ts')
    const modelsServer = await mockModelsServer({
      data: [wireModel({ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' })],
    })
    const server = await mockServer([])
    const ctx = await harness(server.url, { modelsURL: modelsServer.url })

    await expect(ctx.llm.listModels('shengsuanyun')).resolves.toEqual([
      { provider: 'shengsuanyun', id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', inputModalities: ['text'] },
    ])
    await expect(ctx.llm.resolveModelInfo('shengsuanyun', 'anthropic/claude-opus-5'))
      .resolves.toMatchObject({ name: 'Claude Opus 5', context: { contextWindow: 200_000 } })
  })

  it('answers model discovery from the shared catalog', async () => {
    const { mockModelsServer, wireModel } = await import('./mock-server.ts')
    const modelsServer = await mockModelsServer({
      data: [wireModel({ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' })],
    })
    const server = await mockServer([])
    const ctx = await harness(server.url, { modelsURL: modelsServer.url })

    await expect(ctx.llm.discoverModels('llm-shengsuanyun', { provider: 'shengsuanyun' })).resolves.toEqual([
      { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', contextWindow: 200_000, maxTokens: 8_192 },
    ])
  })

  it.each([
    [400, 'INVALID_REQUEST'],
    [404, 'HTTP_404'],
    [422, 'HTTP_422'],
  ])('maps HTTP %d to failure code %s with the body message', async (status, code) => {
    const behavior: Behavior = {
      kind: 'http-error',
      status,
      body: JSON.stringify({ error: { message: `failed with ${status}`, type: 't' } }),
      headers: noRetryHeaders(),
    }
    const server = await mockServer([behavior])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: `failed with ${status}`, code, status },
    })
  })

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
  ])('maps HTTP %d to AUTH', async (status, code) => {
    const behavior: Behavior = {
      kind: 'http-error',
      status,
      body: JSON.stringify({ error: { message: `no access ${status}` } }),
      headers: noRetryHeaders(),
    }
    const server = await mockServer([behavior])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: `no access ${status}`, code, status },
    })
  })

  it('maps HTTP 500 to SERVER', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 500,
      body: JSON.stringify({ error: { message: 'internal failure' } }),
      headers: noRetryHeaders(),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: 'internal failure', code: 'SERVER', status: 500 },
    })
  })

  it('maps HTTP 429 to RATE_LIMIT with the Retry-After seconds and request id', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: JSON.stringify({ error: { message: 'slow down' } }),
      headers: { ...noRetryHeaders(), 'retry-after': '2', 'request-id': 'req-429' },
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'slow down',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 2_000,
        requestId: ProviderRequestId('req-429'),
      },
    })
  })

  it('omits providerRetryAfterMs and requestId when absent', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: JSON.stringify({ error: { message: 'slow down' } }),
      headers: noRetryHeaders(),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: 'slow down', code: 'RATE_LIMIT', status: 429 },
    })
  })

  it('classifies an HTTP context-window failure with the canonical code', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 400,
      body: JSON.stringify({
        error: {
          message: 'This model maximum context length is 128000 tokens; your input exceeds that limit.',
          type: 'invalid_request_error',
        },
      }),
      headers: noRetryHeaders(),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    })
  })

  it('classifies an HTTP quota failure with the canonical code', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 400,
      body: JSON.stringify({ error: { message: 'insufficient quota for this account', type: 'invalid_request_error' } }),
      headers: noRetryHeaders(),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: QUOTA_EXCEEDED_CODE },
    })
  })

  it('keeps the status-line message for non-JSON error bodies', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 500,
      body: 'Bad Gateway',
      contentType: 'text/plain',
      headers: noRetryHeaders(),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.code).toBe('SERVER')
    expect(result.finish.failure.message).toBe('Bad Gateway')
  })

  it('reports a transport failure with the endpoint in the message', async () => {
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: {
        code: 'TRANSPORT',
        message: 'ShengSuanYun API request to http://127.0.0.1:1 failed',
      },
    })
  })

  it('classifies an aborted request as an aborted finish', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, {
      model: 'anthropic/claude-test',
      messages: [],
      signal: controller.signal,
    })
    expect(result.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  })

  it('aborts mid-stream via the request signal', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 50 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()

    const pending = (async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({
        provider: 'shengsuanyun',
        model: 'anthropic/claude-test',
        messages: [],
        signal: controller.signal,
      })) {
        chunks.push(chunk)
      }
      return chunks
    })()

    setTimeout(() => { controller.abort() }, 30)
    const chunks = await pending
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('finish')
    if (chunks[0]?.type !== 'finish') throw new Error('expected a finish chunk')
    expect(chunks[0].reason.kind).toBe('aborted')
    if (chunks[0].reason.kind !== 'aborted') throw new Error('expected an aborted finish')
    expect(chunks[0].reason.failure.code).toBe('ABORTED')
  })

  it('maps connection failures to TRANSPORT without losing the cause', async () => {
    const cause = new TypeError('connection refused')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause)
    const adapter = adapterOf({ baseURL: 'https://example.invalid' })
    try {
      const drain = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'shengsuanyun', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(drain()).rejects.toMatchObject({ code: 'TRANSPORT', cause })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('aborts the underlying body when the stream stays idle past its watchdog', async () => {
    vi.useFakeTimers()
    let stopped = false
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            stopped = true
            controller.error(signal.reason)
          }, { once: true })
        },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    })
    const adapter = adapterOf({ baseURL: 'https://example.invalid', streamIdleTimeoutMs: 100 })
    try {
      const drain = (async () => {
        for await (const _chunk of adapter.stream({ provider: 'shengsuanyun', model: 'm', messages: [] })) { /* drain */ }
      })()
      const rejected = expect(drain).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      expect(stopped).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('resolves connection facts and the credential exactly once per stream call', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const connection: LlmShengSuanYun.ShengSuanYunConnectionOptions = {
      baseURL: server.url,
      modelsURL: `${server.url}/v1/models`,
      apiKeyEnv: credentialRef('SHENGSUANYUN_API_KEY'),
      maxTokens: 8_192,
      streamIdleTimeoutMs: 300_000,
      retryPolicy: { mode: 'always', initialDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.25 },
    }
    const options = vi.fn(() => connection)
    const resolveApiKey = vi.fn(() => Promise.resolve('per-request-key'))
    const adapter = new ShengSuanYunAdapter({
      options,
      resolveApiKey,
      catalog: new ModelCatalog(() => connection.modelsURL, () => {}),
    })

    for await (const _chunk of adapter.stream({ provider: 'shengsuanyun', model: 'm', messages: [] })) { /* drain */ }

    expect(options).toHaveBeenCalledTimes(1)
    expect(resolveApiKey).toHaveBeenCalledTimes(1)
    expect(server.headers[0]?.['x-api-key']).toBe('per-request-key')
  })
})

describe('toLlmError', () => {
  it('passes an already-normalized LlmError through unchanged', () => {
    const error = new LlmError('already normalized', 'SOME_CODE')
    expect(toLlmError(error, 'https://example.invalid')).toBe(error)
  })

  it('maps APIUserAbortError to ABORTED', () => {
    const cause = new Anthropic.APIUserAbortError()
    const mapped = toLlmError(cause, 'https://example.invalid')
    expect(mapped).toMatchObject({ code: 'ABORTED', cause })
  })

  it('maps APIConnectionTimeoutError to TIMEOUT with the endpoint in the message', () => {
    const cause = new Anthropic.APIConnectionTimeoutError()
    const mapped = toLlmError(cause, 'https://example.invalid')
    expect(mapped).toMatchObject({
      code: 'TIMEOUT',
      message: 'ShengSuanYun API request to https://example.invalid timed out',
      cause,
    })
  })

  it('maps APIConnectionError to TRANSPORT with the endpoint in the message', () => {
    const cause = new Anthropic.APIConnectionError({ message: 'offline' })
    const mapped = toLlmError(cause, 'https://example.invalid')
    expect(mapped).toMatchObject({
      code: 'TRANSPORT',
      message: 'ShengSuanYun API request to https://example.invalid failed',
      cause,
    })
  })

  it('maps a non-Anthropic thrown value to TRANSPORT, preserving it as the cause', () => {
    const mapped = toLlmError('offline', 'https://example.invalid')
    expect(mapped).toMatchObject({
      code: 'TRANSPORT',
      message: 'ShengSuanYun API request to https://example.invalid failed',
      cause: 'offline',
    })
  })

  it('omits status and requestId when the SDK error carries neither', () => {
    const cause = Anthropic.APIError.generate(undefined, undefined, 'no status', undefined)
    const mapped = toLlmError(cause, 'https://example.invalid')
    expect(mapped.failure).not.toHaveProperty('status')
    expect(mapped.failure).not.toHaveProperty('requestId')
  })

  it('maps an unrecognized APIError subclass status to HTTP_<status>', () => {
    const cause = Anthropic.APIError.generate(418, { error: { message: 'teapot' } }, undefined, new Headers())
    const mapped = toLlmError(cause, 'https://example.invalid')
    expect(mapped).toMatchObject({ code: 'HTTP_418', message: '418 teapot' })
  })
})

describe('plugin registration and config', () => {
  it('keeps wire helpers off the package root', () => {
    for (const helper of [
      'serializeMessages',
      'serializeRequest',
      'serializeTools',
      'translate',
      'mapStopReason',
      'mapUsage',
      'resolveReasoning',
    ]) expect(LlmShengSuanYun).not.toHaveProperty(helper)
  })

  it('registers the shengsuanyun provider and unregisters on dispose (HMR safety)', async () => {
    const server = await mockServer([])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmShengSuanYun, { baseURL: server.url })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'shengsuanyun', name: 'ShengSuanYun' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'shengsuanyun',
      displayName: 'ShengSuanYun',
      settingsNs: 'llm-shengsuanyun',
      settingsPath: [],
    }])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('registers retryPolicy from the provider config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmShengSuanYun, {
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: {
        mode: 'always',
        backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
      },
    })

    expect(ctx.llm.providerRetryPolicy('shengsuanyun')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
  })

  it('re-registers the route in place when the captured retry policy changes', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmShengSuanYun, { baseURL: 'http://127.0.0.1:1' })

    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })

    await fiber.update({
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })

    expect(ctx.llm.providerRetryPolicy('shengsuanyun')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'shengsuanyun', name: 'ShengSuanYun' }])
    expect(observed).toEqual([['shengsuanyun']])
  })

  it('uses the default public endpoints when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    LlmShengSuanYun.apply(ctx, {})
    expect(ctx.llm.listProviders()).toEqual([{ id: 'shengsuanyun', name: 'ShengSuanYun' }])
  })

  it('rejects invalid maxTokens before registering the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmShengSuanYun, {
      baseURL: 'http://127.0.0.1:1',
      maxTokens: 0,
    })).rejects.toThrow()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('rejects invalid streamIdleTimeoutMs before registering the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmShengSuanYun, {
      baseURL: 'http://127.0.0.1:1',
      streamIdleTimeoutMs: 0,
    })).rejects.toThrow()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('rejects invalid nested retryPolicy before registering the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmShengSuanYun, {
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: { mode: 'normal', maxRetries: -1 },
    })).rejects.toThrow(/retryPolicy/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('falls back to SHENGSUANYUN_BASE_URL from the environment', async () => {
    vi.stubEnv('SHENGSUANYUN_BASE_URL', 'http://127.0.0.1:1')
    try {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmShengSuanYun, {})
      expect(ctx.llm.listProviders()).toEqual([{ id: 'shengsuanyun', name: 'ShengSuanYun' }])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('prefers explicit config baseURL over the environment', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('SHENGSUANYUN_BASE_URL', 'http://127.0.0.1:1')
    vi.stubEnv('SHENGSUANYUN_API_KEY', 'test-key')
    try {
      const ctx = await harness(server.url)
      await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
      expect(server.requests).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reads the ambient variable when no credentials seam is mounted', async () => {
    vi.stubEnv('SHENGSUANYUN_API_KEY', 'ambient-key')
    try {
      const server = await mockServer([{ kind: 'sse', events: textEvents }])
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmShengSuanYun, { baseURL: server.url })
      await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
      expect(server.headers[0]?.['x-api-key']).toBe('ambient-key')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('treats an empty ambient variable as no key when no credentials seam is mounted', async () => {
    vi.stubEnv('SHENGSUANYUN_API_KEY', '')
    try {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmShengSuanYun, { baseURL: 'http://127.0.0.1:1' })
      const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
      expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('names both credential sources in the missing-credential message', async () => {
    vi.stubEnv('SHENGSUANYUN_API_KEY', '')
    try {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmShengSuanYun, { baseURL: 'http://127.0.0.1:1' })
      const result = await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
      expect(result.finish.kind).toBe('error')
      if (result.finish.kind !== 'error') throw new Error('expected an error finish')
      expect(result.finish.failure.message)
        .toMatch(/store SHENGSUANYUN_API_KEY through the credentials.*export SHENGSUANYUN_API_KEY/s)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps the last good configuration after an invalid settings snapshot', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('SHENGSUANYUN_API_KEY', 'test-key')
    try {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      const fiber = await ctx.plugin(LlmShengSuanYun, { baseURL: server.url })
      await fiber.update({ baseURL: server.url, maxTokens: -1 } as unknown as LlmShengSuanYun.Config)
      await assemble(ctx, { model: 'anthropic/claude-test', messages: [] })
      expect(server.requests).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('adapter is constructible directly for embedding over a static resolver', async () => {
    const adapter = adapterOf()
    expect(adapter).toBeInstanceOf(ShengSuanYunAdapter)
    expect(adapter.providerInfo('shengsuanyun')).toEqual({ id: 'shengsuanyun', name: 'ShengSuanYun' })
  })
})
