import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { CallId, contentHasImage, EMPTY_RESPONSE_CODE, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  mapStopReason,
  mapUsage,
  resolveReasoning,
  serializeMessages,
  serializeRequest,
  serializeTools,
  translate,
} from '../src/translate.ts'
import { messageStart, textEvents } from './mock-server.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'shengsuanyun', model: 'shengsuanyun-test', messages: [], ...overrides }
}

async function* feed(...events: Anthropic.RawMessageStreamEvent[]): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
  for (const event of events) yield event
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('resolveReasoning', () => {
  it('returns no fields for a model with no reasoning axes and no requested effort', () => {
    expect(resolveReasoning('unknown/model', undefined, 8_192)).toEqual({})
  })

  it('throws UNSUPPORTED_REASONING_EFFORT for a model with no axes and a requested effort', () => {
    expect(() => resolveReasoning('unknown/model', ReasoningEffortId('high'), 8_192))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('returns no fields for an effort-axis model with no requested effort', () => {
    expect(resolveReasoning('openai/gpt-5.1', undefined, 8_192)).toEqual({})
  })

  it('resolves a valid effort on an effort-axis model', () => {
    expect(resolveReasoning('openai/gpt-5.1', ReasoningEffortId('high'), 8_192)).toEqual({ effort: 'high' })
  })

  it('throws UNSUPPORTED_REASONING_EFFORT for an effort not declared by the model', () => {
    expect(() => resolveReasoning('openai/gpt-5.1', ReasoningEffortId('default'), 8_192))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('throws UNSUPPORTED_REASONING_EFFORT for an effort not in the recognized value set', () => {
    expect(() => resolveReasoning('openai/gpt-5.1', ReasoningEffortId('ultra'), 8_192))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('prefers the effort axis over budget_tokens for anthropic/claude models', () => {
    expect(resolveReasoning('anthropic/claude-opus-4', ReasoningEffortId('high'), 8_192)).toEqual({ effort: 'high' })
  })

  it('returns no fields for a budget_tokens/toggle model with no requested effort', () => {
    expect(resolveReasoning('ali/qwen3-max', undefined, 8_192)).toEqual({})
  })

  it('disables thinking for off on a budget_tokens/toggle model', () => {
    expect(resolveReasoning('ali/qwen3-max', ReasoningEffortId('off'), 8_192))
      .toEqual({ thinking: { type: 'disabled' } })
  })

  it('enables adaptive thinking for on on a toggle-only model', () => {
    expect(resolveReasoning('bigmodel/glm-5-flash', ReasoningEffortId('on'), 8_192))
      .toEqual({ thinking: { type: 'adaptive' } })
  })

  it('enables budget_tokens thinking for on on a budget_tokens model, clamped below maxTokens', () => {
    expect(resolveReasoning('ali/qwen3-max', ReasoningEffortId('on'), 100_000))
      .toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } })
  })

  it('clamps the budget below a small maxTokens', () => {
    expect(resolveReasoning('ali/qwen3-max', ReasoningEffortId('on'), 1_100))
      .toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } })
  })

  it('throws UNSUPPORTED_REASONING_EFFORT for an unrecognized effort on a budget_tokens/toggle model', () => {
    expect(() => resolveReasoning('ali/qwen3-max', ReasoningEffortId('high'), 8_192))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })
})

describe('serializeMessages', () => {
  it('skips system-role messages', () => {
    const wire = serializeMessages([
      createMessage({ role: 'system', content: [{ type: 'text', text: 'be brief' }], source: { kind: 'plugin', plugin: 'test' } }),
      createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('serializes plain user text', () => {
    const wire = serializeMessages([
      createUserMessage({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }], source: { kind: 'plugin', plugin: 'test' } }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('lossily serializes an assistant turn without a stored replayState', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'tool-call', id: CallId('call-1'), name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
        source: { kind: 'model', provider: 'shengsuanyun', model: 'm' },
      }),
    ])
    expect(wire).toEqual([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'call-1', name: 'get_weather', input: { city: 'Paris' } },
      ],
    }])
  })

  it('replays the stored native content blocks verbatim when replayState is present', () => {
    const blocks = [{ type: 'thinking', thinking: 'mull', signature: 'sig' }, { type: 'text', text: 'answer', citations: null }]
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'shengsuanyun', model: 'm', replayState: { response: null, blocks } },
      }),
    ])
    expect(wire).toEqual([{ role: 'assistant', content: blocks }])
  })

  it('falls back to the lossy path when replayState has no blocks array', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'shengsuanyun', model: 'm', replayState: { response: null } },
      }),
    ])
    expect(wire).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }])
  })

  it('rejects image blocks in assistant content', () => {
    expect(contentHasImage([{ type: 'text', text: 'x' }])).toBe(false)
    expect(() => serializeMessages([
      createMessage({
        role: 'assistant',
        content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as never }],
        source: { kind: 'model', provider: 'shengsuanyun', model: 'm' },
      }),
    ])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('rejects image blocks in user content', () => {
    expect(() => serializeMessages([
      createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as never }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('serializes a tool-result message as a standalone user turn', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'Sunny' }] }],
        source: { kind: 'tool', callId: CallId('call-1') },
      }),
    ])
    expect(wire).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Sunny' }],
    }])
  })

  it('sends a sentinel for empty tool-result content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [] }],
        source: { kind: 'tool', callId: CallId('call-1') },
      }),
    ])
    expect(wire).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '(no output)' }],
    }])
  })

  it('marks an errored tool result', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'boom' }], isError: true }],
        source: { kind: 'tool', callId: CallId('call-1') },
      }),
    ])
    expect(wire).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'boom', is_error: true }],
    }])
  })

  it('rejects a malformed tool-result message whose first block is not a tool-result', () => {
    const malformed = {
      ...createUserMessage({
        content: [
          { type: 'text', text: 'x' },
          { type: 'tool-result', toolCallId: CallId('call-1'), content: [] },
        ],
        source: { kind: 'tool', callId: CallId('call-1') },
      }),
    } as Message
    expect(() => serializeMessages([malformed])).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
})

describe('serializeTools', () => {
  it('returns undefined for no tools', () => {
    expect(serializeTools(undefined)).toBeUndefined()
    expect(serializeTools([])).toBeUndefined()
  })

  it('maps tool schemas to the wire shape', () => {
    expect(serializeTools([{ name: 'a', description: 'A', parameters: { properties: {} } }])).toEqual([
      { name: 'a', description: 'A', input_schema: { type: 'object', properties: {} } },
    ])
  })
})

describe('serializeRequest', () => {
  const history: Message[] = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })]

  it('maps the basics with a resolved maxTokens', () => {
    const wire = serializeRequest(request({ model: 'unknown/model', messages: history }), 4096)
    expect(wire).toEqual({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 })
  })

  it('includes system, tools, temperature, and stop when set', () => {
    const wire = serializeRequest(request({
      model: 'unknown/model',
      messages: history,
      system: 'be helpful',
      tools: [{ name: 'a', description: 'A', parameters: {} }],
      temperature: 0.2,
      stop: ['END'],
    }), 4096)
    expect(wire).toEqual({
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'a', description: 'A', input_schema: { type: 'object' } }],
      temperature: 0.2,
      max_tokens: 4096,
      stop_sequences: ['END'],
    })
  })

  it('includes a thinking field when the reasoning axis resolves one', () => {
    const wire = serializeRequest(request({
      model: 'ali/qwen3-max',
      messages: history,
      reasoningEffort: ReasoningEffortId('off'),
    }), 4096)
    expect(wire.thinking).toEqual({ type: 'disabled' })
    expect(wire.output_config).toBeUndefined()
  })

  it('includes an output_config field when the reasoning axis resolves an effort', () => {
    const wire = serializeRequest(request({
      model: 'openai/gpt-5.1',
      messages: history,
      reasoningEffort: ReasoningEffortId('high'),
    }), 4096)
    expect(wire.output_config).toEqual({ effort: 'high' })
    expect(wire.thinking).toBeUndefined()
  })
})

describe('mapStopReason', () => {
  it.each([
    ['end_turn', { kind: 'stop' }],
    ['stop_sequence', { kind: 'stop' }],
    ['pause_turn', { kind: 'stop' }],
    ['tool_use', { kind: 'tool-calls' }],
    ['max_tokens', { kind: 'max-tokens' }],
  ])('maps %s', (reason, expected) => {
    expect(mapStopReason(reason)).toEqual(expected)
  })

  it('maps refusal to an error with the explanation', () => {
    expect(mapStopReason('refusal', 'unsafe request')).toEqual({
      kind: 'error',
      failure: { message: 'unsafe request', code: 'REFUSAL' },
    })
  })

  it('falls back to a generic refusal message when no explanation is given', () => {
    expect(mapStopReason('refusal')).toEqual({
      kind: 'error',
      failure: { message: 'the model refused to respond', code: 'REFUSAL' },
    })
  })

  it('maps an unrecognized reason to an error keyed by its uppercased wire value', () => {
    expect(mapStopReason('mystery')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: mystery', code: 'MYSTERY' },
    })
  })
})

describe('mapUsage', () => {
  it('maps input/output tokens with no cache fields', () => {
    expect(mapUsage({ input_tokens: 10, output_tokens: 2 })).toEqual({ inputTokens: 10, outputTokens: 2 })
  })

  it('defaults input tokens to 0 when null or undefined', () => {
    expect(mapUsage({ input_tokens: null, output_tokens: 2 })).toEqual({ inputTokens: 0, outputTokens: 2 })
    expect(mapUsage({ output_tokens: 2 })).toEqual({ inputTokens: 0, outputTokens: 2 })
  })

  it('includes cache fields when present and non-null', () => {
    expect(mapUsage({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
    })).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3 })
  })

  it('omits cache fields when null', () => {
    expect(mapUsage({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    })).toEqual({ inputTokens: 10, outputTokens: 2 })
  })
})

describe('translate: text', () => {
  it('streams a text block end to end', async () => {
    const chunks = await collect(translate(feed(...textEvents)))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: { response: null, blocks: [{ type: 'text', text: 'hello', citations: null }] },
      },
    ])
  })
})

describe('translate: reasoning', () => {
  it('streams a thinking block and accumulates its signature into replayState', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mull' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ing' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: null, output_tokens: 4, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null } },
      { type: 'message_stop' },
    )))
    expect(chunks.filter(chunk => chunk.type !== 'usage' && chunk.type !== 'finish')).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'mull' },
      { type: 'reasoning-delta', index: 0, text: 'ing' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'mulling' } },
    ])
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish') throw new Error('expected finish')
    expect(finish.replayState).toEqual({ response: null, blocks: [{ type: 'thinking', thinking: 'mulling', signature: 'sig-1' }] })
  })
})

describe('translate: tool calls', () => {
  it('streams fragmented input_json_delta chunks into one accumulated tool call', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {}, caller: { type: 'direct' } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"Paris"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { container: null, stop_details: null, stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 6, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null } },
      { type: 'message_stop' },
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '{"city"' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: ':"Paris"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 6 } },
      {
        type: 'finish',
        reason: { kind: 'tool-calls' },
        replayState: { response: null, blocks: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' }, caller: { type: 'direct' } }] },
      },
    ])
  })

  it('closes a tool-call replay block with an empty object when no json arrived', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'noop', input: {}, caller: { type: 'direct' } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { container: null, stop_details: null, stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null } },
      { type: 'message_stop' },
    )))
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('expected finish')
    expect(finish.replayState).toEqual({ response: null, blocks: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: {}, caller: { type: 'direct' } }] })
  })
})

describe('translate: unexpected content-block types', () => {
  it('reserves the index and emits no delta or block-end for a server tool_use block', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } as never },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null } },
      { type: 'message_stop' },
    )))
    expect(chunks.some(chunk => chunk.type === 'block-start' || chunk.type === 'block-end')).toBe(false)
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE } },
    })
  })
})

describe('translate: finish and usage handling', () => {
  it('classifies a completed response with no opened blocks as EMPTY_RESPONSE', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'message_delta', delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null } },
      { type: 'message_stop' },
    )))
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } },
      {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } },
        replayState: { response: null, blocks: [] },
      },
    ])
  })

  it('does not classify a non-stop finish with no opened blocks as EMPTY_RESPONSE', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'message_delta', delta: { container: null, stop_details: null, stop_reason: 'max_tokens', stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null } },
      { type: 'message_stop' },
    )))
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('defaults to a stop finish when message_delta never arrives', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    )))
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('omits the usage chunk when message_start and message_delta never arrive', async () => {
    const chunks = await collect(translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    )))
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
  })

  it('ignores content_block_stop for an index that was never opened', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'content_block_stop', index: 9 },
      { type: 'message_stop' },
    )))
    expect(chunks.some(chunk => chunk.type === 'block-end')).toBe(false)
  })

  it('yields a text-delta for a content_block_delta at an index that was never opened', async () => {
    const chunks = await collect(translate(feed(
      messageStart(),
      { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'orphan' } },
      { type: 'message_stop' },
    )))
    expect(chunks).toEqual([
      { type: 'text-delta', index: 9, text: 'orphan' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 0 } },
      {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } },
        replayState: { response: null, blocks: [] },
      },
    ])
  })
})

describe('translate: errors', () => {
  it('throws STREAM_CLOSED when the source ends without message_stop', async () => {
    await expect(collect(translate(feed(messageStart())))).rejects.toThrow(LlmError)
    await expect(collect(translate(feed(messageStart())))).rejects.toThrow(/without message_stop/)
  })
})
