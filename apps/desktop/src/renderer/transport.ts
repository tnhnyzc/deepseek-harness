/**
 * The renderer half of the stage 3 transport (SPEC §8 primitives A and B).
 * `desktopFetch` is a fetch-compatible surface that drives the wire protocol
 * on a MessagePort instead of a network; `openStream` exposes an opaque
 * ordered downlink stream with credit-based backpressure. Nothing here knows
 * DSH semantics: urls and frames are opaque, and the host plane answers
 * through the dumb broker and the runtime adapter.
 *
 * Backpressure: the runtime may hold {@link TRANSPORT_CREDIT_BYTES} per
 * direction in flight; this side returns credit as bytes are consumed
 * (a response chunk when it enters the ReadableStream queue, a stream frame
 * when the consumer dequeues it). Abandoned consumers therefore stall the
 * runtime within one credit window instead of buffering unbounded.
 *
 * @module @deepseek-ai/dsh-desktop/src/renderer/transport
 */

import {
  TRANSPORT_MAX_FRAME_BYTES,
  TransportErrorCode,
  parseTransportMessage,
} from '@deepseek-ai/dsh-desktop-runtime/transport'

/** The dummy origin every transport fetch resolves against; only the pathname routes. */
const TRANSPORT_BASE_URL = 'http://dsh.local'

/** A terminal transport failure carrying the wire error code. */
export class TransportError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TransportError'
    this.code = code
  }
}

/**
 * The port surface this client needs. The event surface matches the DOM
 * `EventTarget` signatures so both the browser `MessagePort` (production) and
 * the Node `worker_threads` `MessagePort` (tests) satisfy it.
 */
export interface TransportPortLike {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void
  postMessage(message: object): void
  start(): void
  close(): void
}

/** Primitive B handle: one opaque stream. */
export interface DesktopStream {
  readonly id: string
  /** Terminal: resolves on `stream.close`, rejects with `TransportError` on `stream.error` or channel loss. */
  readonly outcome: Promise<void>
  /** The ordered downlink frames; ends on close, throws on error. */
  frames(): AsyncGenerator<Uint8Array, void>
  /** Send one uplink frame; throws locally when the frame exceeds the bound. */
  send(data: Uint8Array): void
  /** Close after in-flight frames settle; terminal. */
  close(reason?: string): void
}

export interface DesktopTransport {
  /** Fetch-compatible request over the transport. */
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
  /** Open one opaque stream named by the url the DSH client would name it. */
  openStream(url: string): Promise<DesktopStream>
  /** Tear the channel down: settle every pending operation. */
  close(): void
}

/** A single pending value. */
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A single-consumer ordered queue with one terminal failure. */
class Channel<T> {
  private items: T[] = []
  private waiters: Array<{ resolve: (result: IteratorResult<T, void>) => void; reject: (error: Error) => void }> = []
  private ended = false
  private failure: Error | undefined

  push(item: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve({ value: item, done: false })
    else this.items.push(item)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void> {
    return {
      next: (): Promise<IteratorResult<T, void>> => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.ended) {
          if (this.failure !== undefined) return Promise.reject(this.failure)
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<T, void>>((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
    }
  }
}

interface FetchOp {
  requestId: string
  head: Deferred<{ status: number; statusText: string; headers: Array<[string, string]> }>
  body: Channel<Uint8Array>
  headResolved: boolean
}

interface StreamOp {
  id: string
  ack: Deferred<void>
  frames: Channel<Uint8Array>
  outcome: Deferred<void>
  terminal: boolean
  uplinkSequence: number
}

/**
 * Build the renderer transport client on one port.
 * @param port - the renderer half of the channel the dumb broker ships over IPC.
 * @returns the transport client.
 */
export function createDesktopTransport(port: TransportPortLike): DesktopTransport {
  const fetchOps = new Map<string, FetchOp>()
  const streamOps = new Map<string, StreamOp>()
  let closed = false

  const post = (message: object): void => {
    if (closed) return
    try {
      port.postMessage(message)
    } catch {
      // The port closed between the check and the send; teardown settles ops.
    }
  }

  const transportClosedError = (): TransportError => new TransportError(TransportErrorCode.transportClosed, 'the transport channel closed')

  const terminateStream = (op: StreamOp): void => {
    if (op.terminal) return
    op.terminal = true
    op.frames.end()
    op.outcome.resolve()
  }

  const failStreamOp = (op: StreamOp, error: Error): void => {
    streamOps.delete(op.id)
    if (op.terminal) return
    op.terminal = true
    op.frames.fail(error)
    op.outcome.reject(error)
  }

  const failFetchOp = (op: FetchOp, error: Error): void => {
    fetchOps.delete(op.requestId)
    if (!op.headResolved) op.head.reject(error)
    op.body.fail(error)
  }

  const teardownAll = (error: TransportError): void => {
    if (closed) return
    closed = true
    for (const op of [...fetchOps.values()]) failFetchOp(op, error)
    for (const op of [...streamOps.values()]) failStreamOp(op, error)
  }

  const onMessage: EventListener = (event: Event) => {
    let message
    try {
      message = parseTransportMessage((event as MessageEvent).data)
    } catch {
      return
    }
    switch (message.type) {
      case 'fetch.response.head': {
        const op = fetchOps.get(message.requestId)
        if (op === undefined || op.headResolved) return
        op.headResolved = true
        op.head.resolve({ status: message.status, statusText: message.statusText, headers: message.headers })
        return
      }
      case 'fetch.response.chunk': {
        const op = fetchOps.get(message.requestId)
        if (op === undefined) return
        op.body.push(message.data)
        return
      }
      case 'fetch.response.end': {
        const op = fetchOps.get(message.requestId)
        if (op === undefined) return
        op.body.end()
        return
      }
      case 'fetch.error': {
        const op = fetchOps.get(message.requestId)
        if (op === undefined) return
        failFetchOp(op, new TransportError(message.code, message.message))
        return
      }
      case 'stream.open.ack': {
        const op = streamOps.get(message.streamId)
        if (op === undefined) return
        if (message.ok) {
          op.ack.resolve()
          return
        }
        streamOps.delete(message.streamId)
        op.ack.reject(new TransportError(message.reason ?? TransportErrorCode.unknownStream, `stream open refused: ${message.reason ?? 'unknown-stream'}`))
        return
      }
      case 'stream.frame': {
        const op = streamOps.get(message.streamId)
        if (op === undefined || op.terminal) return
        op.frames.push(message.data)
        return
      }
      case 'stream.close': {
        const op = streamOps.get(message.streamId)
        if (op === undefined) return
        streamOps.delete(message.streamId)
        terminateStream(op)
        return
      }
      case 'stream.error': {
        const op = streamOps.get(message.streamId)
        if (op === undefined) return
        failStreamOp(op, new TransportError(message.code, message.message))
        return
      }
      case 'fetch.open':
      case 'fetch.request.chunk':
      case 'fetch.request.end':
      case 'fetch.abort':
      case 'fetch.response.credit':
      case 'stream.open':
      case 'stream.credit':
        // Renderer-direction messages never come back over this channel.
        return
    }
  }

  const onPortClose: EventListener = (): void => {
    teardownAll(transportClosedError())
  }

  const fetchFn = async (input: string | Request, init?: RequestInit): Promise<Response> => {
    if (closed) throw transportClosedError()
    const url = typeof input === 'string' ? new URL(input, TRANSPORT_BASE_URL) : new URL(input.url)
    // Stream bodies require the duplex flag on the Request, whatever their origin.
    const streamBody = typeof input === 'string'
      ? (init?.body instanceof ReadableStream ? init.body : undefined)
      : (init?.body instanceof ReadableStream ? init.body : input.body)
    const request = new Request(typeof input === 'string' ? url.href : input, {
      ...(init ?? {}),
      ...(streamBody !== undefined ? { duplex: 'half' as const } : {}),
    })
    const requestId = crypto.randomUUID()
    const op: FetchOp = { requestId, head: deferred(), body: new Channel<Uint8Array>(), headResolved: false }
    fetchOps.set(requestId, op)
    const onAbort = (): void => {
      post({ type: 'fetch.abort', requestId, reason: 'aborted' })
      failFetchOp(op, new DOMException('The operation was aborted.', 'AbortError'))
    }
    if (request.signal.aborted) {
      onAbort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    post({ type: 'fetch.open', requestId, url: url.href, method: request.method, headers: Array.from(request.headers.entries()) })
    try {
      if (request.body !== null) {
        const reader = request.body.getReader()
        let sequence = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          for (let offset = 0; offset < value.byteLength;) {
            const slice = value.subarray(offset, offset + TRANSPORT_MAX_FRAME_BYTES)
            offset += slice.byteLength
            post({ type: 'fetch.request.chunk', requestId, sequence: sequence++, data: slice })
          }
        }
      }
    } catch (error) {
      request.signal.removeEventListener('abort', onAbort)
      const detail = error instanceof Error ? error.message : String(error)
      failFetchOp(op, new TransportError(TransportErrorCode.internal, `request body failed: ${detail}`))
      throw new TransportError(TransportErrorCode.internal, `request body failed: ${detail}`)
    }
    post({ type: 'fetch.request.end', requestId })
    const head = await op.head.promise
    request.signal.removeEventListener('abort', onAbort)
    const bodyIterator = op.body[Symbol.asyncIterator]()
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const { done, value } = await bodyIterator.next()
        if (done) {
          controller.close()
          return
        }
        post({ type: 'fetch.response.credit', requestId, credit: value.byteLength })
        controller.enqueue(value)
      },
    })
    // 204/205/304 carry no body by spec; the transport sends an empty stream
    // for them, which the Response constructor refuses.
    const nullBody = head.status === 204 || head.status === 205 || head.status === 304
    return new Response(nullBody ? null : body, { status: head.status, statusText: head.statusText, headers: head.headers })
  }

  const openStreamFn = (url: string): Promise<DesktopStream> => {
    if (closed) return Promise.reject(transportClosedError())
    const id = crypto.randomUUID()
    const op: StreamOp = {
      id,
      ack: deferred<void>(),
      frames: new Channel<Uint8Array>(),
      outcome: deferred<void>(),
      terminal: false,
      uplinkSequence: 0,
    }
    streamOps.set(id, op)
    post({ type: 'stream.open', streamId: id, url })
    return op.ack.promise
      .then(() => {
        const frames = (): AsyncGenerator<Uint8Array, void> => (async function* (): AsyncGenerator<Uint8Array, void> {
          const iterator = op.frames[Symbol.asyncIterator]()
          for (;;) {
            const { done, value } = await iterator.next()
            if (done) return
            post({ type: 'stream.credit', streamId: id, credit: value.byteLength })
            yield value
          }
        })()
        const handle: DesktopStream = {
          id,
          outcome: op.outcome.promise,
          frames,
          send: (data: Uint8Array) => {
            if (closed || op.terminal) return
            if (data.byteLength > TRANSPORT_MAX_FRAME_BYTES) {
              throw new TransportError(TransportErrorCode.frameTooLarge, `frame of ${data.byteLength} bytes exceeds the transport frame bound`)
            }
            post({ type: 'stream.frame', streamId: id, sequence: op.uplinkSequence++, data })
          },
          close: (reason?: string) => {
            if (op.terminal) return
            terminateStream(op)
            post({ type: 'stream.close', streamId: id, ...(reason !== undefined ? { reason } : {}) })
          },
        }
        return handle
      })
      .catch((error: unknown) => {
        streamOps.delete(id)
        throw error
      })
  }

  port.addEventListener('message', onMessage)
  port.addEventListener('close', onPortClose)
  port.start()

  return {
    fetch: fetchFn,
    openStream: openStreamFn,
    close: () => {
      teardownAll(transportClosedError())
      try {
        port.close()
      } catch {
        // Already closed.
      }
    },
  }
}
