/**
 * The Electron main process's half of the desktop native capability
 * channel: it validates every runtime request through the shared protocol
 * parser, dispatches onto the OS capability registry, and settles each
 * request with exactly one response — a success, a closed-code failure, or
 * (on generation teardown) a cancel for every still-pending request. A
 * request is a capability invocation, not a business operation: this module
 * knows the closed method set and nothing about DSH. Late results of a
 * torn-down generation settle nothing and are dropped.
 * @module @deepseek-ai/dsh-desktop/src/main/native-channel
 */

import {
  parseNativeRequest,
  type NativeErrorCode,
  type NativeMessage,
  type NativeResponse,
} from '@deepseek-ai/dsh-desktop-runtime/native'
import { MAX_DIAGNOSTIC_CHARS, NativeCapabilityError, type NativeCapabilities } from './native-capabilities.ts'
import type { BrowserWindow } from 'electron'

/** The channel's dependencies, injectable for tests. */
export interface NativeChannelOptions {
  /** The OS capability registry the requests dispatch onto. */
  capabilities: NativeCapabilities
  /** Deliver one channel message to the live runtime child (no-op when gone). */
  send: (message: NativeMessage) => void
  /** The modal parent for a chooser, or undefined when no window is open. */
  getWindow: () => BrowserWindow | undefined
}

/** The main side of the desktop native capability channel. */
export interface NativeChannel {
  /** Validate and dispatch one raw inbound request from the runtime child. */
  handle(raw: unknown): void
  /** Generation teardown: cancel every pending request; ignore late results. */
  teardown(reason: string): void
  /** The request ids still pending (for tests and bounded diagnostics). */
  pendingIds(): string[]
}

function failure(requestId: string, code: NativeErrorCode, message: string): NativeResponse {
  return { type: 'native.response', requestId, ok: false, code, message: message.slice(0, MAX_DIAGNOSTIC_CHARS) }
}

/**
 * Create the native channel.
 * @param options - capabilities, the child sender, and the window source.
 * @returns the channel surface.
 */
export function createNativeChannel(options: NativeChannelOptions): NativeChannel {
  const pending = new Set<string>()
  let active = true

  const finish = (requestId: string, response: NativeResponse): void => {
    pending.delete(requestId)
    if (!active) return
    options.send(response)
  }

  /**
   * Classify one malformed request for a rejection response. A request with
   * a readable id gets the precise code; one without an id is uncorrelatable
   * and dropped (the sender's operation already owns its lifetime).
   * @param raw - the inbound value that failed strict parsing.
   * @returns the rejection, or undefined when no response can be correlated.
   */
  const classifyMalformed = (raw: unknown): NativeResponse | undefined => {
    if (raw === null || typeof raw !== 'object') return undefined
    const value = raw as Record<string, unknown>
    const requestId = typeof value.requestId === 'string' && value.requestId !== '' ? value.requestId : undefined
    if (requestId === undefined) return undefined
    const methodKnown = value.method === 'directory.pick' || value.method === 'path.open'
    return failure(requestId, methodKnown ? 'malformed-request' : 'unknown-method', 'the request was not a well-formed native request')
  }

  const handle = (raw: unknown): void => {
    if (!active) return
    let request
    try {
      request = parseNativeRequest(raw)
    } catch {
      const rejection = classifyMalformed(raw)
      if (rejection !== undefined) options.send(rejection)
      return
    }
    if (pending.has(request.requestId)) return // A duplicate settles nothing.
    pending.add(request.requestId)
    const requestId = request.requestId
    const settle = (result: Promise<unknown>): void => {
      void result
        .then((value) => {
          const ok: NativeResponse = request.method === 'directory.pick'
            ? { type: 'native.response', requestId, ok: true, path: value as string | null }
            : { type: 'native.response', requestId, ok: true }
          finish(requestId, ok)
        })
        .catch((error: unknown) => {
          const code = request.method === 'directory.pick' ? 'dialog-failed' : 'open-failed'
          const fallback = request.method === 'directory.pick'
            ? 'the directory chooser failed'
            : 'the path could not be opened'
          finish(requestId, failure(requestId, codeFor(error, code), messageFor(error, fallback)))
        })
    }
    if (request.method === 'directory.pick') settle(options.capabilities.pickDirectory(options.getWindow()))
    else settle(options.capabilities.openPath(request.path))
  }

  const teardown = (reason: string): void => {
    if (!active) return
    active = false
    for (const requestId of [...pending]) {
      options.send({ type: 'native.cancel', requestId, reason: reason.slice(0, MAX_DIAGNOSTIC_CHARS) })
    }
    pending.clear()
  }

  return {
    handle,
    teardown,
    pendingIds: (): string[] => [...pending],
  }
}

/** The closed code for one thrown value: the capability's own code, or the method fallback. */
function codeFor(error: unknown, fallback: NativeErrorCode): NativeErrorCode {
  return error instanceof NativeCapabilityError ? error.code : fallback
}

/** The bounded message for one thrown value. */
function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}
