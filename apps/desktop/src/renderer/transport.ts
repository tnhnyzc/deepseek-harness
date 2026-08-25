/**
 * The renderer half of the stage 3 transport (SPEC §8 primitives A and B).
 * `desktopFetch` is a fetch-compatible surface that drives the wire protocol
 * on a MessagePort instead of a network; `openStream` exposes an opaque
 * ordered stream whose frames flow in both directions. Nothing here knows
 * DSH semantics: urls and frames are opaque, and the host plane answers
 * through the dumb broker and the runtime adapter.
 *
 * Backpressure is credit-based on every data path: the runtime may hold
 * {@link TRANSPORT_CREDIT_BYTES} per direction in flight, and this side
 * returns credit as bytes are consumed (a response chunk when it enters the
 * ReadableStream queue, a stream frame when the consumer dequeues it); the
 * request-body pump and `send` are gated by the windows the runtime returns
 * credit into (`fetch.request.credit`, `stream.credit`). Abandoned
 * consumers and stalled producers therefore hold the peer within one credit
 * window instead of buffering unbounded — the in-flight high-water mark is
 * the window, separate from the semantic total a request may reach.
 *
 * Cancellation is terminal: an AbortSignal stays armed until the operation
 * actually ends, `ReadableStream.cancel` on a response body posts
 * `fetch.abort` too, and every terminal path (success, failure, abort,
 * consumer cancel, channel loss) releases its operation entry exactly once.
 * An active request-body producer is part of that lifetime: the body pump
 * arms a cancellation hook on the operation for its whole lifetime, and
 * every terminal invokes it, so a producer stalled inside `reader.read()`
 * cannot hold the fetch past the operation's death. A stream open accepts
 * the caller's signal for its whole lifetime, including the pending open
 * acknowledgement: an abort while the open waits posts the generic
 * `stream.close` that releases the runtime-side open and settles the
 * caller with the abort terminal, while an abort after the open is the
 * clean close a local close makes.
 *
 * @module @deepseek-ai/dsh-desktop/src/renderer/transport
 */

import {
  TRANSPORT_MAX_FRAME_BYTES,
  TransportErrorCode,
  TransportSendWindow,
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
  /**
   * Send one uplink frame; resolves once it is posted. Gated by the uplink
   * credit window: it awaits credit the runtime returns as it consumes, so
   * a producer cannot enqueue more than one window ahead of the consumer.
   * @throws for an oversized frame or a terminal stream.
   */
  send(data: Uint8Array): Promise<void>
  /** Close after in-flight frames settle; terminal. */
  close(reason?: string): void
}

export interface DesktopTransport {
  /** Fetch-compatible request over the transport. */
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
  /**
   * Open one opaque stream named by the url the DSH client would name it.
   * @param url - the stream name the opener would use.
   * @param signal - optional caller cancellation for the open's whole
   * lifetime, including the pending open acknowledgement: an abort while
   * the acknowledgement waits posts the generic stream close that releases
   * the runtime-side open and rejects the open with the abort terminal.
   */
  openStream(url: string, signal?: AbortSignal): Promise<DesktopStream>
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
  signal: AbortSignal
  head: Deferred<{ status: number; statusText: string; headers: Array<[string, string]> }>
  body: Channel<Uint8Array>
  headResolved: boolean
  /** Whether the abort path already settled the operation. */
  aborted: boolean
  /** The abort listener, removed when the operation actually terminates. */
  onAbort: (() => void) | undefined
  /** The sequence the next `fetch.response.chunk` must carry. */
  expectedSequence: number
  /** The request-body send window; the runtime returns credit into it. */
  requestWindow: TransportSendWindow
  /**
   * Cancels the active request-body producer; set while the body pump is
   * live, cleared when it exits. Invoked by every terminal path so a
   * producer blocked inside `reader.read()` can never hold the fetch past
   * the operation's death.
   */
  cancelBody: (() => void) | undefined
}

interface StreamOp {
  id: string
  ack: Deferred<void>
  ackSettled: boolean
  frames: Channel<Uint8Array>
  outcome: Deferred<void>
  terminal: boolean
  /** The sequence the next uplink `stream.frame` will carry. */
  uplinkSequence: number
  /** The sequence the next downlink `stream.frame` must carry. */
  expectedSequence: number
  /** The uplink send window; the runtime returns credit into it. */
  window: TransportSendWindow
  /** The caller's cancellation signal, present when the opener supplied one. */
  signal: AbortSignal | undefined
  /** The abort listener, removed when the operation actually terminates. */
  onAbort: (() => void) | undefined
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

  // ---- operation terminals: every path releases its entry exactly once ----

  const releaseFetchOp = (op: FetchOp): void => {
    if (!fetchOps.has(op.requestId)) return
    fetchOps.delete(op.requestId)
    // End the request window with the operation: a producer parked on
    // credit wakes instead of holding on past the terminal.
    op.requestWindow.cancel()
    // Wake a producer parked inside the body stream: a terminal (remote
    // error, channel loss, abort) must never leave the fetch held by a
    // stalled reader.read().
    op.cancelBody?.()
    if (op.onAbort !== undefined) op.signal.removeEventListener('abort', op.onAbort)
  }

  const endFetchOp = (op: FetchOp): void => {
    releaseFetchOp(op)
    if (!op.headResolved) {
      // A protocol violation by the peer; the operation must still settle.
      op.head.reject(new TransportError(TransportErrorCode.internal, 'response ended before the head'))
      return
    }
    op.body.end()
  }

  const failFetchOp = (op: FetchOp, error: Error): void => {
    releaseFetchOp(op)
    if (!op.headResolved) op.head.reject(error)
    op.body.fail(error)
  }

  const releaseStreamOp = (op: StreamOp): void => {
    if (!streamOps.has(op.id)) return
    streamOps.delete(op.id)
    if (op.onAbort !== undefined) op.signal?.removeEventListener('abort', op.onAbort)
  }

  const endStreamOp = (op: StreamOp): void => {
    if (op.terminal) return
    op.terminal = true
    releaseStreamOp(op)
    op.window.cancel()
    op.frames.end()
    op.outcome.resolve()
  }

  const failStreamOp = (op: StreamOp, error: Error): void => {
    if (op.terminal) return
    op.terminal = true
    releaseStreamOp(op)
    op.window.cancel()
    if (!op.ackSettled) {
      op.ackSettled = true
      op.ack.reject(error)
    }
    op.frames.fail(error)
    op.outcome.reject(error)
  }

  const refuseStreamOp = (op: StreamOp, reason: string): void => {
    if (op.terminal) return
    op.terminal = true
    releaseStreamOp(op)
    op.window.cancel()
    op.ackSettled = true
    op.ack.reject(new TransportError(reason, `stream open refused: ${reason}`))
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
        if (message.sequence !== op.expectedSequence) {
          failFetchOp(op, new TransportError(TransportErrorCode.badSequence, `expected response sequence ${String(op.expectedSequence)}, got ${String(message.sequence)}`))
          return
        }
        op.expectedSequence++
        op.body.push(message.data)
        return
      }
      case 'fetch.response.end': {
        const op = fetchOps.get(message.requestId)
        if (op === undefined) return
        endFetchOp(op)
        return
      }
      case 'fetch.error': {
        const op = fetchOps.get(message.requestId)
        if (op === undefined) return
        failFetchOp(op, new TransportError(message.code, message.message))
        return
      }
      case 'fetch.request.credit': {
        // The runtime returns request-body credit as it accumulates the body.
        const op = fetchOps.get(message.requestId)
        if (op !== undefined) op.requestWindow.addCredit(message.credit)
        return
      }
      case 'stream.open.ack': {
        const op = streamOps.get(message.streamId)
        if (op === undefined || op.terminal) return
        if (message.ok) {
          op.ackSettled = true
          op.ack.resolve()
          return
        }
        refuseStreamOp(op, message.reason ?? TransportErrorCode.unknownStream)
        return
      }
      case 'stream.frame': {
        const op = streamOps.get(message.streamId)
        if (op === undefined || op.terminal) return
        if (message.sequence !== op.expectedSequence) {
          failStreamOp(op, new TransportError(TransportErrorCode.badSequence, `expected stream sequence ${String(op.expectedSequence)}, got ${String(message.sequence)}`))
          return
        }
        op.expectedSequence++
        op.frames.push(message.data)
        return
      }
      case 'stream.close': {
        const op = streamOps.get(message.streamId)
        if (op === undefined) return
        endStreamOp(op)
        return
      }
      case 'stream.error': {
        const op = streamOps.get(message.streamId)
        if (op === undefined) return
        failStreamOp(op, new TransportError(message.code, message.message))
        return
      }
      case 'stream.credit': {
        // The runtime returns uplink credit as it consumes client frames.
        const op = streamOps.get(message.streamId)
        if (op !== undefined) op.window.addCredit(message.credit)
        return
      }
      case 'fetch.open':
      case 'fetch.request.chunk':
      case 'fetch.request.end':
      case 'fetch.abort':
      case 'fetch.response.credit':
      case 'stream.open':
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
    const op: FetchOp = {
      requestId,
      signal: request.signal,
      head: deferred(),
      body: new Channel<Uint8Array>(),
      headResolved: false,
      aborted: false,
      onAbort: undefined,
      expectedSequence: 0,
      requestWindow: new TransportSendWindow(),
      cancelBody: undefined,
    }
    fetchOps.set(requestId, op)
    const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError')
    // The listener stays armed until the operation is actually terminal —
    // abort must reach DSH while the body is still streaming, not only until
    // the head arrives.
    const onAbort = (): void => {
      if (op.aborted) return
      op.aborted = true
      post({ type: 'fetch.abort', requestId, reason: 'aborted' })
      failFetchOp(op, abortError())
    }
    op.onAbort = onAbort
    if (request.signal.aborted) {
      onAbort()
      throw abortError()
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    post({ type: 'fetch.open', requestId, url: url.href, method: request.method, headers: Array.from(request.headers.entries()) })
    if (request.body !== null) {
      // Pump the request body in bounded frames, gated by the request credit
      // window: at most one window of body bytes is ever in flight across
      // the IPC, no matter how large the request. The loop stops when the
      // operation terminates (abort, or a transport refusal such as the
      // request size bound) so production cannot run past the terminal.
      const reader = request.body.getReader()
      // Cancelling the body stream settles a parked read, so production
      // cannot outlive the operation: the hook is armed on the op for the
      // pump's lifetime (every terminal path cancels through it) and on the
      // abort signal (the caller's cancellation, same settlement).
      const cancelBody = (): void => {
        void reader.cancel().catch(() => undefined)
      }
      op.cancelBody = cancelBody
      request.signal.addEventListener('abort', cancelBody, { once: true })
      let sequence = 0
      try {
        for (;;) {
          if (op.aborted || !fetchOps.has(requestId)) break
          const { done, value } = await reader.read()
          if (done) break
          for (let offset = 0; offset < value.byteLength;) {
            const slice = value.subarray(offset, offset + TRANSPORT_MAX_FRAME_BYTES)
            offset += slice.byteLength
            await op.requestWindow.reserve(slice.byteLength, request.signal)
            // The reserve awaited: a terminal may have run in the meantime. A
            // terminal removes the op from the map (and sets `aborted`) in the
            // same step, so map liveness is the complete check.
            if (!fetchOps.has(requestId)) break
            post({ type: 'fetch.request.chunk', requestId, sequence: sequence++, data: slice })
          }
        }
      } catch (error) {
        // A producer failure on a live operation is terminal: settle it here
        // and let the fetch reject through the head below (one rejection, no
        // unhandled one). After a remote terminal or abort the op is out of
        // the map and its terminal already settled the operation.
        if (fetchOps.has(requestId)) {
          const detail = error instanceof Error ? error.message : String(error)
          failFetchOp(op, new TransportError(TransportErrorCode.internal, `request body failed: ${detail}`))
        }
      } finally {
        // The pump is done: later terminals must not re-cancel a completed
        // producer (and a normal completion never cancels at all).
        op.cancelBody = undefined
        request.signal.removeEventListener('abort', cancelBody)
        try {
          reader.releaseLock()
        } catch {
          // The body stream released itself (cancellation raced the read).
        }
      }
    }
    // A terminal operation (abort or refusal) must not claim a completed body.
    if (fetchOps.has(requestId)) {
      post({ type: 'fetch.request.end', requestId })
    }
    const head = await op.head.promise
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
      cancel: () => {
        // The consumer gave up on the body: cancel the still-active
        // operation at DSH and release it — fetch.abort reaches the
        // DSH-side AbortSignal for the lifetime of the stream.
        op.aborted = true
        post({ type: 'fetch.abort', requestId, reason: 'consumer-cancelled' })
        failFetchOp(op, new TransportError(TransportErrorCode.transportClosed, 'response body cancelled'))
      },
    })
    // 204/205/304 carry no body by spec; the transport sends an empty stream
    // for them, which the Response constructor refuses.
    const nullBody = head.status === 204 || head.status === 205 || head.status === 304
    return new Response(nullBody ? null : body, { status: head.status, statusText: head.statusText, headers: head.headers })
  }

  const openStreamFn = async (url: string, signal?: AbortSignal): Promise<DesktopStream> => {
    if (closed) throw transportClosedError()
    const id = crypto.randomUUID()
    const op: StreamOp = {
      id,
      ack: deferred<void>(),
      ackSettled: false,
      frames: new Channel<Uint8Array>(),
      outcome: deferred<void>(),
      terminal: false,
      uplinkSequence: 0,
      expectedSequence: 0,
      window: new TransportSendWindow(),
      signal,
      onAbort: undefined,
    }
    // `outcome` is observational: a consumer may never await it, in which
    // case a terminal failure must not surface as an unhandled rejection —
    // the stream's frames already carry the same failure to the pump.
    op.outcome.promise.catch(() => undefined)
    streamOps.set(id, op)
    if (signal !== undefined) {
      // The listener stays armed for the whole stream lifetime: a pending
      // open must be cancellable, not only an active stream, and every
      // terminal removes it (releaseStreamOp), so a terminal stream cannot
      // act on a later abort of the same signal.
      const onAbort = (): void => {
        if (op.terminal) return
        if (op.ackSettled) {
          // The stream is active: the abort is the clean close a local
          // close makes.
          endStreamOp(op)
          post({ type: 'stream.close', streamId: id, reason: 'aborted' })
          return
        }
        // The open is still pending: release the runtime-side open with the
        // generic close and settle the caller with the abort terminal.
        const error = new DOMException('The operation was aborted.', 'AbortError')
        op.terminal = true
        releaseStreamOp(op)
        op.window.cancel()
        post({ type: 'stream.close', streamId: id, reason: 'aborted' })
        op.ackSettled = true
        op.ack.reject(error)
        op.frames.fail(error)
        op.outcome.reject(error)
      }
      op.onAbort = onAbort
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    if (!op.terminal) {
      // A pre-armed abort already settled the open: the open itself never
      // goes out (the close onAbort posted no-ops at the peer, the way a
      // pre-armed fetch posts fetch.abort).
      post({ type: 'stream.open', streamId: id, url: new URL(url, TRANSPORT_BASE_URL).href })
    }
    const handle: DesktopStream = {
      id,
      outcome: op.outcome.promise,
      frames: (): AsyncGenerator<Uint8Array, void> => (async function* (): AsyncGenerator<Uint8Array, void> {
        const iterator = op.frames[Symbol.asyncIterator]()
        for (;;) {
          const { done, value } = await iterator.next()
          if (done) return
          post({ type: 'stream.credit', streamId: id, credit: value.byteLength })
          yield value
        }
      })(),
      send: async (data: Uint8Array) => {
        if (!streamOps.has(op.id)) {
          throw new TransportError(TransportErrorCode.transportClosed, 'stream closed')
        }
        if (data.byteLength > TRANSPORT_MAX_FRAME_BYTES) {
          throw new TransportError(TransportErrorCode.frameTooLarge, `frame of ${data.byteLength} bytes exceeds the transport frame bound`)
        }
        try {
          // Bounded backpressure: at most one window ahead of the consumer.
          await op.window.reserve(data.byteLength)
        } catch {
          // The window cancelled with the stream's terminal while we waited.
        }
        if (!streamOps.has(op.id)) {
          throw new TransportError(TransportErrorCode.transportClosed, 'stream closed')
        }
        post({ type: 'stream.frame', streamId: id, sequence: op.uplinkSequence++, data })
      },
      close: (reason?: string) => {
        if (op.terminal) return
        endStreamOp(op)
        post({ type: 'stream.close', streamId: id, ...(reason !== undefined ? { reason } : {}) })
      },
    }
    return op.ack.promise.then(() => handle)
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
