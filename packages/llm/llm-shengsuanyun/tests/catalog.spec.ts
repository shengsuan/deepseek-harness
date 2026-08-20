import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  catalogModelInfo,
  catalogResolvedModelInfo,
  getReasoningOptions,
  ModelCatalog,
  reasoningInfo,
} from '../src/catalog.ts'
import type { CatalogEntry } from '../src/catalog.ts'
import { closeMockServers, mockModelsServer, wireModel } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllGlobals()
})

describe('getReasoningOptions', () => {
  it('matches by model id prefix', () => {
    expect(getReasoningOptions('deepseek/deepseek-v4-flash')).toEqual([
      { type: 'toggle' },
      { type: 'effort', values: ['none', 'low', 'high', 'max'] },
    ])
    expect(getReasoningOptions('openai/gpt-5.1')).toEqual([
      { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ])
    expect(getReasoningOptions('ali/qwen3-max')).toEqual([{ type: 'toggle' }, { type: 'budget_tokens' }])
    expect(getReasoningOptions('anthropic/claude-opus-5')).toEqual([
      { type: 'budget_tokens', min: 1024 },
      { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ])
  })

  it('returns undefined for a model with no declared reasoning axes', () => {
    expect(getReasoningOptions('unknown/model')).toBeUndefined()
  })
})

describe('reasoningInfo', () => {
  it('returns undefined for a model with no reasoning control', () => {
    expect(reasoningInfo(undefined)).toBeUndefined()
    expect(reasoningInfo([])).toBeUndefined()
  })

  it('maps a toggle axis to off/on efforts', () => {
    expect(reasoningInfo([{ type: 'toggle' }])).toEqual({
      efforts: [
        { id: ReasoningEffortId('off'), name: 'Off' },
        { id: ReasoningEffortId('on'), name: 'On' },
      ],
    })
  })

  it('maps a budget_tokens axis to off/on efforts', () => {
    expect(reasoningInfo([{ type: 'budget_tokens', min: 1024 }])).toEqual({
      efforts: [
        { id: ReasoningEffortId('off'), name: 'Off' },
        { id: ReasoningEffortId('on'), name: 'On' },
      ],
    })
  })

  it('maps an effort axis to its named, ordered levels', () => {
    expect(reasoningInfo([{ type: 'effort', values: ['low', 'high', 'max'] }])).toEqual({
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('high'), name: 'High' },
        { id: ReasoningEffortId('max'), name: 'Max' },
      ],
    })
  })

  it('drops null placeholder values from an effort axis', () => {
    expect(reasoningInfo([{ type: 'effort', values: ['low', null, 'high'] }])).toEqual({
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
    })
  })

  it('falls back to the raw value for an unnamed effort', () => {
    expect(reasoningInfo([{ type: 'effort', values: ['ultra'] }])).toEqual({
      efforts: [{ id: ReasoningEffortId('ultra'), name: 'ultra' }],
    })
  })

  it('prefers the effort axis over budget_tokens when a model declares both (anthropic/claude)', () => {
    const options = getReasoningOptions('anthropic/claude-opus-5')
    expect(reasoningInfo(options)).toEqual({
      efforts: [
        { id: ReasoningEffortId('none'), name: 'None' },
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
        { id: ReasoningEffortId('xhigh'), name: 'Extra High' },
        { id: ReasoningEffortId('max'), name: 'Max' },
      ],
    })
  })
})

describe('catalogModelInfo and catalogResolvedModelInfo', () => {
  const entry: CatalogEntry = {
    id: 'anthropic/claude-opus-5',
    name: 'Claude Opus 5',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 35, output: 175, cacheRead: 0, cacheWrite: 3.5 },
    reasoning: true,
    reasoningOptions: [{ type: 'budget_tokens', min: 1024 }, { type: 'effort', values: ['low', 'high'] }],
  }

  it('maps the advisory listing shape', () => {
    expect(catalogModelInfo('shengsuanyun', entry)).toEqual({
      provider: 'shengsuanyun',
      id: 'anthropic/claude-opus-5',
      name: 'Claude Opus 5',
      inputModalities: ['text'],
    })
  })

  it('maps the resolved shape with context, default cap, and reasoning', () => {
    expect(catalogResolvedModelInfo('shengsuanyun', entry)).toEqual({
      provider: 'shengsuanyun',
      id: 'anthropic/claude-opus-5',
      name: 'Claude Opus 5',
      inputModalities: ['text'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 128_000,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
      },
    })
  })

  it('omits the reasoning field for a model with no axes', () => {
    const plain: CatalogEntry = {
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      cost: entry.cost,
      reasoning: false,
    }
    expect(catalogResolvedModelInfo('shengsuanyun', plain)).not.toHaveProperty('reasoning')
  })
})

describe('ModelCatalog against a mock model-listing endpoint', () => {
  it('filters to /v1/messages-capable models, scales cost, and falls back missing context/cap', async () => {
    const server = await mockModelsServer({
      data: [
        wireModel({ id: 'a/kept', name: 'Kept', support_apis: ['/v1/messages', '/v1/chat/completions'] }),
        wireModel({ id: 'b/dropped', support_apis: ['/v1/chat/completions'] }),
        wireModel({ id: 'c/no-apis', support_apis: undefined }),
        wireModel({
          id: 'd/fallbacks',
          name: '',
          max_tokens: 0,
          context_window: 0,
          pricing: {},
        }),
      ],
    })
    const catalog = new ModelCatalog(() => server.url, () => {})
    const entries = await catalog.list()
    expect(entries.map(entry => entry.id)).toEqual(['a/kept', 'd/fallbacks'])
    const kept = entries[0]
    expect(kept).toMatchObject({ name: 'Kept', cost: { input: 35, output: 175, cacheRead: 0, cacheWrite: 3.5 } })
    const fallback = entries[1]
    expect(fallback).toMatchObject({
      name: 'd/fallbacks',
      contextWindow: 4096,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('resolves a listed model id and returns undefined for an unlisted one', async () => {
    const server = await mockModelsServer({ data: [wireModel({ id: 'a/listed' })] })
    const catalog = new ModelCatalog(() => server.url, () => {})
    await expect(catalog.resolve('a/listed')).resolves.toMatchObject({ id: 'a/listed' })
    await expect(catalog.resolve('a/unlisted')).resolves.toBeUndefined()
  })

  it('caches entries within the TTL and does not refetch', async () => {
    const server = await mockModelsServer({ data: [wireModel({ id: 'a/one' })] })
    const catalog = new ModelCatalog(() => server.url, () => {})
    await catalog.list()
    await catalog.list()
    expect(server.requests).toHaveLength(1)
  })

  it('refetches once the TTL expires', async () => {
    vi.useFakeTimers()
    try {
      const server = await mockModelsServer({ data: [wireModel({ id: 'a/one' })] })
      const catalog = new ModelCatalog(() => server.url, () => {})
      await catalog.list()
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
      await catalog.list()
      expect(server.requests).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('single-flights concurrent refreshes into one fetch', async () => {
    const server = await mockModelsServer({ data: [wireModel({ id: 'a/one' })] })
    const catalog = new ModelCatalog(() => server.url, () => {})
    const [first, second] = await Promise.all([catalog.list(), catalog.list()])
    expect(first).toBe(second)
    expect(server.requests).toHaveLength(1)
  })

  it('propagates a refetch failure when there is no cached entry yet', async () => {
    const catalog = new ModelCatalog(() => 'http://127.0.0.1:1', () => {})
    await expect(catalog.list()).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('serves stale entries and reports the error when a refetch fails after a successful fetch', async () => {
    vi.useFakeTimers()
    try {
      const server = await mockModelsServer({ data: [wireModel({ id: 'a/one' })] })
      const onStaleRefetchError = vi.fn()
      const catalog = new ModelCatalog(() => server.url, onStaleRefetchError)
      const first = await catalog.list()
      await server.close()
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
      const second = await catalog.list()
      expect(second).toEqual(first)
      expect(onStaleRefetchError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps a transport failure to LlmError TRANSPORT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    const catalog = new ModelCatalog(() => 'https://example.invalid/models', () => {})
    await expect(catalog.list()).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('maps a non-ok HTTP response to LlmError HTTP_<status>', async () => {
    const server = await mockModelsServer({ data: [] }, 503)
    const catalog = new ModelCatalog(() => server.url, () => {})
    await expect(catalog.list()).rejects.toMatchObject({ code: 'HTTP_503', failure: { status: 503 } })
  })

  it('treats a missing data field as an empty catalog', async () => {
    const server = await mockModelsServer({})
    const catalog = new ModelCatalog(() => server.url, () => {})
    await expect(catalog.list()).resolves.toEqual([])
  })
})

describe('fetchCatalog error construction', () => {
  it('is an LlmError instance for both failure modes', async () => {
    const catalog = new ModelCatalog(() => 'http://127.0.0.1:1', () => {})
    await expect(catalog.list()).rejects.toBeInstanceOf(LlmError)
  })
})
