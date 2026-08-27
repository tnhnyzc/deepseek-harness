/**
 * The private desktop transport protocol: one wire contract shared by the
 * renderer client, the Electron main dumb broker, and the desktop runtime
 * adapter. Two message families: the fetch request/response family
 * (primitive A) and the opaque bidirectional stream family (primitive B).
 *
 * The protocol is deliberately business-logic agnostic: ids, urls, and frame
 * bytes are opaque to every desktop layer, and no message names or constrains
 * DSH semantics. A new DSH host-plane method or event stream is transported
 * without any desktop change.
 *
 * Backpressure: each direction of a request or stream starts with
 * {@link TRANSPORT_CREDIT_BYTES} of send credit; the receiver returns credit
 * as it consumes — `fetch.response.credit` when a response chunk enters the
 * consumer's queue, `fetch.request.credit` as the runtime accumulates the
 * request body, `stream.credit` when the consumer dequeues a frame — so a
 * slow or abandoned peer can never hold more than one window of bytes in
 * flight across the IPC edges. The credit messages are the stage 3 addition
 * to the SPEC §9 example protocol, which §10 requires ("pause/resume or
 * credit signaling if required").
 * @module @deepseek-ai/dsh-desktop-runtime/transport
 */

/**
 * Fixed maximum size for any `data` field of any data-bearing message, in
 * either direction, at every edge (SPEC §10: fixed maximum chunk size). A
 * larger logical body is split into several frames by its producer; a single
 * oversized frame is a protocol violation that edges refuse locally.
 */
export const TRANSPORT_MAX_FRAME_BYTES = 64 * 1024

/** Initial per-direction send credit; receivers return it as they consume. */
export const TRANSPORT_CREDIT_BYTES = 256 * 1024

/**
 * The semantic total-request limit (SPEC §10): how large one complete fetch
 * request may be. It matches the pinned DSH client's carrier default,
 * `DEFAULT_MAX_REQUEST_BODY_BYTES` (300 MiB,
 * `packages/client/connection/src/http-bridge.ts:12`), which the pinned
 * client-connection validates at load against the attachment image limits
 * (`assertImageBodyCapacity`, `packages/client/connection/src/index.ts:32-44`:
 * `ceil(maxMessageImageBytes * 4/3)` plus a 1 MiB envelope headroom — about
 * 267.7 MiB at the attachment-local default of 200 MiB,
 * `packages/attachment/attachment-local/src/index.ts:32`). A desktop ceiling
 * below the carrier default would refuse requests the pinned client
 * considers valid, so the transport adopts the carrier-level maximum rather
 * than any attachment configuration.
 *
 * This total is deliberately separate from the transport high-water mark:
 * the request pump is gated by {@link TRANSPORT_CREDIT_BYTES} of
 * `fetch.request.credit`, so at most one window of request bytes is ever
 * unacknowledged in flight across the renderer→runtime IPC, no matter how
 * large the allowed request is. The runtime buffers the accepted body whole
 * because the in-process carrier materializes it before it can answer
 * (`req.json()`); that buffer is the request itself, not IPC queueing. An
 * over-bound request is a protocol refusal, not a stall.
 */
export const TRANSPORT_MAX_REQUEST_BYTES = 300 * 1024 * 1024

/**
 * The bound on one wire id (request id, stream id). Ids are minted with
 * `crypto.randomUUID()` (36 characters); the bound is a wire-trust limit,
 * not a format: over-bound ids are a protocol refusal, never an allocation.
 */
export const TRANSPORT_MAX_ID_CHARS = 512

/** The bound on one url field, sized to the HTTP request-line norm. */
export const TRANSPORT_MAX_URL_CHARS = 8192

/** The bound on one HTTP method field (any RFC method token fits with room). */
export const TRANSPORT_MAX_METHOD_CHARS = 16

/** The bound on the header-pair count of one message. */
export const TRANSPORT_MAX_HEADER_COUNT = 256

/** The bound on one header name. */
export const TRANSPORT_MAX_HEADER_NAME_CHARS = 256

/** The bound on one header value, sized to the HTTP header-buffer norm. */
export const TRANSPORT_MAX_HEADER_VALUE_CHARS = 8192

/** The bound on one status-text field. */
export const TRANSPORT_MAX_STATUS_TEXT_CHARS = 256

/** The bound on one error-code field (short slugs). */
export const TRANSPORT_MAX_CODE_CHARS = 64

/** The bound on one error-message field (short diagnostics). */
export const TRANSPORT_MAX_MESSAGE_CHARS = 1024

/** The bound on one optional reason field. */
export const TRANSPORT_MAX_REASON_CHARS = 256

/**
 * The bound on in-flight transport operations per runtime adapter (fetches
 * plus streams, pending or active). Each open stream is a live in-process
 * carrier fetch for its whole lifetime, so an unbounded map is an
 * unbounded set of carrier operations a peer can hold open. The bound is
 * far above the client's ordinary concurrency (single-digit RPCs plus its
 * two event streams); a peer over it is refused per open, not dropped.
 */
export const TRANSPORT_MAX_CONCURRENT_OPERATIONS = 128

/** Transport-level error codes (business error codes ride inside the payload, not here). */
export const TransportErrorCode = {
  aborted: 'aborted',
  badSequence: 'bad-sequence',
  duplicateId: 'duplicate-id',
  frameTooLarge: 'frame-too-large',
  requestTooLarge: 'request-too-large',
  unknownStream: 'unknown-stream',
  downlinkOnly: 'downlink-only',
  transportClosed: 'transport-closed',
  internal: 'internal',
  tooManyRequests: 'too-many-requests',
} as const

export type TransportErrorCodeValue = (typeof TransportErrorCode)[keyof typeof TransportErrorCode]

/**
 * The complete discriminant set. Shared IPC channels carry transport
 * messages alongside control messages (e.g. `runtime.ready`); a channel edge
 * demultiplexes by this set.
 */
export const TRANSPORT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'fetch.open',
  'fetch.request.chunk',
  'fetch.request.end',
  'fetch.request.credit',
  'fetch.abort',
  'fetch.response.head',
  'fetch.response.chunk',
  'fetch.response.end',
  'fetch.response.credit',
  'fetch.error',
  'stream.open',
  'stream.open.ack',
  'stream.frame',
  'stream.credit',
  'stream.close',
  'stream.error',
])

/** Whether `value` is, on the wire, a transport message (control messages are not). */
export function isTransportMessage(value: unknown): value is { type: string } {
  return value !== null && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
    && TRANSPORT_MESSAGE_TYPES.has((value as { type: string }).type)
}

/**
 * The byte-field marker for structured-clone channels that do not preserve
 * typed arrays. Node `child_process` IPC degrades `Uint8Array` to a plain
 * object, so the main↔runtime edge carries `data` as
 * `{ [TRANSPORT_DATA_MARKER]: base64 }`; every other edge (MessagePorts)
 * carries the raw bytes. The codec is symmetric: each edge encodes outbound
 * values and decodes inbound ones, so both the broker's size guard and the
 * protocol parser see `Uint8Array` only.
 */
export const TRANSPORT_DATA_MARKER = '__dshTransportData'

/**
 * Encode one value for a channel that drops typed arrays.
 * @param value - a transport message (or anything else, passed through).
 * @returns the encodable value.
 */
export function toOpaqueTransportWire(value: object): object {
  const message = value as { type?: unknown; data?: unknown }
  if (typeof message.type === 'string' && message.data instanceof Uint8Array) {
    return { ...value, data: { [TRANSPORT_DATA_MARKER]: Buffer.from(message.data).toString('base64') } }
  }
  return value
}

/**
 * Decode one value from a channel that drops typed arrays.
 * @param value - an inbound structured-cloned value.
 * @returns the decoded object, or the input unchanged when it carries no marker.
 */
export function fromOpaqueTransportWire(value: unknown): object | null {
  if (value === null || typeof value !== 'object') return null
  const message = value as { type?: unknown; data?: unknown }
  if (typeof message.type !== 'string' || message.data === null || typeof message.data !== 'object' || Array.isArray(message.data)) {
    return value
  }
  const payload = (message.data as { [key: string]: unknown })[TRANSPORT_DATA_MARKER]
  if (typeof payload !== 'string') return value
  return { ...value, data: new Uint8Array(Buffer.from(payload, 'base64')) }
}

/** Primitive A — fetch request start. `url` is opaque; the runtime routes by pathname. */
export interface FetchOpen {
  type: 'fetch.open'
  requestId: string
  url: string
  method: string
  headers: Array<[string, string]>
}

/** Primitive A — one request-body chunk; `sequence` increases from 0, no reordering. */
export interface FetchRequestChunk {
  type: 'fetch.request.chunk'
  requestId: string
  sequence: number
  data: Uint8Array
}

/** Primitive A — the request body is complete. */
export interface FetchRequestEnd {
  type: 'fetch.request.end'
  requestId: string
}

/** Primitive A — the runtime returns request-body send credit as it accumulates the body. */
export interface FetchRequestCredit {
  type: 'fetch.request.credit'
  requestId: string
  credit: number
}

/** Primitive A — the renderer cancels the request; MUST reach DSH as an AbortSignal. */
export interface FetchAbort {
  type: 'fetch.abort'
  requestId: string
  reason?: string
}

/** Primitive A — response start; the body arrives as chunks until end. */
export interface FetchResponseHead {
  type: 'fetch.response.head'
  requestId: string
  status: number
  statusText: string
  headers: Array<[string, string]>
}

/** Primitive A — one response-body chunk; `sequence` increases from 0, no reordering. */
export interface FetchResponseChunk {
  type: 'fetch.response.chunk'
  requestId: string
  sequence: number
  data: Uint8Array
}

/** Primitive A — the response body is complete. */
export interface FetchResponseEnd {
  type: 'fetch.response.end'
  requestId: string
}

/** Primitive A — the renderer returns response-body send credit it has consumed. */
export interface FetchResponseCredit {
  type: 'fetch.response.credit'
  requestId: string
  credit: number
}

/** Primitive A — terminal: the request failed at the transport or was refused. */
export interface FetchError {
  type: 'fetch.error'
  requestId: string
  code: string
  message: string
}

/**
 * Primitive B — open an opaque stream. `url` is the endpoint as the DSH
 * client names it, absolute: the renderer resolves it against the transport
 * dummy origin before it goes on the wire, so the runtime's carrier sees the
 * same url form a fetch would.
 */
export interface StreamOpen {
  type: 'stream.open'
  streamId: string
  url: string
}

/** Primitive B — the runtime accepts (or refuses) the open. */
export interface StreamOpenAck {
  type: 'stream.open.ack'
  streamId: string
  ok: boolean
  reason?: string
}

/** Primitive B — one ordered frame; bytes are opaque; `sequence` increases from 0. */
export interface StreamFrame {
  type: 'stream.frame'
  streamId: string
  sequence: number
  data: Uint8Array
}

/** Primitive B — the receiver returns frame send credit it has consumed. */
export interface StreamCredit {
  type: 'stream.credit'
  streamId: string
  credit: number
}

/** Primitive B — close after in-flight frames settle; terminal. */
export interface StreamClose {
  type: 'stream.close'
  streamId: string
  reason?: string
}

/** Primitive B — terminal failure of the stream. */
export interface StreamError {
  type: 'stream.error'
  streamId: string
  code: string
  message: string
}

/** The complete desktop transport wire union. */
export type DesktopTransportMessage =
  | FetchOpen
  | FetchRequestChunk
  | FetchRequestEnd
  | FetchRequestCredit
  | FetchAbort
  | FetchResponseHead
  | FetchResponseChunk
  | FetchResponseEnd
  | FetchResponseCredit
  | FetchError
  | StreamOpen
  | StreamOpenAck
  | StreamFrame
  | StreamCredit
  | StreamClose
  | StreamError

/**
 * The minimal port surface a transport edge needs. A Node
 * `worker_threads.MessagePort` satisfies it (tests, and any future port
 * delivery), and the runtime entry satisfies it with an adapter over the
 * child IPC channel — Node `child_process` cannot transfer a MessagePort, so
 * the main↔runtime edge relays the same wire messages over structured clone
 * instead of transferring a port.
 */
export interface TransportPort {
  readonly readyState: string
  postMessage(message: object, transfer?: readonly ArrayBuffer[]): void
  /** Begin delivery (Node ports are inert until started; a no-op where the channel is live). */
  start(): void
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  removeListener(event: 'message', listener: (value: unknown) => void): unknown
  removeListener(event: 'close', listener: () => void): unknown
}

/** Error thrown when a received value is not a well-formed transport message. */
export class TransportProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportProtocolError'
  }
}

function fail(message: string): never {
  throw new TransportProtocolError(message)
}

function readId(value: unknown, label: string): string {
  return readBoundedText(value, `${label}: expected a non-empty string id`, TRANSPORT_MAX_ID_CHARS, label)
}

/**
 * The bounded string check: the shared enforcement for every metadata field,
 * so each field's bound is a refusal at the wire, not an allocation the peer
 * can force.
 * @param value - the received value
 * @param expected - the refusal text when the value is not a string
 * @param max - the character bound
 * @param label - the field name for the over-bound refusal
 * @param nonEmpty - whether the empty string is also a refusal (default true)
 * @returns the value
 */
function readBoundedText(value: unknown, expected: string, max: number, label: string, nonEmpty: boolean = true): string {
  if (typeof value !== 'string' || (nonEmpty && value === '')) fail(expected)
  return value.length <= max ? value : fail(`${label}: ${String(value.length)} characters exceed the ${String(max)} character bound`)
}

function readSequence(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fail('sequence: expected an integer >= 0')
}

function readCredit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fail('credit: expected an integer >= 0')
}

function readData(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : fail('data: expected a Uint8Array')
}

function readHeaders(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) fail('headers: expected an array of [name, value] pairs')
  if (value.length > TRANSPORT_MAX_HEADER_COUNT) {
    fail(`headers: ${String(value.length)} pairs exceed the ${String(TRANSPORT_MAX_HEADER_COUNT)} pair bound`)
  }
  return value.map((pair, index) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      fail(`headers[${index}]: expected a [name, value] pair`)
    }
    const name = pair[0]
    const nameOver = name.length > TRANSPORT_MAX_HEADER_NAME_CHARS
    const valueOver = pair[1].length > TRANSPORT_MAX_HEADER_VALUE_CHARS
    if (nameOver || valueOver) {
      fail(`headers[${index}]: a field exceeds the ${String(TRANSPORT_MAX_HEADER_NAME_CHARS)}/${String(TRANSPORT_MAX_HEADER_VALUE_CHARS)} character bound`)
    }
    return [name, pair[1]] as [string, string]
  })
}

/**
 * The optional reason check: absent or empty is dropped (never materialized
 * as undefined), a string is bound-checked, and a wrong type is dropped as
 * before the bound existed.
 * @param value - the received value
 * @param label - the field name for the over-bound refusal
 * @returns the value, or undefined to drop the field
 */
function readOptionalReason(value: unknown, label: string): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value.length <= TRANSPORT_MAX_REASON_CHARS
    ? value
    : fail(`${label}: ${String(value.length)} characters exceed the ${String(TRANSPORT_MAX_REASON_CHARS)} character bound`)
}

/**
 * Validate one value received over a transport channel into a typed message.
 * This is the wire boundary: both edges parse every inbound message through
 * it, and a malformed message is a transport failure, never a business error.
 * Beyond the discriminant and field-type checks it enforces the protocol's
 * character bounds on every metadata field (ids, urls, methods, headers,
 * status, codes, messages, reasons), so an over-bound field is refused at
 * the wire instead of becoming an allocation the sender forced.
 * @param value - the structured-cloned message value.
 * @returns the validated message.
 */
export function parseTransportMessage(value: unknown): DesktopTransportMessage {
  if (value === null || typeof value !== 'object') fail('message: expected an object')
  const raw = value as Record<string, unknown>
  const type: unknown = raw.type
  switch (type) {
    case 'fetch.open': {
      const headers = readHeaders(raw.headers)
      return {
        type,
        requestId: readId(raw.requestId, 'fetch.open.requestId'),
        url: readBoundedText(raw.url, 'fetch.open.url: expected a non-empty string', TRANSPORT_MAX_URL_CHARS, 'fetch.open.url'),
        method: readBoundedText(raw.method, 'fetch.open.method: expected a non-empty string', TRANSPORT_MAX_METHOD_CHARS, 'fetch.open.method'),
        headers,
      }
    }
    case 'fetch.request.chunk':
      return {
        type,
        requestId: readId(raw.requestId, 'fetch.request.chunk.requestId'),
        sequence: readSequence(raw.sequence),
        data: readData(raw.data),
      }
    case 'fetch.request.end':
      return { type, requestId: readId(raw.requestId, 'fetch.request.end.requestId') }
    case 'fetch.request.credit':
      return { type, requestId: readId(raw.requestId, 'fetch.request.credit.requestId'), credit: readCredit(raw.credit) }
    case 'fetch.abort': {
      const reason = readOptionalReason(raw.reason, 'fetch.abort.reason')
      return { type, requestId: readId(raw.requestId, 'fetch.abort.requestId'), ...(reason !== undefined ? { reason } : {}) }
    }
    case 'fetch.response.head':
      return {
        type,
        requestId: readId(raw.requestId, 'fetch.response.head.requestId'),
        status: typeof raw.status === 'number' && Number.isInteger(raw.status) && raw.status >= 0 && raw.status <= 999
          ? raw.status
          : fail('fetch.response.head.status: expected an integer status in 0..999'),
        statusText: readBoundedText(raw.statusText, 'fetch.response.head.statusText: expected a string', TRANSPORT_MAX_STATUS_TEXT_CHARS, 'fetch.response.head.statusText', false),
        headers: readHeaders(raw.headers),
      }
    case 'fetch.response.chunk':
      return {
        type,
        requestId: readId(raw.requestId, 'fetch.response.chunk.requestId'),
        sequence: readSequence(raw.sequence),
        data: readData(raw.data),
      }
    case 'fetch.response.end':
      return { type, requestId: readId(raw.requestId, 'fetch.response.end.requestId') }
    case 'fetch.response.credit':
      return { type, requestId: readId(raw.requestId, 'fetch.response.credit.requestId'), credit: readCredit(raw.credit) }
    case 'fetch.error':
      return {
        type,
        requestId: readId(raw.requestId, 'fetch.error.requestId'),
        code: readBoundedText(raw.code, 'fetch.error.code: expected a non-empty string', TRANSPORT_MAX_CODE_CHARS, 'fetch.error.code'),
        message: readBoundedText(raw.message, 'fetch.error.message: expected a string', TRANSPORT_MAX_MESSAGE_CHARS, 'fetch.error.message', false),
      }
    case 'stream.open':
      return {
        type,
        streamId: readId(raw.streamId, 'stream.open.streamId'),
        url: readBoundedText(raw.url, 'stream.open.url: expected a non-empty string', TRANSPORT_MAX_URL_CHARS, 'stream.open.url'),
      }
    case 'stream.open.ack': {
      const reason = readOptionalReason(raw.reason, 'stream.open.ack.reason')
      return {
        type,
        streamId: readId(raw.streamId, 'stream.open.ack.streamId'),
        ok: typeof raw.ok === 'boolean' ? raw.ok : fail('stream.open.ack.ok: expected a boolean'),
        ...(reason !== undefined ? { reason } : {}),
      }
    }
    case 'stream.frame':
      return {
        type,
        streamId: readId(raw.streamId, 'stream.frame.streamId'),
        sequence: readSequence(raw.sequence),
        data: readData(raw.data),
      }
    case 'stream.credit':
      return { type, streamId: readId(raw.streamId, 'stream.credit.streamId'), credit: readCredit(raw.credit) }
    case 'stream.close': {
      const reason = readOptionalReason(raw.reason, 'stream.close.reason')
      return { type, streamId: readId(raw.streamId, 'stream.close.streamId'), ...(reason !== undefined ? { reason } : {}) }
    }
    case 'stream.error':
      return {
        type,
        streamId: readId(raw.streamId, 'stream.error.streamId'),
        code: readBoundedText(raw.code, 'stream.error.code: expected a non-empty string', TRANSPORT_MAX_CODE_CHARS, 'stream.error.code'),
        message: readBoundedText(raw.message, 'stream.error.message: expected a string', TRANSPORT_MAX_MESSAGE_CHARS, 'stream.error.message', false),
      }
    default:
      fail(`message.type: unknown discriminant ${String(type)}`)
  }
}

/** Whether a message carries frame or body bytes (the size guard's only interest). */
export function transportMessageDataBytes(message: DesktopTransportMessage): number {
  if (message.type === 'fetch.request.chunk' || message.type === 'fetch.response.chunk' || message.type === 'stream.frame') {
    return message.data.byteLength
  }
  return 0
}

/**
 * Bounded send window: the sender may hold at most the configured window's
 * bytes in flight (sent but not yet credited back). The receiver returns
 * credit as it consumes; `reserve` is called by the sender before each send
 * and awaits until the bytes fit. Returned credit can never push available
 * credit above the configured maximum — the high-water mark is the window
 * itself, so a malformed or excessive credit is clamped, not accumulated.
 * `cancel` ends the window with its operation: parked reservations wake
 * without credit and later reservations fail.
 */
/** A parked reservation; woken by returned credit or by the operation's cancellation. */
interface WindowWaiter {
  wake(): void
}

export class TransportSendWindow {
  private readonly max: number
  private free: number
  private waiters: Array<WindowWaiter> = []
  private cancelled = false

  constructor(window: number = TRANSPORT_CREDIT_BYTES) {
    if (typeof window !== 'number' || !Number.isInteger(window) || window <= 0) {
      throw new TransportProtocolError(`send window: expected an integer window > 0, got ${String(window)}`)
    }
    this.max = window
    this.free = window
  }

  /** The configured maximum (the high-water mark). */
  get window(): number {
    return this.max
  }

  /** Bytes of credit currently outstanding (never above the window). */
  available(): number {
    return this.free
  }

  /** The receiver consumed (or refused to buffer) `bytes`; return the credit, clamped at the window. */
  addCredit(bytes: number): void {
    if (bytes <= 0 || this.cancelled) return
    this.free = Math.min(this.max, this.free + bytes)
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.wake()
  }

  /**
   * Cancel the window with its operation: wake every parked reservation
   * without granting credit and fail every later reservation. Used when the
   * owning operation reaches a terminal, so a parked `send` cannot hold on
   * past the stream it was gating.
   */
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.wake()
  }

  /**
   * Reserve `bytes` of send credit, awaiting returned credit if none is
   * outstanding. A single frame can never exceed this window.
   *
   * @param bytes - bytes to reserve.
   * @param signal - the owning operation's cancellation; when it aborts while
   *   the reservation is parked, `reserve` returns without reserving so the
   *   caller's liveness guard can end the operation instead of waiting on
   *   credit that will never come.
   * @throws when `bytes` exceeds this window (a protocol violation by the sender)
   *   or the window was cancelled with its operation.
   */
  async reserve(bytes: number, signal?: AbortSignal): Promise<void> {
    if (bytes > this.max) throw new TransportProtocolError(`send window: ${bytes} bytes exceeds the window of ${String(this.max)}`)
    for (;;) {
      if (this.cancelled) throw new TransportProtocolError('send window: cancelled')
      if (bytes <= this.free) {
        this.free -= bytes
        return
      }
      await new Promise<void>((resolve) => {
        let onAbort: (() => void) | undefined
        if (signal !== undefined && !signal.aborted) {
          onAbort = (): void => { resolve() }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        this.waiters.push({
          wake: (): void => {
            if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort)
            resolve()
          },
        })
      })
      if (signal?.aborted) return // cancelled while parked: the caller's guard takes over
    }
  }
}
