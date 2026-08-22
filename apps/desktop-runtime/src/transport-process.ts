/**
 * The child-IPC backing for a {@link TransportPort}. Node `child_process`
 * cannot transfer a `MessagePort` over the fork channel, so the dumb broker
 * relays the same wire messages over the structured-clone channel instead;
 * this adapter projects that channel onto the port surface the transport
 * edge consumes. It demultiplexes against the control messages
 * (`runtime.shutdown`, `runtime.transport-closed`) by the
 * {@link isTransportMessage} discriminant.
 *
 * `close()` is a channel-generation signal, not a death: it fires the close
 * listeners so the runtime ends the in-flight operations of the torn-down
 * channel, and the adapter stays armed for the next channel on the same
 * process. True death is the supervisor's disconnect, which fires close as
 * well and then exits the process.
 * @module @deepseek-ai/dsh-desktop-runtime/transport-process
 */

import { fromOpaqueTransportWire, isTransportMessage, toOpaqueTransportWire, type TransportPort } from './transport.ts'

export interface ProcessTransportPort extends TransportPort {
  /** End the current channel generation: fire the close listeners. */
  close(): void
}

/**
 * Project the child IPC channel onto the transport port surface.
 * @returns the process-backed port.
 */
export function createProcessTransportPort(): ProcessTransportPort {
  const messageListeners: Array<(value: unknown) => void> = []
  const closeListeners: Array<() => void> = []

  const fireMessage = (value: unknown): void => {
    // The parent edge encodes byte fields; restore them before demux.
    const decoded = fromOpaqueTransportWire(value)
    if (decoded === null || !isTransportMessage(decoded)) return
    for (const listener of [...messageListeners]) listener(decoded)
  }
  const fireClose = (): void => {
    for (const listener of [...closeListeners]) listener()
  }

  process.on('message', fireMessage)
  process.on('disconnect', fireClose)

  return {
    get readyState(): string {
      return process.connected ? 'open' : 'closed'
    },
    postMessage: (message: object): void => {
      if (process.send === undefined || !process.connected) return
      // The child edge drops typed arrays; encode byte fields before send.
      process.send(toOpaqueTransportWire(message))
    },
    start: (): void => {
      // The child IPC channel is live as soon as it connects; nothing to do.
    },
    on: (event, listener) => {
      // The overloads guarantee the listener shape per event name.
      if (event === 'message') messageListeners.push(listener)
      else closeListeners.push(listener as () => void)
      return undefined
    },
    removeListener: (event, listener) => {
      // The overloads guarantee the listener shape per event name.
      if (event === 'message') {
        const index = messageListeners.indexOf(listener)
        if (index >= 0) messageListeners.splice(index, 1)
        return undefined
      }
      const index = closeListeners.indexOf(listener as () => void)
      if (index >= 0) closeListeners.splice(index, 1)
      return undefined
    },
    close: fireClose,
  }
}
