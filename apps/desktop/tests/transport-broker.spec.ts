/**
 * The stage 3 dumb broker, tested against a fake runtime relay surface and a
 * fake WebContents: transparent relaying in both directions, the wire gate's
 * drops (control vocabulary, malformed values) and synthesized refusals
 * (oversized frames, either direction), readiness denial, channel
 * replacement, and the lifecycle glue that closes the pair when either end
 * goes away.
 */

import type { MessagePort } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { TRANSPORT_MAX_FRAME_BYTES } from '@deepseek-ai/dsh-desktop-runtime/transport'
import {
  createTransportBroker,
  TRANSPORT_DENIED_CHANNEL,
  TRANSPORT_PORT_CHANNEL,
} from '../src/main/transport-broker.ts'

/** A minimal WebContents double: records every send, including delivered ports. */
function fakeSender() {
  const ports: MessagePort[] = []
  const channels: string[] = []
  const sender = {
    isDestroyed: () => false,
    postMessage: (channel: string, _message: unknown, transferred?: MessagePort[]) => {
      channels.push(channel)
      for (const port of transferred ?? []) ports.push(port)
    },
    send: (channel: string, _message: unknown) => {
      channels.push(channel)
    },
  }
  return { sender, ports, channels }
}

/** A minimal RuntimeTransport double with scripted delivery and exit. */
function fakeRuntime() {
  const sent: object[] = []
  const messageHandlers: Array<(value: object) => void> = []
  const closeHandlers: Array<() => void> = []
  let closedChannels = 0
  let lastType: string | undefined
  const runtime = {
    send: (value: object) => {
      sent.push(value)
      lastType = (value as { type?: string }).type
    },
    onMessage: (handler: (value: object) => void) => {
      messageHandlers.push(handler)
    },
    onClose: (handler: () => void) => {
      closeHandlers.push(handler)
    },
    closeChannel: () => {
      closedChannels++
    },
  }
  return {
    runtime,
    sent,
    /** Deliver one message as if the runtime child sent it. */
    deliver: (value: object) => {
      for (const handler of messageHandlers) handler(value)
    },
    /** Fire the child-exit notification. */
    childExited: () => {
      for (const handler of closeHandlers) handler()
    },
    closedChannels: () => closedChannels,
    /** The `type` of the last relayed message, when it carried one. */
    lastType: () => lastType,
  }
}

/** The renderer half the broker shipped to the fake sender. */
async function rendererPort(sender: ReturnType<typeof fakeSender>): Promise<MessagePort> {
  expect(sender.channels).toContain(TRANSPORT_PORT_CHANNEL)
  expect(sender.ports.length).toBe(1)
  const port = sender.ports[0]
  if (port === undefined) throw new Error('no renderer port delivered')
  return port
}

describe('transport broker', () => {
  it('relays transparently in both directions while the runtime is ready', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    port.postMessage({ type: 'fetch.open', requestId: 'r1', url: 'http://dsh.local/api/session.list', method: 'POST', headers: [] })
    await vi.waitFor(() => {
      expect(runtime.sent.at(-1)).toEqual({ type: 'fetch.open', requestId: 'r1', url: 'http://dsh.local/api/session.list', method: 'POST', headers: [] })
    })

    const received: unknown[] = []
    port.on('message', (value: unknown) => received.push(value))
    runtime.deliver({ type: 'fetch.request.credit', requestId: 'r1', credit: 1024 })
    runtime.deliver({ type: 'fetch.response.end', requestId: 'r1' })
    await vi.waitFor(() => {
      expect(received).toEqual([
        { type: 'fetch.request.credit', requestId: 'r1', credit: 1024 },
        { type: 'fetch.response.end', requestId: 'r1' },
      ])
    })
    broker.teardown()
  })

  it('denies an open while the runtime is not ready', () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => false })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    expect(fake.channels).not.toContain(TRANSPORT_PORT_CHANNEL)
    expect(fake.channels).toContain(TRANSPORT_DENIED_CHANNEL)
  })

  it('drops control-vocabulary and malformed renderer traffic instead of relaying it', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    // The renderer's port must not be able to inject child process control
    // messages or malformed frames into the runtime.
    port.postMessage({ type: 'runtime.shutdown' })
    port.postMessage({ type: 'runtime.ready' })
    port.postMessage({ type: 'runtime.transport-closed' })
    port.postMessage({ type: 'fetch.open' })
    port.postMessage({ type: 'stream.open', streamId: 's' })
    port.postMessage({ type: 'totally.new' })
    port.postMessage('not an object')
    port.postMessage(null)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    expect(runtime.sent).toEqual([])
    broker.teardown()
  })

  it('refuses oversized request chunks with a synthesized fetch.error', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    const received: unknown[] = []
    port.on('message', (value: unknown) => received.push(value))
    port.postMessage({
      type: 'fetch.request.chunk',
      requestId: 'big',
      sequence: 0,
      data: new Uint8Array(TRANSPORT_MAX_FRAME_BYTES + 1),
    })
    await vi.waitFor(() => {
      expect(received.length).toBe(1)
    })
    const reply = received[0] as { type: string; code: string; requestId: string }
    expect(reply.type).toBe('fetch.error')
    expect(reply.code).toBe('frame-too-large')
    expect(reply.requestId).toBe('big')
    expect(runtime.sent).toEqual([])
    broker.teardown()
  })

  it('relays a data frame of exactly the bound', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    const data = new Uint8Array(TRANSPORT_MAX_FRAME_BYTES)
    port.postMessage({ type: 'fetch.request.chunk', requestId: 'edge', sequence: 0, data })
    await vi.waitFor(() => {
      expect(runtime.sent.length).toBe(1)
    })
    expect(runtime.sent[0]).toEqual({ type: 'fetch.request.chunk', requestId: 'edge', sequence: 0, data })
    broker.teardown()
  })

  it('refuses an oversized downlink frame with a synthesized stream.error', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    const received: unknown[] = []
    port.on('message', (value: unknown) => received.push(value))
    runtime.deliver({
      type: 'stream.frame',
      streamId: 's9',
      sequence: 0,
      data: new Uint8Array(TRANSPORT_MAX_FRAME_BYTES + 1),
    })
    await vi.waitFor(() => {
      expect(received.length).toBe(1)
    })
    const reply = received[0] as { type: string; code: string; streamId: string }
    expect(reply.type).toBe('stream.error')
    expect(reply.code).toBe('frame-too-large')
    expect(reply.streamId).toBe('s9')
    broker.teardown()
  })

  it('refuses oversized stream frames with a synthesized stream.error', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    const received: unknown[] = []
    port.on('message', (value: unknown) => received.push(value))
    port.postMessage({
      type: 'stream.frame',
      streamId: 's1',
      sequence: 0,
      data: new Uint8Array(TRANSPORT_MAX_FRAME_BYTES + 1),
    })
    await vi.waitFor(() => {
      expect(received.length).toBe(1)
    })
    const reply = received[0] as { type: string; code: string; streamId: string }
    expect(reply.type).toBe('stream.error')
    expect(reply.code).toBe('frame-too-large')
    expect(reply.streamId).toBe('s1')
    expect(runtime.sent).toEqual([])
    broker.teardown()
  })

  it('closes the renderer port when the runtime child exits', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    // Closing the broker's half fires close on the delivered half.
    const closed = new Promise<void>((resolve) => {
      port.on('close', () => { resolve() })
    })
    runtime.childExited()
    await closed
    broker.teardown()
  })

  it('tells the runtime to end the channel when the renderer port closes', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    port.close()
    await vi.waitFor(() => {
      expect(runtime.closedChannels()).toBe(1)
    })
    broker.teardown()
  })

  it('replaces a live channel on a second open without ending the runtime channel', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const first = fakeSender()
    broker.handleOpenRequest(first.sender as never)
    const firstPort = await rendererPort(first)

    const firstClosed = new Promise<void>((resolve) => {
      firstPort.on('close', () => { resolve() })
    })
    const second = fakeSender()
    broker.handleOpenRequest(second.sender as never)
    const secondPort = await rendererPort(second)

    // The replaced port is dead.
    await firstClosed
    expect(runtime.sent).toEqual([])

    // The replacement is a fresh relay; the runtime channel stays live.
    secondPort.postMessage({ type: 'fetch.open', requestId: 'r2', url: 'http://dsh.local/api/session.list', method: 'POST', headers: [] })
    await vi.waitFor(() => {
      expect(runtime.lastType()).toBe('fetch.open')
    })
    expect(runtime.closedChannels()).toBe(0)
    broker.teardown()
  })

  it('teardown closes the live renderer port', async () => {
    const runtime = fakeRuntime()
    const broker = createTransportBroker({ runtime: runtime.runtime, isRuntimeReady: () => true })
    const fake = fakeSender()
    broker.handleOpenRequest(fake.sender as never)
    const port = await rendererPort(fake)

    const closed = new Promise<void>((resolve) => {
      port.on('close', () => { resolve() })
    })
    broker.teardown()
    await closed
  })
})
