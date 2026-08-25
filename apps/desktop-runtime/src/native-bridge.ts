/**
 * The runtime child's half of the native capability channel: a closed
 * request/response client over the supervisor's fork IPC. Every operation
 * carries a unique request id and the caller's AbortSignal for its whole
 * lifetime — an abort settles the operation with the abort terminal, the
 * operation becomes terminal, and any late response or cancel is ignored.
 * Channel death (the supervisor disconnecting) settles every pending
 * operation with the channel-closed failure; no pending operation survives
 * the channel.
 * @module @deepseek-ai/dsh-desktop-runtime/native-bridge
 */

import { randomUUID } from 'node:crypto'
import {
  isNativeCancelMessage,
  isNativeResponseMessage,
  parseNativeCancel,
  parseNativeResponse,
  type NativeErrorCode,
  type NativeMethod,
  type NativeMessage,
} from './native.ts'

/** One native operation's failure, tagged with the closed channel code. */
export class NativeError extends Error {
  constructor(readonly code: NativeErrorCode | 'channel-closed', message: string) {
    super(message)
    this.name = 'NativeError'
  }
}

/** The runtime's native capability surface (the OS layer behind DSH seats). */
export interface NativeBridge {
  /**
   * Open the OS directory chooser.
   * @param signal - caller lifetime; abort terminates the operation as cancellation.
   * @returns the chosen absolute path, or null when the operator cancels.
   */
  pickDirectory(signal: AbortSignal): Promise<string | null>
  /**
   * Open one path with the default application.
   * @param path - the absolute path the DSH layer resolved and authorized.
   * @param signal - caller lifetime; abort terminates the operation as cancellation.
   */
  openPath(path: string, signal: AbortSignal): Promise<void>
  /** Settle every pending operation with the channel-closed failure; idempotent. */
  dispose(): void
}

/** The channel seam: the child IPC by default, injectable for tests. */
export interface NativeBridgeOptions {
  /** Deliver one message to the supervisor (a no-op when the channel is gone). */
  send?: (message: NativeMessage) => void
  /** Subscribe to inbound supervisor messages; returns the unsubscriber. */
  onMessage?: (listener: (value: unknown) => void) => () => void
  /** Subscribe to channel death; returns the unsubscriber. */
  onDisconnect?: (listener: () => void) => () => void
}

interface PendingOperation {
  method: NativeMethod
  signal: AbortSignal
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  /** The abort listener, removed when the operation actually terminates. */
  onAbort: (() => void) | undefined
  terminal: boolean
}

/** The abort terminal: the DSH layer maps it to its `cancelled` business code. */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Create the native capability client.
 * @param options - the channel seam (defaults to the child IPC).
 * @returns the bridge surface the DSH seats call.
 */
export function createNativeBridge(options: NativeBridgeOptions = {}): NativeBridge {
  const send = options.send ?? ((message: NativeMessage): void => {
    if (process.send === undefined || !process.connected) return
    process.send(message)
  })
  const subscribeMessage = options.onMessage ?? ((listener: (value: unknown) => void): (() => void) => {
    process.on('message', listener)
    return () => { process.off('message', listener) }
  })
  const subscribeDisconnect = options.onDisconnect ?? ((listener: () => void): (() => void) => {
    process.on('disconnect', listener)
    return () => { process.off('disconnect', listener) }
  })

  const pending = new Map<string, PendingOperation>()
  let disposed = false
  let unsubscribeMessage: (() => void) | undefined
  let unsubscribeDisconnect: (() => void) | undefined

  /** Drop the operation entry and its abort listener (every terminal path). */
  const release = (id: string): void => {
    const op = pending.get(id)
    if (op === undefined) return
    pending.delete(id)
    if (op.onAbort !== undefined) op.signal.removeEventListener('abort', op.onAbort)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribeMessage?.()
    unsubscribeDisconnect?.()
    unsubscribeMessage = undefined
    unsubscribeDisconnect = undefined
    for (const id of [...pending.keys()]) {
      const op = pending.get(id)
      if (op === undefined) continue
      op.terminal = true
      release(id)
      op.reject(new NativeError('channel-closed', 'the native channel closed before the operation settled'))
    }
    pending.clear()
  }

  const handle = (value: unknown): void => {
    if (disposed) return
    if (isNativeResponseMessage(value)) {
      let response
      try {
        response = parseNativeResponse(value)
      } catch {
        return // A malformed response settles nothing: fail closed.
      }
      const op = pending.get(response.requestId)
      if (op === undefined || op.terminal) return // Stale or duplicate: ignored.
      if (response.ok) {
        if (op.method !== 'directory.pick') {
          op.terminal = true
          release(response.requestId)
          op.resolve(undefined)
          return
        }
        // The chooser outcome must match the caller's own method; a
        // mismatched shape settles nothing.
        if (!('path' in response)) return
        const path = response.path
        op.terminal = true
        release(response.requestId)
        op.resolve(path ?? null)
        return
      }
      op.terminal = true
      release(response.requestId)
      op.reject(new NativeError(response.code, response.message))
      return
    }
    if (isNativeCancelMessage(value)) {
      let cancel
      try {
        cancel = parseNativeCancel(value)
      } catch {
        return
      }
      const op = pending.get(cancel.requestId)
      if (op === undefined || op.terminal) return
      op.terminal = true
      release(cancel.requestId)
      op.reject(new NativeError('cancelled', cancel.reason))
    }
  }

  const request = (method: NativeMethod, signal: AbortSignal, path?: string): Promise<unknown> => {
    if (disposed) throw new NativeError('channel-closed', 'the native channel is closed')
    if (signal.aborted) throw abortError()
    const id = randomUUID()
    const op: PendingOperation = {
      method,
      signal,
      // Reassigned to the promise's settlement immediately below.
      resolve: (_value) => { /* reassigned below */ },
      reject: (_error) => { /* reassigned below */ },
      onAbort: undefined,
      terminal: false,
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      op.resolve = resolve
      op.reject = reject
    })
    // Observational: a caller that abandons the promise must not surface
    // the terminal as an unhandled rejection.
    promise.catch(() => undefined)
    pending.set(id, op)
    const onAbort = (): void => {
      if (op.terminal) return
      op.terminal = true
      release(id)
      op.reject(abortError())
    }
    op.onAbort = onAbort
    signal.addEventListener('abort', onAbort, { once: true })
    if (method === 'directory.pick') {
      send({ type: 'native.request', requestId: id, method })
    } else if (path !== undefined) {
      send({ type: 'native.request', requestId: id, method, path })
    } else {
      // Unreachable: openPath always carries its path.
      op.terminal = true
      release(id)
      op.reject(new Error('native bridge: path.open requires a path'))
    }
    return promise
  }

  unsubscribeMessage = subscribeMessage(handle)
  unsubscribeDisconnect = subscribeDisconnect(dispose)

  return {
    pickDirectory: (signal): Promise<string | null> => request('directory.pick', signal) as Promise<string | null>,
    openPath: (path, signal): Promise<void> => request('path.open', signal, path) as Promise<void>,
    dispose,
  }
}
