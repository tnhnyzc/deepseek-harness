/**
 * The desktop runtime side of the transport: it consumes the wire protocol on
 * a MessagePort and serves it from the booted host communication plane.
 * Fetch traffic is routed through `toFetchHandler(ctx.apiProxy)` — the
 * in-process seam, no HTTP; stream traffic attaches to the host event
 * downlinks (`api.events.mux` / `api.events.host`) and frames the exact
 * `ServerRequest` JSON envelopes the pinned Web carrier serves over
 * WebSocket. The adapter never inspects payloads beyond transport metadata.
 * @module @deepseek-ai/dsh-desktop-runtime/transport-runtime
 */

import {
  RpcId,
  toFetchHandler,
  type ApiProxy,
  type HostFrame,
  type MuxFrame,
  type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import {
  TRANSPORT_MAX_FRAME_BYTES,
  TRANSPORT_MAX_REQUEST_BYTES,
  TransportErrorCode,
  TransportSendWindow,
  parseTransportMessage,
  type FetchResponseHead,
  type TransportPort,
} from './transport.ts'

/** The two host event downlinks a stream can attach to, by the url the DSH client names them. */
const STREAM_DOWNLINKS: Record<string, (api: ApiProxy, signal: AbortSignal) => AsyncIterable<RpcRequest<MuxFrame | HostFrame>>> = {
  '/api/events.mux': (api, signal) => api.events.mux({ rpcId: RpcId(crypto.randomUUID()), payload: {} }, signal),
  '/api/events.host': (api, signal) => api.events.host({ rpcId: RpcId(crypto.randomUUID()), payload: {} }, signal),
}

/** Complete one narrow RpcRequest into the ServerRequest full form the downlink frames carry. */
function fullFrame(narrow: RpcRequest<MuxFrame | HostFrame>): { type: 'server-request'; rpcId: string; method: string; payload: unknown } {
  return { type: 'server-request', rpcId: narrow.rpcId, method: narrow.payload.type, payload: narrow.payload }
}

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
  nextSequence: number
  window: TransportSendWindow
  pumpDone: boolean
}

/**
 * Attach the transport to the booted host plane on the given port.
 * @param port - the port the dumb broker relays to this runtime (a
 * `MessagePort` in tests; the child IPC adapter in the runtime entry).
 * @param api - the host communication plane (`ctx.apiProxy`).
 * @returns the disposer: aborts every in-flight operation and detaches.
 */
export function attachTransportRuntime(port: TransportPort, api: ApiProxy): () => void {
  const encoder = new TextEncoder()
  const handler = toFetchHandler(api)
  const fetches = new Map<string, FetchState>()
  const streams = new Map<string, StreamState>()
  let disposed = false

  const post = (message: object, transfer?: ArrayBuffer): void => {
    if (disposed || port.readyState === 'closed') return
    if (transfer !== undefined) port.postMessage(message, [transfer])
    else port.postMessage(message)
  }

  const endFetch = (requestId: string): void => {
    fetches.delete(requestId)
    post({ type: 'fetch.response.end', requestId })
  }

  const failFetch = (requestId: string, code: string, message: string): void => {
    const state = fetches.get(requestId)
    if (state !== undefined) state.controller.abort()
    fetches.delete(requestId)
    post({ type: 'fetch.error', requestId, code, message })
  }

  const endStream = (streamId: string, reason?: string): void => {
    const state = streams.get(streamId)
    if (state !== undefined) state.pumpDone = true
    streams.delete(streamId)
    post({ type: 'stream.close', streamId, ...(reason !== undefined ? { reason } : {}) })
  }

  const failStream = (streamId: string, code: string, message: string): void => {
    const state = streams.get(streamId)
    if (state !== undefined) {
      state.controller.abort()
      state.pumpDone = true
    }
    streams.delete(streamId)
    post({ type: 'stream.error', streamId, code, message })
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
    const reader = response.body.getReader()
    let nextSequence = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (fetches.get(requestId) !== state) return
        for (let offset = 0; offset < value.byteLength;) {
          const slice = value.subarray(offset, offset + TRANSPORT_MAX_FRAME_BYTES)
          offset += slice.byteLength
          await state.window.reserve(slice.byteLength)
          if (fetches.get(requestId) !== state) return
          post({ type: 'fetch.response.chunk', requestId, sequence: nextSequence++, data: slice })
        }
      }
      endFetch(requestId)
    } catch (error) {
      // Body read failure mid-stream: the head already went out, so this is a
      // terminal fetch.error the client surfaces as a body failure.
      failFetch(requestId, TransportErrorCode.internal, error instanceof Error ? error.message : String(error))
    }
  }

  /** Pump one attached downlink into ordered, credit-gated stream frames. */
  const pumpStream = async (streamId: string, frames: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>): Promise<void> => {
    const state = streams.get(streamId)
    if (state === undefined) return
    try {
      for await (const narrow of frames) {
        if (streams.get(streamId) !== state) return
        const data = encoder.encode(JSON.stringify(fullFrame(narrow)))
        if (data.byteLength > TRANSPORT_MAX_FRAME_BYTES) {
          failStream(streamId, TransportErrorCode.frameTooLarge, `downlink frame of ${data.byteLength} bytes exceeds the transport frame bound`)
          return
        }
        await state.window.reserve(data.byteLength)
        if (streams.get(streamId) !== state) return
        post({ type: 'stream.frame', streamId, sequence: state.nextSequence++, data }, data.buffer)
      }
      if (streams.get(streamId) === state) endStream(streamId, 'ended')
    } catch (error) {
      // Mid-stream impl failure → one stream.error, then closed: the client
      // must see the failure instead of a silent end (mirrors the SSE seam).
      if (streams.get(streamId) === state) {
        failStream(streamId, TransportErrorCode.internal, error instanceof Error ? error.message : String(error))
      }
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
        if (state.bytes > TRANSPORT_MAX_REQUEST_BYTES) {
          failFetch(message.requestId, TransportErrorCode.requestTooLarge, `request body exceeds ${TRANSPORT_MAX_REQUEST_BYTES} bytes`)
        }
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
        const downlink = STREAM_DOWNLINKS[message.url]
        if (downlink === undefined) {
          post({ type: 'stream.open.ack', streamId: message.streamId, ok: false, reason: TransportErrorCode.unknownStream })
          return
        }
        const state: StreamState = {
          controller: new AbortController(),
          nextSequence: 0,
          window: new TransportSendWindow(),
          pumpDone: false,
        }
        streams.set(message.streamId, state)
        post({ type: 'stream.open.ack', streamId: message.streamId, ok: true })
        void pumpStream(message.streamId, downlink(api, state.controller.signal))
        return
      }
      case 'stream.frame': {
        // Pinned downlinks are server→client only: a client frame on a
        // downlink stream is a protocol violation, answered and closed the
        // way the pinned WebSocket carrier does it.
        if (!streams.has(message.streamId)) return
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
        state.controller.abort()
        state.pumpDone = true
        streams.delete(message.streamId)
        return
      }
      case 'stream.error': {
        if (!streams.has(message.streamId)) return
        endStream(message.streamId, message.message)
        return
      }
      case 'fetch.response.head':
      case 'fetch.response.chunk':
      case 'fetch.response.end':
      case 'stream.open.ack':
        // Renderer-direction-only messages; the runtime never receives them.
        return
    }
  }

  const onClose = (): void => {
    // The broker tore the channel down (renderer gone or channel replaced):
    // end every in-flight operation instead of holding the plane, but keep
    // the adapter armed — the next channel arrives on the same port.
    for (const state of fetches.values()) state.controller.abort()
    fetches.clear()
    for (const state of streams.values()) {
      state.controller.abort()
      state.pumpDone = true
    }
    streams.clear()
  }

  port.on('message', onMessage)
  port.on('close', onClose)
  port.start()
  return () => {
    disposed = true
    port.removeListener('message', onMessage)
    port.removeListener('close', onClose)
    for (const state of fetches.values()) state.controller.abort()
    fetches.clear()
    for (const state of streams.values()) {
      state.controller.abort()
      state.pumpDone = true
    }
    streams.clear()
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
