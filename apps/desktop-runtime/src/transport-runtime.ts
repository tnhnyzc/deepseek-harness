/**
 * The desktop runtime side of the transport: it consumes the wire protocol on
 * a MessagePort and serves both primitives through the one existing upstream
 * mechanism — the in-process fetch carrier `toFetchHandler(ctx.apiProxy)`
 * (no HTTP). Fetch traffic is the carrier as-is; a stream open is a GET whose
 * response body is pumped as ordered, credit-gated frames, so every downlink
 * the carrier serves — the pinned event streams, plain downloads, and any
 * stream a future revision adds — is carried with zero desktop changes. The
 * adapter names no endpoint, frame schema, or envelope; it only chunks,
 * sequences, and credits bytes.
 * @module @deepseek-ai/dsh-desktop-runtime/transport-runtime
 */

import { toFetchHandler, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import {
  TRANSPORT_MAX_FRAME_BYTES,
  TRANSPORT_MAX_REQUEST_BYTES,
  TransportErrorCode,
  TransportSendWindow,
  parseTransportMessage,
  type FetchResponseHead,
  type TransportPort,
} from './transport.ts'

interface FetchState {
  controller: AbortController
  url: string
  method: string
  headers: Array<[string, string]>
  window: TransportSendWindow
  chunks: Uint8Array[]
  bytes: number
  nextSequence: number
  finished: boolean
}

interface StreamState {
  controller: AbortController
  /** Outbound (runtime→renderer) frame sequence; the receiver validates it. */
  nextSequence: number
  /** Inbound (renderer→runtime) frame sequence; this edge validates it. */
  nextUplinkSequence: number
  window: TransportSendWindow
}

/** Adapter options. */
export interface TransportRuntimeOptions {
  /**
   * The semantic total-request limit for this adapter (defaults to
   * {@link TRANSPORT_MAX_REQUEST_BYTES}); the production wiring always uses
   * the default, tests exercise the bound accounting at smaller totals.
   */
  maxRequestBytes?: number
}

/**
 * Attach the transport to the booted host plane on the given port.
 * @param port - the port the dumb broker relays to this runtime (a
 * `MessagePort` in tests; the child IPC adapter in the runtime entry).
 * @param api - the host communication plane (`ctx.apiProxy`).
 * @param options - adapter options (the total-request limit).
 * @returns the disposer: aborts every in-flight operation and detaches.
 */
export function attachTransportRuntime(port: TransportPort, api: ApiProxy, options?: TransportRuntimeOptions): () => void {
  const handler = toFetchHandler(api)
  const maxRequestBytes = options?.maxRequestBytes ?? TRANSPORT_MAX_REQUEST_BYTES
  const fetches = new Map<string, FetchState>()
  const streams = new Map<string, StreamState>()
  let disposed = false

  const post = (message: object): void => {
    if (disposed || port.readyState === 'closed') return
    port.postMessage(message)
  }

  const endFetch = (requestId: string): void => {
    if (!fetches.has(requestId)) return // already terminated (abort or channel close)
    fetches.delete(requestId)
    post({ type: 'fetch.response.end', requestId })
  }

  const failFetch = (requestId: string, code: string, message: string): void => {
    const state = fetches.get(requestId)
    if (state === undefined) return // already terminated (abort or channel close)
    state.controller.abort()
    fetches.delete(requestId)
    post({ type: 'fetch.error', requestId, code, message })
  }

  const endStream = (streamId: string, reason?: string): void => {
    if (!streams.has(streamId)) return // already terminated
    streams.delete(streamId)
    post({ type: 'stream.close', streamId, ...(reason !== undefined ? { reason } : {}) })
  }

  const failStream = (streamId: string, code: string, message: string): void => {
    const state = streams.get(streamId)
    if (state === undefined) return // already terminated
    state.controller.abort()
    streams.delete(streamId)
    post({ type: 'stream.error', streamId, code, message })
  }

  /** Refuse a stream open: settle the pending ack and release any started state. */
  const refuseStream = (streamId: string, reason: string, state?: StreamState): void => {
    if (state !== undefined && streams.get(streamId) === state) {
      state.controller.abort()
      streams.delete(streamId)
    }
    post({ type: 'stream.open.ack', streamId, ok: false, reason })
  }

  /** Serve one completed fetch request through the in-process seam and stream the response back. */
  const runFetch = async (requestId: string, state: FetchState): Promise<void> => {
    let request: Request
    try {
      request = new Request(state.url, {
        method: state.method,
        headers: state.headers,
        ...(state.chunks.length > 0 ? { body: concatChunks(state.chunks, state.bytes) } : {}),
        signal: state.controller.signal,
      })
    } catch (error) {
      failFetch(requestId, TransportErrorCode.internal, error instanceof Error ? error.message : String(error))
      return
    }
    let response: Response
    try {
      response = await handler.fetch(request)
    } catch (error) {
      // The seam rejects only for carrier-level failures (a hung impl is the
      // client's timeout concern, not this adapter's).
      failFetch(requestId, TransportErrorCode.internal, error instanceof Error ? error.message : String(error))
      return
    }
    if (fetches.get(requestId) !== state) return // aborted in flight
    const head: FetchResponseHead = {
      type: 'fetch.response.head',
      requestId,
      status: response.status,
      statusText: response.statusText,
      headers: Array.from(response.headers.entries()),
    }
    post(head)
    if (response.body === null) {
      endFetch(requestId)
      return
    }
    const body = response.body
    const reader = body.getReader()
    let nextSequence = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (fetches.get(requestId) !== state) return
        for (let offset = 0; offset < value.byteLength;) {
          const slice = value.subarray(offset, offset + TRANSPORT_MAX_FRAME_BYTES)
          offset += slice.byteLength
          await state.window.reserve(slice.byteLength, state.controller.signal)
          if (fetches.get(requestId) !== state) return
          post({ type: 'fetch.response.chunk', requestId, sequence: nextSequence++, data: slice })
        }
      }
      endFetch(requestId)
    } catch (error) {
      // Body read failure mid-stream: the head already went out, so this is a
      // terminal fetch.error the client surfaces as a body failure.
      failFetch(requestId, TransportErrorCode.internal, error instanceof Error ? error.message : String(error))
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // The stream closed under the reader; the lock is gone with it.
      }
      // Early exit (abort, channel teardown): stop the carrier's work now
      // instead of waiting for the source to notice.
      await body.cancel().catch(() => undefined)
    }
  }

  /**
   * Open one stream as a GET on the carrier and pump the response body into
   * ordered, credit-gated frames. The carrier decides what the url serves
   * (a pinned event downlink, a download, or a refusal); the adapter only
   * chunks, sequences, and credits bytes.
   */
  const openStream = async (streamId: string, state: StreamState, url: string): Promise<void> => {
    let response: Response
    try {
      response = await handler.fetch(new Request(url, { method: 'GET', signal: state.controller.signal }))
    } catch {
      // A failed open (an unparseable url, a seam reject) is refused below;
      // the underlying error name is not transport vocabulary.
      if (streams.get(streamId) === state) {
        refuseStream(streamId, TransportErrorCode.internal, state)
      }
      return
    }
    if (streams.get(streamId) !== state) {
      // The channel was torn down mid-open: nothing left to tell.
      await cancelResponseBody(response)
      return
    }
    if (!response.ok || response.body === null) {
      await cancelResponseBody(response)
      refuseStream(
        streamId,
        response.status === 404 ? TransportErrorCode.unknownStream : `carrier-status-${response.status}`,
        state,
      )
      return
    }
    // Headers are in and the body is readable: the stream is established.
    post({ type: 'stream.open.ack', streamId, ok: true })
    await pumpStream(streamId, state, response.body)
  }

  /** Cancel a response body so the carrier's work ends; swallow the race with close. */
  const cancelResponseBody = async (response: Response): Promise<void> => {
    const body = response.body
    if (body === null) return
    await body.cancel().catch(() => undefined)
  }

  /** Pump one opened stream's body into ordered, credit-gated frames. */
  const pumpStream = async (streamId: string, state: StreamState, body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (streams.get(streamId) !== state) return
        for (let offset = 0; offset < value.byteLength;) {
          const slice = value.subarray(offset, offset + TRANSPORT_MAX_FRAME_BYTES)
          offset += slice.byteLength
          await state.window.reserve(slice.byteLength, state.controller.signal)
          if (streams.get(streamId) !== state) return
          post({ type: 'stream.frame', streamId, sequence: state.nextSequence++, data: slice })
        }
      }
      endStream(streamId, 'ended')
    } catch (error) {
      // Mid-stream read failure → one stream.error: the peer must see the
      // failure instead of a silent end (which reads as a normal disconnect).
      failStream(streamId, TransportErrorCode.internal, error instanceof Error ? error.message : String(error))
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // The stream closed under the reader; the lock is gone with it.
      }
      // Early exit (abort, channel teardown): stop the carrier's work now
      // instead of waiting for the source to notice.
      await body.cancel().catch(() => undefined)
    }
  }

  const onMessage = (value: unknown): void => {
    let message
    try {
      message = parseTransportMessage(value)
    } catch {
      // A malformed frame names no id; drop it. The peer's own sequence and
      // credit accounting will time the request out or end the stream.
      return
    }
    switch (message.type) {
      case 'fetch.open': {
        if (fetches.has(message.requestId)) {
          failFetch(message.requestId, TransportErrorCode.duplicateId, `duplicate fetch id ${message.requestId}`)
          return
        }
        fetches.set(message.requestId, {
          controller: new AbortController(),
          url: message.url,
          method: message.method,
          headers: message.headers,
          window: new TransportSendWindow(),
          chunks: [],
          bytes: 0,
          nextSequence: 0,
          finished: false,
        })
        return
      }
      case 'fetch.request.chunk': {
        const state = fetches.get(message.requestId)
        if (state === undefined) return
        if (message.sequence !== state.nextSequence) {
          failFetch(message.requestId, TransportErrorCode.badSequence, `expected sequence ${state.nextSequence}, got ${message.sequence}`)
          return
        }
        state.nextSequence++
        if (message.data.byteLength > TRANSPORT_MAX_FRAME_BYTES) {
          failFetch(message.requestId, TransportErrorCode.frameTooLarge, `request chunk of ${message.data.byteLength} bytes exceeds the transport frame bound`)
          return
        }
        state.chunks.push(message.data)
        state.bytes += message.data.byteLength
        if (state.bytes > maxRequestBytes) {
          failFetch(message.requestId, TransportErrorCode.requestTooLarge, `request body exceeds ${String(maxRequestBytes)} bytes`)
          return
        }
        // The bytes have left the wire and entered the accumulator: return
        // their credit so the sender's in-flight window frees them. The
        // crossing chunk is not credited — the operation is already over.
        post({ type: 'fetch.request.credit', requestId: message.requestId, credit: message.data.byteLength })
        return
      }
      case 'fetch.request.end': {
        const state = fetches.get(message.requestId)
        if (state === undefined || state.finished) return
        state.finished = true
        void runFetch(message.requestId, state)
        return
      }
      case 'fetch.abort': {
        const state = fetches.get(message.requestId)
        if (state === undefined) return
        state.controller.abort()
        fetches.delete(message.requestId)
        return
      }
      case 'fetch.response.credit': {
        // The state is gone once the request finishes; late credit for
        // finished work is a harmless no-op.
        fetches.get(message.requestId)?.window.addCredit(message.credit)
        return
      }
      case 'fetch.error':
        // Renderer-direction failures never come back to the runtime.
        return
      case 'stream.open': {
        if (streams.has(message.streamId)) {
          failStream(message.streamId, TransportErrorCode.duplicateId, `duplicate stream id ${message.streamId}`)
          return
        }
        const state: StreamState = {
          controller: new AbortController(),
          nextSequence: 0,
          nextUplinkSequence: 0,
          window: new TransportSendWindow(),
        }
        streams.set(message.streamId, state)
        void openStream(message.streamId, state, message.url)
        return
      }
      case 'stream.frame': {
        // Uplink frame: validate its sequence on this edge, then hand it to
        // the carrier binding. The pinned carrier serves downlinks only, so
        // an uplink frame on one is a protocol violation — answered and
        // closed the way the pinned WebSocket carrier answers it. A future
        // bidirectional carrier would consume the frame here and return
        // stream.credit as it does; the wire already carries both directions.
        const state = streams.get(message.streamId)
        if (state === undefined) return // late frame for a terminal stream
        if (message.sequence !== state.nextUplinkSequence) {
          failStream(message.streamId, TransportErrorCode.badSequence, `expected sequence ${state.nextUplinkSequence}, got ${message.sequence}`)
          return
        }
        state.nextUplinkSequence++
        failStream(message.streamId, TransportErrorCode.downlinkOnly, 'downlink streams are server to client only')
        return
      }
      case 'stream.credit': {
        streams.get(message.streamId)?.window.addCredit(message.credit)
        return
      }
      case 'stream.close': {
        const state = streams.get(message.streamId)
        if (state === undefined) return
        // End the carrier's work through its signal; the pump sees the state
        // is gone and exits without posting a second terminal.
        state.controller.abort()
        streams.delete(message.streamId)
        return
      }
      case 'stream.error': {
        if (!streams.has(message.streamId)) return
        endStream(message.streamId, message.message)
        return
      }
      case 'fetch.request.credit':
      case 'fetch.response.head':
      case 'fetch.response.chunk':
      case 'fetch.response.end':
      case 'stream.open.ack':
        // Messages this side sends; the runtime never receives them.
        return
    }
  }

  const endAll = (): void => {
    // End every in-flight operation instead of holding the plane; the quiet
    // terminals make this safe under a concurrent per-operation terminal.
    for (const state of fetches.values()) state.controller.abort()
    fetches.clear()
    for (const state of streams.values()) state.controller.abort()
    streams.clear()
  }

  const onClose = (): void => {
    // The broker tore the channel down (renderer gone or channel replaced):
    // end the channel's operations, but keep the adapter armed — the next
    // channel arrives on the same port.
    endAll()
  }

  port.on('message', onMessage)
  port.on('close', onClose)
  port.start()
  return () => {
    disposed = true
    port.removeListener('message', onMessage)
    port.removeListener('close', onClose)
    endAll()
  }
}

/** Concatenate buffered request chunks into one fresh body buffer. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
