/**
 * The private desktop native capability protocol: the closed wire contract
 * between the desktop runtime child and the Electron main capability
 * registry, carried on the supervisor's fork IPC channel (separate from the
 * stage 3 fetch/stream transport port). It moves OS capability calls —
 * opening a native directory chooser, opening a path with the default
 * application — and nothing else: the method set is closed and
 * schema-validated, every operation carries a unique request id, and no
 * message names or constrains any DSH business concept. The renderer never
 * sees this channel: requests originate only from the supervised runtime
 * child, and Electron main answers with OS capability vocabulary only.
 * Cancellation is directional and per-concept: `native.abort` (child→main)
 * tells main that the caller abandoned one request — main marks that
 * request logically terminal and drops its late OS completion, which a
 * physical native dialog may still finish in the background; `native.cancel`
 * (main→child) tells the runtime that the channel generation is dying.
 * @module @deepseek-ai/dsh-desktop-runtime/native
 */

/** The closed native method set: OS capability vocabulary, no DSH semantics. */
export type NativeMethod = 'directory.pick' | 'path.open'

/**
 * Structural bound on a path request: the largest path the desktop OS layer
 * can address (Windows long-path limit plus one). A request above it is a
 * protocol violation, refused before any OS API is invoked.
 */
export const NATIVE_MAX_PATH_LENGTH = 32_768

/**
 * The bound on every free-text field of the protocol (failure messages,
 * cancel and abort reasons): channel diagnostics stay small and
 * redaction-safe. Parsers enforce it at the wire boundary — a producing
 * side truncating its own outbound value is not the contract.
 */
export const NATIVE_MAX_DIAGNOSTIC_CHARS = 512

/** Closed failure vocabulary of the native channel (no DSH business codes). */
export type NativeErrorCode =
  | 'unknown-method'
  | 'malformed-request'
  | 'dialog-failed'
  | 'open-failed'
  | 'cancelled'

/** Open the OS directory chooser; the operator's selection or cancellation settles it. */
export interface NativeDirectoryPickRequest {
  type: 'native.request'
  requestId: string
  method: 'directory.pick'
}

/** Open one path with the default application. */
export interface NativePathOpenRequest {
  type: 'native.request'
  requestId: string
  method: 'path.open'
  path: string
}

export type NativeRequest = NativeDirectoryPickRequest | NativePathOpenRequest

/**
 * The success terminal. The chooser's outcome (an absolute path, or null for
 * the operator's cancel) rides only on the directory.pick success; a
 * path.open success carries no value.
 */
export type NativeSuccess =
  | { type: 'native.response'; requestId: string; ok: true; path: string | null }
  | { type: 'native.response'; requestId: string; ok: true }

/** The failure terminal: a closed code plus a bounded, redaction-safe message. */
export interface NativeFailure {
  type: 'native.response'
  requestId: string
  ok: false
  code: NativeErrorCode
  /** Bounded to {@link NATIVE_MAX_DIAGNOSTIC_CHARS}. */
  message: string
}

export type NativeResponse = NativeSuccess | NativeFailure

/** Main→child teardown signal for one pending operation (the channel is dying). */
export interface NativeCancel {
  type: 'native.cancel'
  requestId: string
  /** Bounded to {@link NATIVE_MAX_DIAGNOSTIC_CHARS}. */
  reason: string
}

/**
 * Child→main caller cancellation for one pending request: the DSH caller's
 * AbortSignal terminated the operation, so main marks the request logically
 * terminal and must drop its late OS completion (a visible native dialog may
 * still finish in the background; its result is discarded, not sent).
 */
export interface NativeAbort {
  type: 'native.abort'
  requestId: string
  /** Bounded to {@link NATIVE_MAX_DIAGNOSTIC_CHARS}. */
  reason: string
}

export type NativeMessage = NativeRequest | NativeResponse | NativeCancel | NativeAbort

/** Error thrown when a received value is not a well-formed native message. */
export class NativeProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeProtocolError'
  }
}

/** The closed method vocabulary, for diagnostics and validation messages. */
export const NATIVE_METHODS: readonly NativeMethod[] = ['directory.pick', 'path.open']

/** The closed error-code vocabulary, for diagnostics and validation messages. */
export const NATIVE_ERROR_CODES: readonly NativeErrorCode[] = [
  'unknown-method', 'malformed-request', 'dialog-failed', 'open-failed', 'cancelled',
]

function fail(message: string): never {
  throw new NativeProtocolError(message)
}

function readId(value: unknown, label: string): string {
  return typeof value === 'string' && value !== '' ? value : fail(`${label}: expected a non-empty string id`)
}

function readMethod(value: unknown): NativeMethod {
  return value === 'directory.pick' || value === 'path.open' ? value : fail(`method: expected one of ${NATIVE_METHODS.join(', ')}`)
}

/** The structural path check: a non-empty string without NUL, within the bound. */
function readPath(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    fail('path: expected a non-empty string without NUL bytes')
  }
  return value.length <= NATIVE_MAX_PATH_LENGTH ? value : fail(`path: ${String(value.length)} characters exceed the ${String(NATIVE_MAX_PATH_LENGTH)} character bound`)
}

function readErrorCode(value: unknown): NativeErrorCode {
  return value === 'unknown-method' || value === 'malformed-request' || value === 'dialog-failed' || value === 'open-failed' || value === 'cancelled'
    ? value
    : fail(`code: expected one of ${NATIVE_ERROR_CODES.join(', ')}`)
}

/**
 * Cheap child→main demux guard: the supervisor relays only this discriminant
 * to the capability registry, where the strict parser runs.
 * @param value - a structured-cloned child message.
 */
export function isNativeRequestMessage(value: unknown): value is { type: 'native.request' } {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'native.request'
}

/** Cheap runtime-side demux guard for the response family. */
export function isNativeResponseMessage(value: unknown): value is { type: 'native.response' } {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'native.response'
}

/** Cheap runtime-side demux guard for the cancel message. */
export function isNativeCancelMessage(value: unknown): value is { type: 'native.cancel' } {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'native.cancel'
}

/** Cheap main-side demux guard for the caller-abort message. */
export function isNativeAbortMessage(value: unknown): value is { type: 'native.abort' } {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'native.abort'
}

/** The bounded free-text check: a non-empty string within the diagnostic bound. */
function readBoundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') fail(`${label}: expected a non-empty string`)
  return value.length <= NATIVE_MAX_DIAGNOSTIC_CHARS
    ? value
    : fail(`${label}: ${String(value.length)} characters exceed the ${String(NATIVE_MAX_DIAGNOSTIC_CHARS)} character bound`)
}

/**
 * Validate one child→main request into a typed message. This is the wire
 * boundary: the registry parses every inbound request through it, and a
 * malformed request is a protocol refusal, never an OS call.
 * @param value - the structured-cloned request value.
 * @returns the validated request.
 */
export function parseNativeRequest(value: unknown): NativeRequest {
  if (value === null || typeof value !== 'object') fail('message: expected an object')
  const raw = value as Record<string, unknown>
  if (raw.type !== 'native.request') fail('type: expected "native.request"')
  const requestId = readId(raw.requestId, 'native.request.requestId')
  const method = readMethod(raw.method)
  if (method === 'directory.pick') return { type: 'native.request', requestId, method }
  return { type: 'native.request', requestId, method, path: readPath(raw.path) }
}

/**
 * Validate one main→child response into a typed message. The runtime parses
 * every response through it before settling a provider call: a malformed
 * response is dropped, never resolved into a DSH result.
 * @param value - the structured-cloned response value.
 * @returns the validated response.
 */
export function parseNativeResponse(value: unknown): NativeResponse {
  if (value === null || typeof value !== 'object') fail('message: expected an object')
  const raw = value as Record<string, unknown>
  if (raw.type !== 'native.response') fail('type: expected "native.response"')
  const requestId = readId(raw.requestId, 'native.response.requestId')
  if (raw.ok === true) {
    // The chooser outcome is optional at the wire; a directory.pick caller
    // settles only when it is present, so both shapes parse.
    if ('path' in raw && raw.path !== null && typeof raw.path !== 'string') {
      fail('native.response.path: expected a string or null')
    }
    return 'path' in raw
      ? { type: 'native.response', requestId, ok: true, path: raw.path as string | null }
      : { type: 'native.response', requestId, ok: true }
  }
  if (raw.ok === false) {
    return {
      type: 'native.response',
      requestId,
      ok: false,
      code: readErrorCode(raw.code),
      message: readBoundedText(raw.message, 'native.response.message'),
    }
  }
  fail('native.response.ok: expected a boolean')
}

/**
 * Validate one main→child cancel into a typed message.
 * @param value - the structured-cloned cancel value.
 * @returns the validated cancel.
 */
export function parseNativeCancel(value: unknown): NativeCancel {
  if (value === null || typeof value !== 'object') fail('message: expected an object')
  const raw = value as Record<string, unknown>
  if (raw.type !== 'native.cancel') fail('type: expected "native.cancel"')
  return {
    type: 'native.cancel',
    requestId: readId(raw.requestId, 'native.cancel.requestId'),
    reason: readBoundedText(raw.reason, 'native.cancel.reason'),
  }
}

/**
 * Validate one child→main caller abort into a typed message. The channel
 * parses every inbound abort through it; a malformed abort is dropped,
 * never treated as a settlement.
 * @param value - the structured-cloned abort value.
 * @returns the validated abort.
 */
export function parseNativeAbort(value: unknown): NativeAbort {
  if (value === null || typeof value !== 'object') fail('message: expected an object')
  const raw = value as Record<string, unknown>
  if (raw.type !== 'native.abort') fail('type: expected "native.abort"')
  return {
    type: 'native.abort',
    requestId: readId(raw.requestId, 'native.abort.requestId'),
    reason: readBoundedText(raw.reason, 'native.abort.reason'),
  }
}
