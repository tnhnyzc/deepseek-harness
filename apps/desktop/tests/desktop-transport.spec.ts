/**
 * The renderer half of the stage 3 transport, tested in Node against a
 * reactive fake peer: fetch assembly (headers, body, status), streaming
 * request bodies, response credit return, sequence validation on both
 * primitives, the full abort lifecycle (before the head, mid-body,
 * consumer body cancel, stalled request-body production), uplink credit
 * backpressure, stream open/frame/credit/close/error lifecycle, and
 * port-close teardown.
 */

import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopTransport, TransportError, type DesktopStream } from '../src/renderer/transport.ts'
import { TRANSPORT_CREDIT_BYTES, TRANSPORT_MAX_FRAME_BYTES } from '@deepseek-ai/dsh-desktop-runtime/transport'

interface WireMessage {
  type: string
  [key: string]: unknown
}

/** The runtime side of the channel: records every inbound message and drives the replies. */
class FakePeer {
  readonly received: WireMessage[] = []
  private handlers = new Map<string, Array<(message: WireMessage) => void>>()

  constructor(readonly port: MessagePort) {
    port.on('message', (value: unknown) => {
      const message = value as WireMessage
      this.received.push(message)
      for (const handler of this.handlers.get(message.type) ?? []) handler(message)
    })
    port.start()
  }

  on(type: string, handler: (message: WireMessage) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }

  send(message: object): void {
    this.port.postMessage(message)
  }

  close(): void {
    this.port.close()
  }

  ofType(type: string): WireMessage[] {
    return this.received.filter(message => message.type === type)
  }

  async waitForType(type: string, timeoutMs = 5000): Promise<WireMessage> {
    await vi.waitFor(() => {
      expect(this.ofType(type).length).toBeGreaterThan(0)
    }, { timeout: timeoutMs })
    const message = this.ofType(type)[0]
    if (message === undefined) throw new Error(`no ${type} received`)
    return message
  }
}

function peerChannel(): { client: MessagePort; peer: FakePeer } {
  const channel = new MessageChannel()
  return { client: channel.port2, peer: new FakePeer(channel.port1) }
}

const JSON_HEADERS: Array<[string, string]> = [['content-type', 'application/json']]

describe('renderer transport: fetch', () => {
  it('assembles a response from head, chunks, and end', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    const body = JSON.stringify({ hello: 'world' })
    peer.on('fetch.request.end', (message) => {
      peer.send({ type: 'fetch.response.head', requestId: message.requestId, status: 200, statusText: 'OK', headers: [['content-type', 'application/json']] })
      peer.send({ type: 'fetch.response.chunk', requestId: message.requestId, sequence: 0, data: new TextEncoder().encode(body) })
      peer.send({ type: 'fetch.response.end', requestId: message.requestId })
    })

    const response = await transport.fetch('/api/session.list', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.text()).toBe(body)

    const open = await peer.waitForType('fetch.open')
    expect(open.method).toBe('POST')
    expect(open.url).toBe('http://dsh.local/api/session.list')
    expect(open.headers).toEqual(JSON_HEADERS)
    const end = await peer.waitForType('fetch.request.end')
    expect(end.requestId).toBe(open.requestId)
    const chunks = peer.ofType('fetch.request.chunk')
    expect(chunks.length).toBe(1)
    expect(new TextDecoder().decode(chunks[0]?.data as Uint8Array)).toBe(
      JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
    )
    transport.close()
  })

  it('streams a ReadableStream request body in ordered chunks', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    const total = 300 * 1024
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < total; offset += 64 * 1024) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(Math.min(64 * 1024, total - offset))))
        }
        controller.close()
      },
    })
    peer.on('fetch.request.end', (message) => {
      peer.send({ type: 'fetch.response.head', requestId: message.requestId, status: 204, statusText: '', headers: [] })
      peer.send({ type: 'fetch.response.end', requestId: message.requestId })
    })
    const response = await transport.fetch('/api/session.export', { method: 'POST', body: bodyStream })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')

    const chunks = peer.ofType('fetch.request.chunk')
    expect(chunks.length).toBeGreaterThan(1)
    let bytes = 0
    let lastSequence = -1
    for (const chunk of chunks) {
      expect(chunk.sequence).toBe(lastSequence + 1)
      lastSequence = chunk.sequence as number
      bytes += (chunk.data as Uint8Array).byteLength
    }
    expect(bytes).toBe(total)
    transport.close()
  })

  it('returns response credit as the consumer reads and releases the rest', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    const chunkBytes = TRANSPORT_MAX_FRAME_BYTES
    const firstWindow = TRANSPORT_CREDIT_BYTES / chunkBytes
    const chunk = new TextEncoder().encode('z'.repeat(chunkBytes))
    let released = false
    peer.on('fetch.request.end', (message) => {
      const requestId = message.requestId as string
      peer.send({ type: 'fetch.response.head', requestId, status: 200, statusText: '', headers: [] })
      for (let sequence = 0; sequence < firstWindow; sequence++) {
        peer.send({ type: 'fetch.response.chunk', requestId, sequence, data: chunk })
      }
      let credited = 0
      peer.on('fetch.response.credit', (credit) => {
        if (credit.requestId !== requestId) return
        credited += credit.credit as number
        if (credited >= TRANSPORT_CREDIT_BYTES && !released) {
          released = true
          for (let sequence = firstWindow; sequence < firstWindow + 3; sequence++) {
            peer.send({ type: 'fetch.response.chunk', requestId, sequence, data: chunk })
          }
          peer.send({ type: 'fetch.response.end', requestId })
        }
      })
    })
    const response = await transport.fetch('/api/big', { method: 'GET' })
    const text = await response.text()
    expect(text.length).toBe((firstWindow + 3) * chunkBytes)
    expect(released).toBe(true)
    transport.close()
  })

  it('rejects the fetch when the port closes before the head', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    const pending = transport.fetch('/api/slow', { method: 'GET' })
    await vi.waitFor(() => {
      expect(peer.ofType('fetch.open').length).toBeGreaterThan(0)
    })
    peer.close()
    await expect(pending).rejects.toMatchObject({ name: 'TransportError', code: 'transport-closed' })
    transport.close()
  })

  it('surfaces a transport error before the head as a rejection', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('fetch.request.end', (message) => {
      peer.send({ type: 'fetch.error', requestId: message.requestId, code: 'internal', message: 'boom' })
    })
    await expect(transport.fetch('/api/boom', { method: 'GET' })).rejects.toMatchObject({ name: 'TransportError', code: 'internal' })
    transport.close()
  })

  it('fails the body after the head and keeps the response object', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('fetch.request.end', (message) => {
      peer.send({ type: 'fetch.response.head', requestId: message.requestId, status: 200, statusText: '', headers: [] })
      peer.send({ type: 'fetch.response.chunk', requestId: message.requestId, sequence: 0, data: new TextEncoder().encode('start') })
      peer.send({ type: 'fetch.error', requestId: message.requestId, code: 'internal', message: 'died mid-body' })
    })
    const response = await transport.fetch('/api/dying', { method: 'GET' })
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing body')
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('start')
    await expect(reader.read()).rejects.toMatchObject({ name: 'TransportError', code: 'internal' })
    transport.close()
  })

  it('aborts with a signal before the head and sends fetch.abort', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    const controller = new AbortController()
    const pending = transport.fetch('/api/abortable', { method: 'GET', signal: controller.signal })
    await vi.waitFor(() => {
      expect(peer.ofType('fetch.open').length).toBeGreaterThan(0)
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const abort = await peer.waitForType('fetch.abort')
    expect(abort.reason).toBe('aborted')
    transport.close()
  })
})

describe('renderer transport: streams', () => {
  it('opens, consumes ordered frames with credit, and closes', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
      peer.send({ type: 'stream.frame', streamId: message.streamId, sequence: 0, data: new TextEncoder().encode('f0') })
      peer.send({ type: 'stream.frame', streamId: message.streamId, sequence: 1, data: new TextEncoder().encode('f1') })
      peer.send({ type: 'stream.close', streamId: message.streamId, reason: 'ended' })
    })
    const stream: DesktopStream = await transport.openStream('/api/events.mux')
    const frames: string[] = []
    for await (const frame of stream.frames()) {
      frames.push(new TextDecoder().decode(frame))
    }
    expect(frames).toEqual(['f0', 'f1'])
    await expect(stream.outcome).resolves.toBeUndefined()

    await peer.waitForType('stream.open')
    // Credit posts deliver as port messages; wait for both deliveries.
    await vi.waitFor(() => {
      expect(peer.ofType('stream.credit').length).toBe(2)
    })
    expect(peer.ofType('stream.credit')[0]?.credit).toBe(2)
    expect(peer.ofType('stream.credit')[1]?.credit).toBe(2)
    transport.close()
  })

  it('rejects unknown stream urls with the refusal reason', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: false, reason: 'unknown-stream' })
    })
    await expect(transport.openStream('/api/nope')).rejects.toMatchObject({ name: 'TransportError', code: 'unknown-stream' })
    transport.close()
  })

  it('throws on stream.error and rejects the outcome', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
      peer.send({ type: 'stream.error', streamId: message.streamId, code: 'downlink-only', message: 'server to client only' })
    })
    const stream = await transport.openStream('/api/events.host')
    await expect(stream.outcome).rejects.toMatchObject({ name: 'TransportError', code: 'downlink-only' })
    const iterator = stream.frames()[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({ name: 'TransportError', code: 'downlink-only' })
    transport.close()
  })

  it('answers its own close with stream.close and a resolved outcome', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
      peer.send({ type: 'stream.frame', streamId: message.streamId, sequence: 0, data: new TextEncoder().encode('keep') })
    })
    const stream = await transport.openStream('/api/events.mux')
    const iterator = stream.frames()[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('stream ended before its first frame')
    expect(new TextDecoder().decode(first.value)).toBe('keep')
    stream.close('done')
    const close = await peer.waitForType('stream.close')
    expect(close.reason).toBe('done')
    const second = await iterator.next()
    expect(second.done).toBe(true)
    await expect(stream.outcome).resolves.toBeUndefined()
    transport.close()
  })

  it('refuses uplink frames above the bound locally', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
    })
    const stream = await transport.openStream('/api/events.host')
    await expect(stream.send(new Uint8Array(TRANSPORT_MAX_FRAME_BYTES + 1))).rejects.toThrow(TransportError)
    await stream.send(new Uint8Array(4))
    const frame = await peer.waitForType('stream.frame')
    expect(frame.sequence).toBe(0)
    transport.close()
    await expect(stream.outcome).rejects.toMatchObject({ name: 'TransportError', code: 'transport-closed' })
  })

  it('fails a fetch whose response sequence duplicates', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('fetch.request.end', (message) => {
      peer.send({ type: 'fetch.response.head', requestId: message.requestId, status: 200, statusText: '', headers: [] })
      peer.send({ type: 'fetch.response.chunk', requestId: message.requestId, sequence: 0, data: new TextEncoder().encode('a') })
      peer.send({ type: 'fetch.response.chunk', requestId: message.requestId, sequence: 0, data: new TextEncoder().encode('b') })
    })
    const response = await transport.fetch('/api/dup-seq', { method: 'GET' })
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing body')
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('a')
    await expect(reader.read()).rejects.toMatchObject({ name: 'TransportError', code: 'bad-sequence' })
    transport.close()
  })

  it('fails a stream whose downlink sequence skips', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
      peer.send({ type: 'stream.frame', streamId: message.streamId, sequence: 0, data: new TextEncoder().encode('a') })
      peer.send({ type: 'stream.frame', streamId: message.streamId, sequence: 2, data: new TextEncoder().encode('b') })
    })
    const stream = await transport.openStream('/api/events.mux')
    await expect(stream.outcome).rejects.toMatchObject({ name: 'TransportError', code: 'bad-sequence' })
    const iterator = stream.frames()[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('stream ended before its first frame')
    expect(new TextDecoder().decode(first.value)).toBe('a')
    await expect(iterator.next()).rejects.toMatchObject({ name: 'TransportError', code: 'bad-sequence' })
    transport.close()
  })

  it('sends fetch.abort when the signal fires while the body is streaming', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    const controller = new AbortController()
    peer.on('fetch.request.end', (message) => {
      peer.send({ type: 'fetch.response.head', requestId: message.requestId, status: 200, statusText: '', headers: [] })
      peer.send({ type: 'fetch.response.chunk', requestId: message.requestId, sequence: 0, data: new TextEncoder().encode('part') })
    })
    const response = await transport.fetch('/api/abort-mid-body', { method: 'GET', signal: controller.signal })
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing body')
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('part')
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    const abort = await peer.waitForType('fetch.abort')
    expect(abort.reason).toBe('aborted')
    transport.close()
  })

  it('cancels the operation when the consumer cancels the response body', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('fetch.request.end', (message) => {
      peer.send({ type: 'fetch.response.head', requestId: message.requestId, status: 200, statusText: '', headers: [] })
      peer.send({ type: 'fetch.response.chunk', requestId: message.requestId, sequence: 0, data: new TextEncoder().encode('part') })
    })
    const response = await transport.fetch('/api/consumer-cancel', { method: 'GET' })
    expect(response.body).not.toBeNull()
    await response.body?.cancel()
    const abort = await peer.waitForType('fetch.abort')
    expect(abort.reason).toBe('consumer-cancelled')
    transport.close()
  })

  it('stops pumping the request body when the signal aborts mid-production', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    const controller = new AbortController()
    let pulls = 0
    const bodyStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(10)))
          return Promise.resolve()
        }
        // The producer stalls: it never yields again and never closes.
        return new Promise<void>(() => undefined)
      },
    })
    const pending = transport.fetch('/api/stall-body', { method: 'POST', body: bodyStream, signal: controller.signal })
    await vi.waitFor(() => {
      expect(peer.ofType('fetch.request.chunk').length).toBe(1)
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const abort = await peer.waitForType('fetch.abort')
    expect(abort.reason).toBe('aborted')
    // The operation was terminal before the body completed: no end claim.
    expect(peer.ofType('fetch.request.end').length).toBe(0)
    transport.close()
  })

  it('stalls uplink sends on the credit window and resumes on stream.credit', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
    })
    const stream = await transport.openStream('/api/events.mux')
    const chunk = new Uint8Array(TRANSPORT_MAX_FRAME_BYTES)
    const windowFrames = TRANSPORT_CREDIT_BYTES / TRANSPORT_MAX_FRAME_BYTES
    for (let i = 0; i < windowFrames; i++) await stream.send(chunk)
    // Port delivery is asynchronous: poll until the window's frames landed.
    await vi.waitFor(() => {
      expect(peer.ofType('stream.frame').length).toBe(windowFrames)
    })
    const pending = stream.send(chunk)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    expect(peer.ofType('stream.frame').length).toBe(windowFrames) // parked on credit
    peer.send({ type: 'stream.credit', streamId: stream.id, credit: TRANSPORT_MAX_FRAME_BYTES })
    await pending
    await vi.waitFor(() => {
      expect(peer.ofType('stream.frame').length).toBe(windowFrames + 1)
    })
    const frames = peer.ofType('stream.frame')
    expect(frames.at(-1)?.sequence).toBe(windowFrames)
    transport.close()
    await expect(stream.outcome).rejects.toMatchObject({ name: 'TransportError', code: 'transport-closed' })
  })

  it('wakes a parked uplink send when the stream terminates', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
    })
    const stream = await transport.openStream('/api/events.mux')
    const chunk = new Uint8Array(TRANSPORT_MAX_FRAME_BYTES)
    const windowFrames = TRANSPORT_CREDIT_BYTES / TRANSPORT_MAX_FRAME_BYTES
    for (let i = 0; i < windowFrames; i++) await stream.send(chunk)
    await vi.waitFor(() => {
      expect(peer.ofType('stream.frame').length).toBe(windowFrames)
    })
    const pending = stream.send(chunk)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    expect(peer.ofType('stream.frame').length).toBe(windowFrames)
    peer.send({ type: 'stream.error', streamId: stream.id, code: 'downlink-only', message: 'server to client only' })
    await expect(pending).rejects.toThrow(TransportError)
    await expect(stream.outcome).rejects.toMatchObject({ name: 'TransportError', code: 'downlink-only' })
    transport.close()
  })

  it('fails open and pending operations when the port closes', async () => {
    const { client, peer } = peerChannel()
    const transport = createDesktopTransport(client)
    peer.on('stream.open', (message) => {
      peer.send({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
    })
    const stream = await transport.openStream('/api/events.mux')
    const pendingFetch = transport.fetch('/api/slow', { method: 'GET' })
    await vi.waitFor(() => {
      expect(peer.ofType('fetch.open').length).toBeGreaterThan(0)
    })
    peer.close()
    await expect(pendingFetch).rejects.toMatchObject({ name: 'TransportError', code: 'transport-closed' })
    await expect(stream.outcome).rejects.toMatchObject({ name: 'TransportError', code: 'transport-closed' })
    transport.close()
  })
})
