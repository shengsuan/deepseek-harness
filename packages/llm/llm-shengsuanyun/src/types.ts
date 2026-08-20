/**
 * ShengSuanYun model-listing wire format. Types only.
 *
 * Source of truth: `GET https://router.shengsuanyun.com/api/v1/models` as
 * documented in the ShengSuanYun router API reference.
 *
 * @module @deepseek-ai/dsh-llm-shengsuanyun/types
 */

/** One model entry as returned by `GET {modelsURL}`. */
export interface WireModel {
  id: string
  name: string
  max_tokens: number
  context_window: number
  supports_prompt_cache?: boolean
  pricing: {
    prompt?: number
    completion?: number
    cache?: number
    image?: number
    request?: number
  }
  architecture: {
    input: string
    output: string
    tokenizer: string
  }
  support_apis?: string[]
}

/** Response envelope for `GET {modelsURL}`. */
export interface WireModelsResponse {
  data?: WireModel[]
}
