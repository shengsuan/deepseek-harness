/**
 * Translate between the harness's provider-neutral vocabulary and the
 * Anthropic Messages API: outbound `Message[]`/`ToolSchema[]` serialization,
 * and inbound `RawMessageStreamEvent` → `StreamChunk` translation.
 *
 * Source of truth: `@anthropic-ai/sdk`'s own type declarations
 * (`resources/messages/messages.d.ts`), which is also the wire format
 * ShengSuanYun's router documents itself as compatible with.
 *
 * @module @deepseek-ai/dsh-llm-shengsuanyun/translate
 */

import Anthropic from '@anthropic-ai/sdk'
import { CallId, contentHasImage, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, ReplayEnvelope, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { getReasoningOptions } from './catalog.ts'

type MessageParam = Anthropic.MessageParam
type ContentBlockParam = Anthropic.ContentBlockParam
type Tool = Anthropic.Tool
type ThinkingConfigParam = Anthropic.ThinkingConfigParam
type RawMessageStreamEvent = Anthropic.RawMessageStreamEvent
type AnthropicContentBlock = Anthropic.ContentBlock

/** Adapter-owned per-model reasoning-request resolution for one request. */
export interface ResolvedReasoning {
  thinking?: ThinkingConfigParam
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'default'
}

const EFFORT_VALUES = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'default'])

/**
 * Resolve one model's reasoning-control axes and a request's chosen effort
 * into the exact Anthropic request fields to send.
 * @param modelId - the ShengSuanYun model id, used to look up its axes.
 * @param effort - the harness-selected reasoning effort id, if any.
 * @param maxTokens - the request's resolved `max_tokens`, bounding a `budget_tokens` thinking config.
 * @returns the wire fields to merge into the request; throws `UNSUPPORTED_REASONING_EFFORT` for an unrecognized id.
 */
export function resolveReasoning(
  modelId: string,
  effort: GenerateOptions['reasoningEffort'],
  maxTokens: number,
): ResolvedReasoning {
  const options = getReasoningOptions(modelId)
  if (options === undefined) {
    if (effort !== undefined) {
      throw new LlmError(`ShengSuanYun model "${modelId}" does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
    }
    return {}
  }
  const effortOption = options.find((option): option is { type: 'effort'; values: readonly (string | null)[] } => option.type === 'effort')
  if (effortOption !== undefined) {
    if (effort === undefined) return {}
    if (!EFFORT_VALUES.has(effort) || !effortOption.values.includes(effort)) {
      throw new LlmError(`ShengSuanYun model "${modelId}" does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
    }
    const resolved: ResolvedReasoning = { effort: effort as Exclude<ResolvedReasoning['effort'], undefined> }
    return resolved
  }
  const budgetOption = options.find((option): option is { type: 'budget_tokens'; min?: number; max?: number } => option.type === 'budget_tokens')
  if (effort === undefined) return {}
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  if (effort === 'on') {
    if (budgetOption !== undefined) {
      const min = budgetOption.min ?? 1024
      const budget = Math.min(min, Math.max(1024, maxTokens - 1))
      return { thinking: { type: 'enabled', budget_tokens: budget } }
    }
    return { thinking: { type: 'adaptive' } }
  }
  throw new LlmError(`ShengSuanYun model "${modelId}" does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The ShengSuanYun adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function serializeAssistantLossy(message: Message): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool-call') {
      blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: JSON.parse(block.arguments) })
    }
  }
  return blocks
}

function isReplayEnvelope(value: unknown): value is ReplayEnvelope {
  return typeof value === 'object' && value !== null && 'response' in value
}

function serializeAssistant(message: Message): MessageParam {
  const replayState = message.source.kind === 'model' ? message.source.replayState : undefined
  const blocks = isReplayEnvelope(replayState) ? replayState.blocks : undefined
  const content = Array.isArray(blocks)
    ? blocks as ContentBlockParam[]
    : serializeAssistantLossy(message)
  return { role: 'assistant', content }
}

function serializeToolResult(message: Message): MessageParam {
  const block = message.content[0]
  if (block === undefined || block.type !== 'tool-result') {
    throw new LlmError('Expected a tool-result message', 'MALFORMED_RESPONSE')
  }
  assertTextOnly(block.content)
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: block.toolCallId,
      content: flattenText(block.content) || '(no output)',
      ...block.isError === true ? { is_error: true } : {},
    }],
  }
}

/**
 * Serialize the conversation into Anthropic `MessageParam[]`. `tool-result`
 * blocks become standalone user-role tool_result messages, mirroring the
 * harness's one-result-per-message vocabulary.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved.
 */
export function serializeMessages(messages: readonly Message[]): MessageParam[] {
  const wire: MessageParam[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'assistant') {
      assertTextOnly(message.content)
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResult = message.content.find(block => block.type === 'tool-result')
    if (toolResult !== undefined) {
      wire.push(serializeToolResult(message))
      continue
    }
    assertTextOnly(message.content)
    wire.push({ role: 'user', content: flattenText(message.content) })
  }
  return wire
}

/**
 * Serialize harness tool schemas into Anthropic `Tool[]`.
 * @param tools - the harness tool schemas, if any.
 * @returns the wire tools, or `undefined` when there are none to send.
 */
export function serializeTools(tools: readonly ToolSchema[] | undefined): Tool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object', ...tool.parameters },
  }))
}

interface RequestFields {
  system?: string
  messages: MessageParam[]
  tools?: Tool[]
  temperature?: number
  max_tokens: number
  stop_sequences?: string[]
  thinking?: ThinkingConfigParam
  output_config?: { effort: ResolvedReasoning['effort'] }
}

/**
 * Build the full Anthropic Messages request body.
 * @param options - the harness request.
 * @param maxTokens - the resolved `max_tokens` (request value, else the model default).
 * @returns the wire request fields, ready to spread into `messages.create()`.
 */
export function serializeRequest(options: GenerateOptions, maxTokens: number): RequestFields {
  const reasoning = resolveReasoning(options.model, options.reasoningEffort, maxTokens)
  const tools = serializeTools(options.tools)
  return {
    ...options.system === undefined ? {} : { system: options.system },
    messages: serializeMessages(options.messages),
    ...tools === undefined ? {} : { tools },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    max_tokens: maxTokens,
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
    ...reasoning.thinking === undefined ? {} : { thinking: reasoning.thinking },
    ...reasoning.effort === undefined ? {} : { output_config: { effort: reasoning.effort } },
  }
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
  signature?: string
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

function closeReplayBlock(block: OpenBlock): AnthropicContentBlock | undefined {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text, citations: null }
    case 'reasoning': return { type: 'thinking', thinking: block.text, signature: block.signature ?? '' }
    case 'tool-call': return {
      type: 'tool_use',
      id: block.callId ?? '',
      name: block.name ?? '',
      input: block.text.length > 0 ? JSON.parse(block.text) : {},
      caller: { type: 'direct' },
    }
  }
}

/**
 * Map an Anthropic `stop_reason` to the harness's `FinishReason`.
 * @param reason - the wire `stop_reason`.
 * @param refusal - the accompanying refusal explanation, present only when `reason === 'refusal'`.
 * @returns the mapped finish reason.
 */
export function mapStopReason(reason: string, refusal?: string): FinishReason {
  switch (reason) {
    case 'end_turn': return { kind: 'stop' }
    case 'stop_sequence': return { kind: 'stop' }
    case 'pause_turn': return { kind: 'stop' }
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'refusal': return { kind: 'error', failure: { message: refusal ?? 'the model refused to respond', code: 'REFUSAL' } }
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

interface WireUsage {
  input_tokens?: number | null
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/**
 * Map Anthropic's already-disjoint usage counts to the harness's `TokenUsage`.
 * @param usage - the wire usage counts from a `message_start`/`message_delta` event.
 * @returns the mapped token usage.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens
  const cacheWrite = usage.cache_creation_input_tokens
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    ...cacheRead === null || cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === null || cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
  }
}

/**
 * Translate an Anthropic `RawMessageStreamEvent` async iterable into harness
 * `StreamChunk`s. Server-tool and other unexpected block types reserve their
 * index and emit no deltas or `block-end` (documented Known Limitation);
 * `signature_delta`/`citations_delta` feed only the accumulated
 * `finish.replayState`, not a harness delta.
 * @param events - the SDK's raw stream events.
 * @returns harness stream chunks; throws `STREAM_CLOSED` if the source ends without `message_stop`.
 */
export async function* translate(events: AsyncIterable<RawMessageStreamEvent>): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingReason: string | undefined
  let pendingRefusal: string | undefined
  let pendingUsage: TokenUsage | undefined
  let sawMessageStop = false

  for await (const event of events) {
    switch (event.type) {
      case 'message_start': {
        pendingUsage = mapUsage(event.message.usage)
        break
      }
      case 'content_block_start': {
        const block = event.content_block
        if (block.type === 'text') {
          const open: OpenBlock = { index: event.index, kind: 'text', text: '' }
          blocks.set(event.index, open)
          order.push(open)
          yield { type: 'block-start', index: event.index, blockType: 'text' }
        } else if (block.type === 'thinking') {
          const open: OpenBlock = { index: event.index, kind: 'reasoning', text: '' }
          blocks.set(event.index, open)
          order.push(open)
          yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
        } else if (block.type === 'tool_use') {
          const open: OpenBlock = { index: event.index, kind: 'tool-call', text: '', callId: block.id, name: block.name }
          blocks.set(event.index, open)
          order.push(open)
          yield { type: 'block-start', index: event.index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: event.index, id: CallId(block.id), name: block.name, argumentsDelta: '' }
        }
        break
      }
      case 'content_block_delta': {
        const open = blocks.get(event.index)
        const delta = event.delta
        if (delta.type === 'text_delta') {
          if (open !== undefined) open.text += delta.text
          yield { type: 'text-delta', index: event.index, text: delta.text }
        } else if (delta.type === 'thinking_delta') {
          if (open !== undefined) open.text += delta.thinking
          yield { type: 'reasoning-delta', index: event.index, text: delta.thinking }
        } else if (delta.type === 'input_json_delta') {
          if (open !== undefined) open.text += delta.partial_json
          yield { type: 'tool-call-delta', index: event.index, id: CallId(open?.callId ?? ''), argumentsDelta: delta.partial_json }
        } else if (delta.type === 'signature_delta') {
          if (open !== undefined) open.signature = (open.signature ?? '') + delta.signature
        }
        break
      }
      case 'content_block_stop': {
        const open = blocks.get(event.index)
        if (open !== undefined) {
          yield { type: 'block-end', index: event.index, block: closeBlock(open) }
        }
        break
      }
      case 'message_delta': {
        pendingReason = event.delta.stop_reason ?? undefined
        pendingRefusal = event.delta.stop_details?.type === 'refusal' ? event.delta.stop_details.explanation ?? undefined : undefined
        pendingUsage = mapUsage(event.usage)
        break
      }
      case 'message_stop': {
        sawMessageStop = true
        if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
        const reason = pendingReason === undefined
          ? { kind: 'stop' as const }
          : mapStopReason(pendingReason, pendingRefusal)
        const replayState: ReplayEnvelope = {
          response: null,
          blocks: order.map(closeReplayBlock).filter((value): value is AnthropicContentBlock => value !== undefined),
        }
        yield {
          type: 'finish',
          reason: reason.kind === 'stop' && order.length === 0
            ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
            : reason,
          ...reason.kind === 'error' ? {} : { replayState },
        }
        break
      }
    }
  }

  if (!sawMessageStop) {
    throw new LlmError('Anthropic message stream ended without message_stop', 'STREAM_CLOSED')
  }
}
