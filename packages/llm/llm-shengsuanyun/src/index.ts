/**
 * Register a {@link ShengSuanYunAdapter} for the `shengsuanyun` provider route
 * on `ctx.llm`, with connection facts resolved per request instead of frozen
 * at load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-shengsuanyun` user-settings section (`ctx.settings`) and resolves the
 * API key through the optional credential seam (`ctx.credentials`), so a
 * changed base URL or key reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with. The
 * one registration-captured fact — the retry policy — re-registers the route
 * in place when it changes.
 * @module @deepseek-ai/dsh-llm-shengsuanyun
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ShengSuanYunAdapter,
} from './adapter.ts'
import type { ShengSuanYunConnectionOptions } from './adapter.ts'
import { ModelCatalog, catalogDiscoveredModel } from './catalog.ts'

export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ShengSuanYunAdapter,
  toLlmError,
} from './adapter.ts'
export type { ShengSuanYunAdapterOptions, ShengSuanYunConnectionOptions } from './adapter.ts'
export * from './catalog.ts'
export * from './translate.ts'
export type * from './types.ts'

export const name = 'llm-shengsuanyun'
export const inject = ['llm']

const NS = settingsNamespace('llm-shengsuanyun')
const DEFAULT_API_KEY_ENV = 'SHENGSUANYUN_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'shengsuanyun'

/** Public Anthropic-Messages-compatible endpoint base; the SDK appends `/v1/messages`. */
export const PUBLIC_BASE_URL = 'https://router.shengsuanyun.com/api'
/** Public model-listing endpoint. */
export const PUBLIC_MODELS_URL = 'https://router.shengsuanyun.com/api/v1/models'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'SHENGSUANYUN_BASE_URL'

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-shengsuanyun` settings-section shape. Every field is optional
 * in yml: a missing API key resolves through {@link Config.apiKeyEnv} at each
 * request (a request without any key fails with `MISSING_CREDENTIAL`, not at
 * plugin load).
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `SHENGSUANYUN_API_KEY`. */
  apiKeyEnv?: string
  /** Anthropic Messages endpoint base; falls back to $SHENGSUANYUN_BASE_URL from a trusted environment layer, then the public router. */
  baseURL?: string
  /** Model-listing endpoint; defaults to the public router's `/v1/models`. */
  modelsURL?: string
  /** Default per-request output cap, used only when a model advertises none (default 8,192). */
  maxTokens?: number
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  modelsURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/**
 * One resolution's complete request facts. Connection and credential facts
 * are one value on purpose: a snapshot the resolver rejects keeps the whole
 * previous generation, so a request can never pair a stale endpoint with a
 * newer key.
 */
export type ResolvedShengSuanYunOptions = ShengSuanYunConnectionOptions

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI. Every layer may supply an endpoint: the product trusts the
 * project it is launched in, so a checkout can point its own agent at the
 * gateway that checkout is meant to use.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedShengSuanYunOptions {
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-shengsuanyun: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-shengsuanyun: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    baseURL: config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? PUBLIC_BASE_URL,
    modelsURL: config.modelsURL ?? PUBLIC_MODELS_URL,
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-shengsuanyun: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedShengSuanYunOptions | undefined
  const options = (): ResolvedShengSuanYunOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-shengsuanyun: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: ResolvedShengSuanYunOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-shengsuanyun', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-shengsuanyun', ref)
      }
    }
    throw new LlmError(
      `llm-shengsuanyun: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const catalog = new ModelCatalog(
    () => options().modelsURL,
    (error) => {
      ctx.logger.error('llm-shengsuanyun: keeping the last good model catalog after a failed refetch')
      ctx.logger.error(error)
    },
  )
  const adapter = new ShengSuanYunAdapter({ options, resolveApiKey, catalog })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'ShengSuanYun', settingsNs: NS, settingsPath: [] },
  ])
  // The Models page's "fetch models" action interrogates through discoverModels.
  // This route's answer is the shared TTL-cached catalog — no second fetch and
  // no endpoint needed, mirroring how a pi-ai catalog route answers from its own
  // registry. The catalog endpoint is the plugin's own `modelsURL`, not the
  // draft's `baseURL`, so a probe's baseURL is intentionally ignored.
  ctx.llm.registerModelDiscovery(NS, async () => {
    const entries = await catalog.list()
    return entries.map(catalogDiscoveredModel)
  })
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two, and an observer that reacted
    // to it would see this provider disappear and come back.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
