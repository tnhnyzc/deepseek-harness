/**
 * The stage 3 dumb broker (SPEC §11). It relays transport messages between
 * the renderer's port and the runtime child's transport surface: transparent
 * forwarding, a size guard that inspects only transport metadata (the `data`
 * byte length of a data-bearing frame) and synthesizes a `frame-too-large`
 * error back to the originator, and lifecycle glue that closes the pair when
 * either end goes away. It never interprets payload semantics and never
 * invents traffic.
 *
 * Channels are per-generation: a relay is established only while the runtime
 * is ready; a runtime restart (or the renderer going away) ends the channel,
 * and the renderer re-opens the transport against the next runtime. An open
 * request answered while the runtime is not ready is denied — the client
 * observes the denial and retries.
 *
 * @module @deepseek-ai/dsh-desktop/src/main/transport-broker
 */

import type { MessagePortMain, WebContents } from 'electron'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import {
  TRANSPORT_MAX_FRAME_BYTES,
  TRANSPORT_MAX_REQUEST_BYTES,
  TransportErrorCode,
} from '@deepseek-ai/dsh-desktop-runtime/transport'
import type { RuntimeTransport } from './runtime.ts'

/**
 * The normalized port half the broker drives. Electron's `MessagePortMain` is
 * an EventEmitter whose `'message'` event carries a `{ data, ports }` event
 * object; Node's `MessagePort` emits the raw value. Both wrappers present the
 * same surface so the relay logic is written once.
 */
export interface BrokerPort {
  postMessage(value: object): void
  subscribeMessage(handler: (value: unknown) => void): () => void
  subscribeClose(handler: () => void): () => void
  start(): void
  close(): void
}

/** A per-generation channel pair: the half the broker keeps and the half delivered to the renderer. */
export interface BrokerChannel {
  local: BrokerPort
  remote: object
}

/** Wrap a Node `MessagePort` (the unit-test channel default). */
function wrapNodePort(port: MessagePort): BrokerPort {
  let live = true
  return {
    postMessage: (value: object): void => {
      if (live) port.postMessage(value)
    },
    subscribeMessage: (handler: (value: unknown) => void): (() => void) => {
      port.on('message', handler)
      return () => { port.off('message', handler) }
    },
    subscribeClose: (handler: () => void): (() => void) => {
      port.on('close', handler)
      return () => { port.off('close', handler) }
    },
    start: (): void => { port.start() },
    close: (): void => {
      if (!live) return
      live = false
      try { port.close() } catch { /* already closed */ }
    },
  }
}

/** Wrap an Electron `MessagePortMain` (the production channel in main). */
export function wrapMainPort(port: MessagePortMain): BrokerPort {
  let live = true
  return {
    postMessage: (value: object): void => {
      if (live) port.postMessage(value)
    },
    subscribeMessage: (handler: (value: unknown) => void): (() => void) => {
      const listener = (event: { data?: unknown }): void => { handler(event.data) }
      port.on('message', listener)
      return () => { port.off('message', listener) }
    },
    subscribeClose: (handler: () => void): (() => void) => {
      port.on('close', handler)
      return () => { port.off('close', handler) }
    },
    start: (): void => { port.start() },
    close: (): void => {
      if (!live) return
      live = false
      try { port.close() } catch { /* already closed */ }
    },
  }
}

/** The default channel pair (plain Node); Electron main injects a `MessageChannelMain`-based one. */
function nodeBrokerChannel(): BrokerChannel {
  const channel = new MessageChannel()
  return { local: wrapNodePort(channel.port1), remote: channel.port2 }
}

/** The IPC channel the renderer requests a transport open on. */
export const TRANSPORT_OPEN_CHANNEL = 'dsh-desktop:transport-open'
/** The IPC channel main sends the renderer half of the channel on. */
export const TRANSPORT_PORT_CHANNEL = 'dsh-desktop:transport-port'
/** The IPC channel main denies an open on (the runtime is not ready). */
export const TRANSPORT_DENIED_CHANNEL = 'dsh-desktop:transport-denied'

export interface TransportBroker {
  /** Answer a renderer's `transport-open` IPC: establish (or deny) a relay. */
  handleOpenRequest(sender: WebContents): void
  /** Close the relay (app teardown). */
  teardown(): void
}

const DATA_TYPES: ReadonlySet<string> = new Set([
  'fetch.request.chunk',
  'fetch.response.chunk',
  'stream.frame',
])

/**
 * The broker's only payload inspection: is this a data-bearing frame whose
 * `data` exceeds the limit? Such a frame is rejected before relaying because
 * the receiving edge would drop it anyway and the originator would stall on
 * credit instead of learning the fact.
 *
 * @param value - a structured-cloned inbound message.
 * @returns the synthetic error reply, or undefined when the frame passes.
 */
function oversizeReply(value: unknown): object | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const frame = value as { type?: unknown; data?: unknown }
  if (typeof frame.type !== 'string' || !DATA_TYPES.has(frame.type)) return undefined
  const data = frame.data
  if (!(data instanceof Uint8Array)) return undefined
  const limit = frame.type === 'fetch.request.chunk' ? TRANSPORT_MAX_REQUEST_BYTES : TRANSPORT_MAX_FRAME_BYTES
  if (data.byteLength <= limit) return undefined
  const message = 'frame exceeds the transport limit'
  if (frame.type === 'stream.frame') {
    const { streamId } = value as { streamId?: unknown }
    return { type: 'stream.error', streamId: typeof streamId === 'string' ? streamId : '', code: TransportErrorCode.frameTooLarge, message }
  }
  const { requestId } = value as { requestId?: unknown }
  return { type: 'fetch.error', requestId: typeof requestId === 'string' ? requestId : '', code: TransportErrorCode.frameTooLarge, message }
}

export function createTransportBroker(options: {
  /** The supervisor's relay surface for the runtime half of the channel. */
  runtime: RuntimeTransport
  /** Whether the runtime is currently in the `ready` state. */
  isRuntimeReady: () => boolean
  /** Observe channel open/close (diagnostics only). */
  onChannelChange?: (open: boolean) => void
  /** The per-generation channel pair factory (defaults to a plain Node channel). */
  channelFactory?: () => BrokerChannel
}): TransportBroker {
  const channelFactory = options.channelFactory ?? nodeBrokerChannel
  let rendererPort: BrokerPort | undefined
  let rendererPortClosed = false
  let unsubscribeMessage: (() => void) | undefined
  let unsubscribeClose: (() => void) | undefined

  const clearLocalListeners = (): void => {
    unsubscribeMessage?.()
    unsubscribeClose?.()
    unsubscribeMessage = undefined
    unsubscribeClose = undefined
  }

  const teardown = (): void => {
    options.onChannelChange?.(false)
    const port = rendererPort
    rendererPort = undefined
    rendererPortClosed = true
    clearLocalListeners()
    port?.close()
  }

  const handleOpenRequest = (sender: WebContents): void => {
    teardown()
    if (sender.isDestroyed() || !options.isRuntimeReady()) {
      if (!sender.isDestroyed()) sender.send(TRANSPORT_DENIED_CHANNEL, 'runtime-not-ready')
      return
    }
    const channel = channelFactory()
    rendererPort = channel.local
    rendererPortClosed = false
    // The renderer went away (window destroyed): tell the runtime to end its
    // transport operations. A replaced channel never fires this — teardown
    // removes the listener first — so a re-open can never abort the new
    // channel's operations.
    unsubscribeClose = channel.local.subscribeClose(() => {
      rendererPortClosed = true
      if (rendererPort !== channel.local) return
      rendererPort = undefined
      options.onChannelChange?.(false)
      options.runtime.closeChannel()
    })
    unsubscribeMessage = channel.local.subscribeMessage((value: unknown) => {
      const reply = oversizeReply(value)
      if (reply !== undefined) {
        if (!rendererPortClosed) rendererPort?.postMessage(reply)
        return
      }
      options.runtime.send(value as object)
    })
    options.runtime.onMessage((value: object) => {
      const port = rendererPort
      if (port === undefined || rendererPortClosed) return
      const reply = oversizeReply(value)
      if (reply !== undefined) {
        port.postMessage(reply)
        return
      }
      port.postMessage(value)
    })
    options.runtime.onClose(() => {
      rendererPortClosed = true
      const port = rendererPort
      clearLocalListeners()
      rendererPort = undefined
      port?.close()
    })
    if (sender.isDestroyed()) {
      teardown()
      return
    }
    // Ports are inert until started; the renderer starts its own half.
    // postMessage takes the explicit transfer list; send does not transfer ports.
    channel.local.start()
    sender.postMessage(TRANSPORT_PORT_CHANNEL, undefined, [channel.remote as MessagePortMain])
    options.onChannelChange?.(true)
  }

  return { handleOpenRequest, teardown }
}
