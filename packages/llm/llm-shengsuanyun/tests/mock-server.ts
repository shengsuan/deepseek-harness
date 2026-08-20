import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type Anthropic from '@anthropic-ai/sdk'
import type { WireModel, WireModelsResponse } from '../src/types.ts'

export type Behavior =
  | { kind: 'sse'; events: Anthropic.RawMessageStreamEvent[]; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: 'close-early'; events: Anthropic.RawMessageStreamEvent[] }

export interface MockServer {
  url: string
  requests: unknown[]
  headers: IncomingMessage['headers'][]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

function usage(overrides: Partial<Anthropic.Usage> = {}): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 3,
    output_tokens: 0,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  }
}

export function messageStart(overrides: Partial<Anthropic.Usage> = {}): Anthropic.RawMessageStartEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1',
      container: null,
      content: [],
      model: 'anthropic/claude-test',
      role: 'assistant',
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: usage(overrides),
    },
  }
}

export const textEvents: Anthropic.RawMessageStreamEvent[] = [
  messageStart(),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
    usage: usage({ output_tokens: 1 }),
  },
  { type: 'message_stop' },
]

export function serializeSseEvent(event: Anthropic.RawMessageStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export async function mockServer(script: Behavior[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(body.length > 0 ? JSON.parse(body) : undefined)
      headers.push(request.headers)
      const behavior = script.shift()
      if (!behavior) {
        response.writeHead(500).end('mock script exhausted')
        return
      }
      if (behavior.kind === 'http-error') {
        response.writeHead(behavior.status, {
          'content-type': behavior.contentType ?? 'application/json',
          ...behavior.headers,
        })
        response.end(behavior.body)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const write = (index: number): void => {
        if (index >= behavior.events.length) {
          if (behavior.kind === 'sse') response.end()
          else response.destroy()
          return
        }
        const event = behavior.events[index]
        if (event === undefined) return
        response.write(serializeSseEvent(event))
        setTimeout(() => { write(index + 1) }, behavior.kind === 'sse' ? behavior.delayMs ?? 0 : 5)
      }
      write(0)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    script,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

export function wireModel(overrides: Partial<Omit<WireModel, 'support_apis'>> & { support_apis?: string[] | undefined } = {}): WireModel {
  const model: WireModel = {
    id: 'anthropic/claude-test',
    name: 'Claude Test',
    max_tokens: 8_192,
    context_window: 200_000,
    pricing: { prompt: 30_000, completion: 150_000, cache: 3_750 },
    architecture: { input: 'text', output: 'text', tokenizer: 'cl100k' },
    support_apis: ['/v1/messages'],
  }
  Object.assign(model, overrides)
  if (model.support_apis === undefined) delete model.support_apis
  return model
}

export async function mockModelsServer(response: WireModelsResponse, status = 200): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, res: ServerResponse) => {
    requests.push(undefined)
    headers.push(request.headers)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(response))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    script: [],
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}
