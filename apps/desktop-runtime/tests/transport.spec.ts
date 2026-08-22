/**
 * The desktop transport protocol and the runtime adapter, tested over a real
 * MessageChannel: the parser rejects malformed wire values, the send window
 * gates on credit, and `attachTransportRuntime` serves fetch traffic through
 * the real `toFetchHandler` seam against a fake host plane (including credit
 * backpressure, abort propagation, stream framing, downlink-only enforcement,
 * and port-close teardown).
 */

import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { RpcId, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import {
  TRANSPORT_CREDIT_BYTES,
  TRANSPORT_MAX_FRAME_BYTES,
  TransportErrorCode,
  TransportProtocolError,
  TransportSendWindow,
  isTransportMessage,
  parseTransportMessage,
  transportMessageDataBytes,
} from '../src/transport.ts'
import { attachTransportRuntime } from '../src/transport-runtime.ts'

/** A minimal host-plane double: the routes the tests drive, plus controllable downlinks. */
/** Route request/response parameter pairs read off the real contract. */
type SessionsListRequest = Parameters<ApiProxy['sessions']['list']>[0]
type SessionsSearchParams = Parameters<ApiProxy['sessions']['search']>
type EventsMuxParams = Parameters<ApiProxy['events']['mux']>
type EventsHostParams = Parameters<ApiProxy['events']['host']>

function fakeApiProxy(options: {
  /** One abortable signal per hung route, keyed by route, for abort assertions. */
  hungSignals: Map<string, AbortSignal>
  /** Frames the mux downlink yields before it ends; each entry is one payload. */
  muxPayloads: Array<Record<string, unknown>>
  /** Whether the host downlink should run until aborted (no frames). */
  hostRunsUntilAbort: boolean
  hostSignal: { current?: AbortSignal }
  listValue?: unknown
}): ApiProxy {
  const ok = (rpcId: unknown, value: unknown) => ({ rpcId, result: { ok: true, value } })
  return {
    sessions: {
      list: async (r: SessionsListRequest) => ok(r.rpcId, options.listValue ?? { items: [] }),
      search: async (_r: SessionsSearchParams[0], signal: SessionsSearchParams[1]) => {
        options.hungSignals.set('session.search', signal)
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      },
    },
    events: {
      mux: async function* (_r: EventsMuxParams[0], _signal: EventsMuxParams[1]) {
        for (const payload of options.muxPayloads) {
          yield { rpcId: RpcId(crypto.randomUUID()), payload }
        }
      },
      host: async function* (_r: EventsHostParams[0], signal: EventsHostParams[1]) {
        if (options.hostRunsUntilAbort) {
          options.hostSignal.current = signal
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
      },
    },
  } as unknown as ApiProxy
}

interface WireMessage {
  type: string
  [key: string]: unknown
}

/** Collects inbound wire messages with a bounded wait; `next` returns undefined on timeout. */
class MessageReader {
  private queue: WireMessage[] = []
  private waiters: Array<() => void> = []

  constructor(port: MessagePort) {
    port.on('message', (value: unknown) => {
      this.queue.push(value as WireMessage)
      for (const wake of this.waiters.splice(0)) wake()
    })
    port.start()
  }

  async next(timeoutMs = 5000): Promise<WireMessage | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending = this.queue.shift()
      if (pending !== undefined) return pending
      if (Date.now() >= deadline) return undefined
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deadline - Date.now())
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** The next message of exactly this type; tests sequence precisely. */
  async ofType(type: string, timeoutMs = 5000): Promise<WireMessage> {
    const message = await this.next(timeoutMs)
    if (message === undefined) throw new Error(`no ${type} message within ${String(timeoutMs)} ms`)
    expect(message.type).toBe(type)
    return message
  }
}

const JSON_HEADERS: Array<[string, string]> = [['content-type', 'application/json']]

function clientRequest(rpcId: string, method: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: 'client-request', rpcId, method, payload }))
}

describe('transport protocol', () => {
  it('parses a well-formed message of every family', () => {
    const parsed = parseTransportMessage({
      type: 'fetch.response.head',
      requestId: 'r1',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
    })
    expect(parsed).toEqual({
      type: 'fetch.response.head',
      requestId: 'r1',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
    })
  })

  it('drops optional fields instead of materializing undefined', () => {
    const message = parseTransportMessage({ type: 'fetch.abort', requestId: 'r1' })
    expect(message).toEqual({ type: 'fetch.abort', requestId: 'r1' })
  })

  it('rejects malformed wire values with a protocol error', () => {
    const cases: unknown[] = [
      null,
      42,
      { type: 'fetch.open' },
      { type: 'fetch.open', requestId: '', url: 'x', method: 'GET', headers: [] },
      { type: 'fetch.request.chunk', requestId: 'r', sequence: -1, data: new Uint8Array() },
      { type: 'fetch.request.chunk', requestId: 'r', sequence: 1.5, data: new Uint8Array() },
      { type: 'fetch.request.chunk', requestId: 'r', sequence: 0, data: 'not-bytes' },
      { type: 'fetch.response.credit', requestId: 'r', credit: -1 },
      { type: 'stream.open.ack', streamId: 's', ok: 'yes' },
      { type: 'runtime.ready' },
      { type: 'totally.new' },
    ]
    for (const value of cases) {
      expect(() => parseTransportMessage(value)).toThrow(TransportProtocolError)
    }
  })

  it('discriminates transport from control messages', () => {
    expect(isTransportMessage({ type: 'fetch.open', requestId: 'r', url: 'u', method: 'GET', headers: [] })).toBe(true)
    expect(isTransportMessage({ type: 'runtime.ready' })).toBe(false)
    expect(isTransportMessage({ type: 'runtime.shutdown' })).toBe(false)
    expect(isTransportMessage(null)).toBe(false)
    expect(isTransportMessage('stream.open')).toBe(false)
  })

  it('counts only data-bearing frames for the size guard', () => {
    const chunk = parseTransportMessage({ type: 'fetch.response.chunk', requestId: 'r', sequence: 0, data: new Uint8Array(123) })
    expect(transportMessageDataBytes(chunk)).toBe(123)
    const head = parseTransportMessage({ type: 'fetch.response.head', requestId: 'r', status: 200, statusText: '', headers: [] })
    expect(transportMessageDataBytes(head)).toBe(0)
  })

  it('gates the send window on returned credit', async () => {
    const window = new TransportSendWindow(100)
    await window.reserve(60)
    expect(window.available()).toBe(40)
    const pending = window.reserve(50)
    expect(window.available()).toBe(40)
    window.addCredit(50)
    await pending
    // 100 window − 110 reserved + 50 credited = 40 outstanding capacity.
    expect(window.available()).toBe(40)
    await expect(window.reserve(TRANSPORT_CREDIT_BYTES + 1)).rejects.toThrow(TransportProtocolError)
  })
})

describe('transport runtime adapter', () => {
  let channel: MessagePort | undefined
  let remote: MessagePort | undefined
  let reader: MessageReader | undefined
  let hungSignals: Map<string, AbortSignal>
  let hostSignal: { current?: AbortSignal }
  let dispose: (() => void) | undefined

  afterAll(() => {
    dispose?.()
    channel?.close()
  })

  const attach = (muxPayloads: Array<Record<string, unknown>>, hostRunsUntilAbort: boolean, listValue?: unknown): void => {
    hungSignals = new Map()
    hostSignal = {}
    const api = fakeApiProxy({ hungSignals, muxPayloads, hostRunsUntilAbort, hostSignal, listValue })
    const wire = new MessageChannel()
    channel = wire.port1
    remote = wire.port2
    reader = new MessageReader(wire.port2)
    dispose = attachTransportRuntime(channel, api)
  }

  const post = (message: object): void => {
    remote?.postMessage(message)
  }

  const chunksUntilStall = async (timeoutMs = 400): Promise<number> => {
    const r = reader
    if (r === undefined) throw new Error('reader missing')
    let received = 0
    for (;;) {
      const message = await r.next(timeoutMs)
      if (message === undefined || message.type !== 'fetch.response.chunk') break
      received += (message.data as Uint8Array).byteLength
    }
    return received
  }

  it('serves a keyless unary fetch through the in-process seam', async () => {
    attach([], false)
    post({ type: 'fetch.open', requestId: 'r1', url: 'http://dsh.local/api/session.list', method: 'POST', headers: JSON_HEADERS })
    post({ type: 'fetch.request.chunk', requestId: 'r1', sequence: 0, data: clientRequest('rpc-1', 'session.list', {}) })
    post({ type: 'fetch.request.end', requestId: 'r1' })

    const head = await reader?.ofType('fetch.response.head')
    expect(head?.status).toBe(200)
    // undici reports an empty reason phrase for custom responses.
    expect(head?.statusText).toBeTypeOf('string')

    const chunks: Uint8Array[] = []
    for (;;) {
      const message = await reader?.next()
      if (message === undefined || message.type === 'fetch.response.end') break
      expect(message.type).toBe('fetch.response.chunk')
      chunks.push(message.data as Uint8Array)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    expect(JSON.parse(body)).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { items: [] } },
    })
  })

  it('refuses a duplicate fetch id and a bad sequence', async () => {
    attach([], false)
    post({ type: 'fetch.open', requestId: 'dup', url: 'http://dsh.local/api/session.list', method: 'POST', headers: JSON_HEADERS })
    post({ type: 'fetch.open', requestId: 'dup', url: 'http://dsh.local/api/session.list', method: 'POST', headers: JSON_HEADERS })
    const duplicate = await reader?.ofType('fetch.error')
    expect(duplicate?.requestId).toBe('dup')
    expect(duplicate?.code).toBe(TransportErrorCode.duplicateId)

    post({ type: 'fetch.open', requestId: 'seq', url: 'http://dsh.local/api/session.list', method: 'POST', headers: JSON_HEADERS })
    post({ type: 'fetch.request.chunk', requestId: 'seq', sequence: 7, data: clientRequest('rpc-2', 'session.list', {}) })
    const badSequence = await reader?.ofType('fetch.error')
    expect(badSequence?.requestId).toBe('seq')
    expect(badSequence?.code).toBe(TransportErrorCode.badSequence)
  })

  it('drops malformed frames without replying', async () => {
    attach([], false)
    post({ type: 'fetch.open', requestId: 'r' })
    post({ type: 'fetch.open', requestId: 'live', url: 'http://dsh.local/api/session.list', method: 'POST', headers: JSON_HEADERS })
    post({ type: 'fetch.request.chunk', requestId: 'live', sequence: 0, data: clientRequest('rpc-3', 'session.list', {}) })
    post({ type: 'fetch.request.end', requestId: 'live' })
    const head = await reader?.ofType('fetch.response.head')
    expect(head?.requestId).toBe('live')
  })

  it('stalls the response on the credit window and resumes on credit', async () => {
    const items = 'x'.repeat(600 * 1024)
    attach([], false, { items })
    post({ type: 'fetch.open', requestId: 'big', url: 'http://dsh.local/api/session.list', method: 'POST', headers: JSON_HEADERS })
    post({ type: 'fetch.request.chunk', requestId: 'big', sequence: 0, data: clientRequest('rpc-big', 'session.list', {}) })
    post({ type: 'fetch.request.end', requestId: 'big' })
    await reader?.ofType('fetch.response.head')

    // The 256 KiB window admits exactly four 64 KiB frames, then stalls.
    const stalled = await chunksUntilStall()
    expect(stalled).toBe(TRANSPORT_CREDIT_BYTES)

    const r = reader
    if (r === undefined) throw new Error('reader missing')
    let total = stalled
    for (;;) {
      const message = await r.next(400)
      if (message === undefined) {
        // The window is drained; return a full window and keep reading.
        post({ type: 'fetch.response.credit', requestId: 'big', credit: TRANSPORT_CREDIT_BYTES })
        continue
      }
      if (message.type === 'fetch.response.chunk') {
        total += (message.data as Uint8Array).byteLength
        continue
      }
      expect(message.type).toBe('fetch.response.end')
      break
    }
    expect(total).toBeGreaterThan(600 * 1024)
    expect(total).toBeLessThanOrEqual(600 * 1024 + 1024)
  })

  it('propagates fetch.abort to the plane as an AbortSignal', async () => {
    attach([], false)
    const signals = hungSignals
    post({ type: 'fetch.open', requestId: 'hang', url: 'http://dsh.local/api/session.search', method: 'POST', headers: JSON_HEADERS })
    post({ type: 'fetch.request.chunk', requestId: 'hang', sequence: 0, data: clientRequest('rpc-hang', 'session.search', { query: 'x' }) })
    post({ type: 'fetch.request.end', requestId: 'hang' })
    await vi.waitFor(() => {
      expect(signals.has('session.search')).toBe(true)
    })
    const signal = signals.get('session.search')
    if (signal === undefined) throw new Error('signal missing')
    expect(signal.aborted).toBe(false)
    post({ type: 'fetch.abort', requestId: 'hang', reason: 'user' })
    await vi.waitFor(() => {
      expect(signal.aborted).toBe(true)
    })
  })

  it('streams mux frames as pinned server-request envelopes and closes on end', async () => {
    const payloads = [
      { type: 'session/title', sessionId: 's1', title: 'one' },
      { type: 'session/log', sessionId: 's1', entry: { n: 1 } },
    ]
    attach(payloads, false)
    post({ type: 'stream.open', streamId: 's1', url: '/api/events.mux' })
    const ack = await reader?.ofType('stream.open.ack')
    expect(ack?.ok).toBe(true)

    const frame0 = await reader?.ofType('stream.frame')
    expect(frame0?.sequence).toBe(0)
    const parsed0 = JSON.parse(Buffer.from(frame0?.data as Uint8Array).toString('utf8')) as { type: string; method: string; payload: unknown }
    expect(parsed0.type).toBe('server-request')
    expect(parsed0.method).toBe('session/title')
    expect(parsed0.payload).toEqual(payloads[0])

    const frame1 = await reader?.ofType('stream.frame')
    expect(frame1?.sequence).toBe(1)
    const close = await reader?.ofType('stream.close')
    expect(close?.reason).toBe('ended')
  })

  it('refuses unknown stream urls and answers uplink frames downlink-only', async () => {
    attach([], true)
    post({ type: 'stream.open', streamId: 'u1', url: '/api/nope' })
    const refused = await reader?.ofType('stream.open.ack')
    expect(refused?.ok).toBe(false)
    expect(refused?.reason).toBe(TransportErrorCode.unknownStream)

    post({ type: 'stream.open', streamId: 'h1', url: '/api/events.host' })
    await reader?.ofType('stream.open.ack')
    post({ type: 'stream.frame', streamId: 'h1', sequence: 0, data: new TextEncoder().encode('up') })
    const error = await reader?.ofType('stream.error')
    expect(error?.streamId).toBe('h1')
    expect(error?.code).toBe(TransportErrorCode.downlinkOnly)
  })

  it('fails a stream whose frame exceeds the bound', async () => {
    const oversized = { type: 'session/log', sessionId: 's1', entry: 'y'.repeat(TRANSPORT_MAX_FRAME_BYTES) }
    attach([oversized], false)
    post({ type: 'stream.open', streamId: 'big', url: '/api/events.mux' })
    await reader?.ofType('stream.open.ack')
    const error = await reader?.ofType('stream.error')
    expect(error?.code).toBe(TransportErrorCode.frameTooLarge)
  })

  it('aborts in-flight operations when the port closes', async () => {
    attach([], true)
    const signalSlot = hostSignal
    post({ type: 'stream.open', streamId: 'h2', url: '/api/events.host' })
    await reader?.ofType('stream.open.ack')
    await vi.waitFor(() => {
      expect(signalSlot.current).toBeDefined()
    })
    const signal = signalSlot.current
    if (signal === undefined) throw new Error('host signal missing')
    expect(signal.aborted).toBe(false)
    channel?.close()
    await vi.waitFor(() => {
      expect(signal.aborted).toBe(true)
    })
  })
})
