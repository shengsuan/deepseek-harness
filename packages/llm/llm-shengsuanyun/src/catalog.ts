/**
 * ShengSuanYun model catalog: fetch, filter, cost mapping, and a
 * short-TTL cache over `GET {modelsURL}`, plus the model-id-prefix
 * reasoning-option table used both for the raw `reasoning` boolean and for
 * mapping `GenerateOptions.reasoningEffort` to the model's underlying wire
 * mechanism (`thinking` or `output_config.effort`).
 *
 * Source of truth: the ShengSuanYun router model-listing endpoint.
 *
 * @module @deepseek-ai/dsh-llm-shengsuanyun/catalog
 */

import { attributionHeaders, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelInfo, LlmModelReasoningInfo, LlmReasoningEffortInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { WireModel, WireModelsResponse } from './types.ts'

/** One reasoning-control axis a model exposes, keyed by its request mechanism. */
export type ReasoningOption =
  | { type: 'toggle' }
  | { type: 'effort'; values: readonly (string | null)[] }
  | { type: 'budget_tokens'; min?: number; max?: number }

const REASONING_OPTIONS_BY_ID_PREFIX: Record<string, ReasoningOption[]> = {
  'deepseek/deepseek-v4': [
    { type: 'toggle' },
    { type: 'effort', values: ['none', 'low', 'high', 'max'] },
  ],
  'deepseek/deepseek-v3': [
    { type: 'toggle' },
    { type: 'effort', values: ['none', 'low', 'high', 'max'] },
  ],
  'openai/gpt-5.': [
    { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  ],
  'ali/qwen3': [{ type: 'toggle' }, { type: 'budget_tokens' }],
  'bigmodel/glm-4.7': [{ type: 'toggle' }],
  'bigmodel/glm-5': [{ type: 'toggle' }],
  'moonshot/kimi': [
    { type: 'effort', values: ['low', 'high', 'max'] },
  ],
  'openai/o': [{ type: 'effort', values: ['low', 'medium', 'high'] }],
  'anthropic/claude': [
    { type: 'budget_tokens', min: 1024 },
    { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  ],
}

/**
 * Look up a model's reasoning-control axes by longest-match-agnostic id prefix.
 * @param id - the ShengSuanYun model id.
 * @returns the declared options, or `undefined` for a model with no reasoning control.
 */
export function getReasoningOptions(id: string): ReasoningOption[] | undefined {
  for (const prefix in REASONING_OPTIONS_BY_ID_PREFIX) {
    if (id.startsWith(prefix)) return REASONING_OPTIONS_BY_ID_PREFIX[prefix]
  }
  return undefined
}

/** Per-token cost, already divided by the wire's 10,000 scaling factor. */
export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One filtered, cost-mapped catalog entry. */
export interface CatalogEntry {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  cost: ModelCost
  reasoning: boolean
  reasoningOptions?: ReasoningOption[]
}

function mapEntry(model: WireModel): CatalogEntry | undefined {
  if (!model.support_apis?.includes('/v1/messages')) return undefined
  const reasoningOptions = getReasoningOptions(model.id)
  return {
    id: model.id,
    name: model.name || model.id,
    contextWindow: model.context_window || 128000,
    maxTokens: model.max_tokens || 4096,
    cost: {
      input:model.pricing.input_price ||0,
      output: model.pricing.output_price ||0,
      cacheRead: 0,
      cacheWrite: model.pricing.cached_price ||0,
    },
    reasoning: reasoningOptions?.some(option => option.type === 'toggle' || option.type === 'effort') ?? false,
    ...reasoningOptions === undefined ? {} : { reasoningOptions },
  }
}

const EFFORT_NAMES: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  default: 'Default',
}

function effortName(value: string): string {
  return EFFORT_NAMES[value] ?? value
}

/**
 * Map a model's reasoning-control axes to the harness's flat selectable list.
 * An `effort` axis wins over `toggle`/`budget_tokens` when both are present
 * (e.g. `anthropic/claude`), since it already carries named, orderable levels.
 * @param options - the model's declared axes, from {@link getReasoningOptions}.
 * @returns the selectable efforts, or `undefined` for a model with no reasoning control.
 */
export function reasoningInfo(options: readonly ReasoningOption[] | undefined): LlmModelReasoningInfo | undefined {
  const effortOption = options?.find((option): option is { type: 'effort'; values: readonly (string | null)[] } => option.type === 'effort')
  if (effortOption !== undefined) {
    const efforts: LlmReasoningEffortInfo[] = effortOption.values
      .filter((value): value is string => value !== null)
      .map(value => ({ id: ReasoningEffortId(value), name: effortName(value) }))
    return { efforts }
  }
  if (options?.some(option => option.type === 'toggle' || option.type === 'budget_tokens') === true) {
    return {
      efforts: [
        { id: ReasoningEffortId('off'), name: 'Off' },
        { id: ReasoningEffortId('on'), name: 'On' },
      ],
    }
  }
  return undefined
}

function toModelInfo(provider: string, entry: CatalogEntry): LlmModelInfo {
  return { provider, id: entry.id, name: entry.name, inputModalities: ['text'] }
}

/**
 * Map a catalog entry to the harness's advisory model listing.
 * @param provider - the provider route id.
 * @param entry - the catalog entry to map.
 * @returns the advisory model listing entry.
 */
export function catalogModelInfo(provider: string, entry: CatalogEntry): LlmModelInfo {
  return toModelInfo(provider, entry)
}

/**
 * Map a catalog entry to a model-discovery reply. Discovery is a
 * configuration-time interrogation the surface offers as adoption candidates,
 * so the reply carries the id plus whatever capacities the catalog discloses —
 * exactly what {@link ModelCatalog.list} already holds.
 * @param entry - the catalog entry to map.
 * @returns the discovered-model candidate.
 */
export function catalogDiscoveredModel(entry: CatalogEntry): LlmDiscoveredModel {
  return {
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  }
}

/**
 * Map a catalog entry to the harness's exact-route resolved model metadata.
 * @param provider - the provider route id.
 * @param entry - the catalog entry to map.
 * @returns the resolved model metadata, including context, default max tokens, and reasoning info.
 */
export function catalogResolvedModelInfo(provider: string, entry: CatalogEntry): LlmResolvedModelInfo {
  const reasoning = reasoningInfo(entry.reasoningOptions)
  return {
    ...toModelInfo(provider, entry),
    context: { contextWindow: entry.contextWindow },
    defaultMaxTokens: entry.maxTokens,
    ...reasoning === undefined ? {} : { reasoning },
  }
}

async function fetchCatalog(modelsURL: string, signal?: AbortSignal): Promise<CatalogEntry[]> {
  let response: Response
  try {
    response = await fetch(modelsURL, { headers: { ...attributionHeaders() }, ...signal === undefined ? {} : { signal } })
  } catch (error: unknown) {
    throw new LlmError(`ShengSuanYun model listing request to ${modelsURL} failed`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(`ShengSuanYun model listing returned HTTP ${response.status}`, `HTTP_${response.status}`, { status: response.status })
  }
  const body = await response.json() as WireModelsResponse
  const entries: CatalogEntry[] = []
  for (const model of body.data ?? []) {
    const entry = mapEntry(model)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

const CACHE_TTL_MS = 5 * 60_000

/**
 * TTL-cached, single-flight view over the ShengSuanYun model-listing
 * endpoint. A refetch failure with an existing cache logs (via the
 * constructor callback) and keeps serving the stale entries; a failure on
 * the very first fetch propagates.
 */
export class ModelCatalog {
  private entries: CatalogEntry[] = []
  private expiresAt = 0
  private pending: Promise<readonly CatalogEntry[]> | undefined

  constructor(
    private readonly modelsURL: () => string,
    private readonly onStaleRefetchError: (error: unknown) => void,
  ) {}

  private refresh(): Promise<readonly CatalogEntry[]> {
    if (this.pending !== undefined) return this.pending
    const pending = fetchCatalog(this.modelsURL()).then(
      (entries) => {
        this.entries = entries
        this.expiresAt = Date.now() + CACHE_TTL_MS
        this.pending = undefined
        return entries
      },
      (error: unknown) => {
        this.pending = undefined
        if (this.entries.length > 0) {
          this.onStaleRefetchError(error)
          this.expiresAt = Date.now() + CACHE_TTL_MS
          return this.entries
        }
        throw error
      },
    )
    this.pending = pending
    return pending
  }

  /**
   * List the cached catalog entries, refreshing first when the cache has expired.
   * @returns the cached (or freshly fetched) catalog entries.
   */
  list(): Promise<readonly CatalogEntry[]> {
    if (Date.now() < this.expiresAt) return Promise.resolve(this.entries)
    return this.refresh()
  }

  /**
   * Resolve one model id against the cached catalog.
   * @param id - the ShengSuanYun model id to look up.
   * @returns the matching catalog entry, or `undefined` when the id is not listed.
   */
  async resolve(id: string): Promise<CatalogEntry | undefined> {
    const entries = await this.list()
    return entries.find(entry => entry.id === id)
  }
}
