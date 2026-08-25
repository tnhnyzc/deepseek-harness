/**
 * The runtime child's native capability client: unique request ids, the
 * caller signal's whole lifetime, the abort terminal, stale and duplicate
 * message refusal, cancel settlement, and channel-death settlement of every
 * pending operation.
 */

import { describe, expect, it } from 'vitest'
import { createNativeBridge, NativeError, type NativeBridgeOptions } from '../src/native-bridge.ts'
import type { NativeMessage } from '../src/native.ts'

interface Seam {
  bridge: ReturnType<typeof createNativeBridge>
  sent: NativeMessage[]
  respond: (value: unknown) => void
  disconnect: () => void
  options: NativeBridgeOptions
}

function makeSeam(): Seam {
  const sent: NativeMessage[] = []
  const messageListeners: Array<(value: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  const options: NativeBridgeOptions = {
    send: (message) => { sent.push(message) },
    onMessage: (listener) => {
      messageListeners.push(listener)
      return () => {
        const index = messageListeners.indexOf(listener)
        if (index >= 0) messageListeners.splice(index, 1)
      }
    },
    onDisconnect: (listener) => {
      disconnectListeners.push(listener)
      return () => {
        const index = disconnectListeners.indexOf(listener)
        if (index >= 0) disconnectListeners.splice(index, 1)
      }
    },
  }
  const bridge = createNativeBridge(options)
  return {
    bridge,
    sent,
    options,
    respond: (value) => { for (const listener of [...messageListeners]) listener(value) },
    disconnect: () => { for (const listener of [...disconnectListeners]) listener() },
  }
}

/** The request id of the operation the bridge just sent. */
function requestId(seam: Seam): string {
  const last = seam.sent[seam.sent.length - 1]
  if (last === undefined || last.type !== 'native.request') throw new Error('no native request sent')
  return last.requestId
}

describe('createNativeBridge', () => {
  it('round trips a pickDirectory success into the chosen path', async () => {
    const seam = makeSeam()
    const promise = seam.bridge.pickDirectory(new AbortController().signal)
    seam.respond({ type: 'native.response', requestId: requestId(seam), ok: true, path: '/tmp/chosen' })
    await expect(promise).resolves.toBe('/tmp/chosen')
  })

  it('round trips a pickDirectory operator cancel into null', async () => {
    const seam = makeSeam()
    const promise = seam.bridge.pickDirectory(new AbortController().signal)
    seam.respond({ type: 'native.response', requestId: requestId(seam), ok: true, path: null })
    await expect(promise).resolves.toBeNull()
  })

  it('round trips an openPath success into void', async () => {
    const seam = makeSeam()
    const promise = seam.bridge.openPath('/tmp/doc.txt', new AbortController().signal)
    expect(seam.sent[0]).toEqual({ type: 'native.request', requestId: requestId(seam), method: 'path.open', path: '/tmp/doc.txt' })
    seam.respond({ type: 'native.response', requestId: requestId(seam), ok: true })
    await expect(promise).resolves.toBeUndefined()
  })

  it('round trips a closed-code failure into a NativeError', async () => {
    const seam = makeSeam()
    const promise = seam.bridge.openPath('/tmp/doc.txt', new AbortController().signal)
    seam.respond({ type: 'native.response', requestId: requestId(seam), ok: false, code: 'open-failed', message: 'no default app' })
    await expect(promise).rejects.toMatchObject({ name: 'NativeError', code: 'open-failed', message: 'no default app' })
  })

  it('uses a unique request id per operation', () => {
    const seam = makeSeam()
    void seam.bridge.pickDirectory(new AbortController().signal)
    void seam.bridge.openPath('/tmp/a', new AbortController().signal)
    const [first, second] = seam.sent
    expect(first?.requestId).toBeTruthy()
    expect(second?.requestId).toBeTruthy()
    expect(first?.requestId).not.toBe(second?.requestId)
  })

  it('refuses an already-aborted caller without sending', () => {
    const seam = makeSeam()
    const controller = new AbortController()
    controller.abort()
    expect(() => seam.bridge.pickDirectory(controller.signal)).toThrow(/aborted/i)
    expect(seam.sent).toEqual([])
  })

  it('settles with the abort terminal when the caller aborts mid-flight', async () => {
    const seam = makeSeam()
    const controller = new AbortController()
    const promise = seam.bridge.pickDirectory(controller.signal)
    const id = requestId(seam)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    // The abort propagated to main exactly once, for this request.
    expect(seam.sent).toEqual([
      { type: 'native.request', requestId: id, method: 'directory.pick' },
      { type: 'native.abort', requestId: id, reason: 'the caller aborted' },
    ])
    // The operation is terminal: a late response settles nothing and
    // emits nothing further.
    seam.respond({ type: 'native.response', requestId: id, ok: true, path: '/late' })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    expect(seam.sent).toHaveLength(2)
  })

  it('forwards a string signal reason to the abort message, bounded', async () => {
    const seam = makeSeam()
    const controller = new AbortController()
    const promise = seam.bridge.openPath('/tmp/a', controller.signal)
    const id = requestId(seam)
    controller.abort('r'.repeat(1024))
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    const abort = seam.sent.find(message => message.type === 'native.abort')
    expect(abort).toMatchObject({ type: 'native.abort', requestId: id, reason: 'r'.repeat(512) })
  })

  it('sends no abort when the response wins the race', async () => {
    const seam = makeSeam()
    const controller = new AbortController()
    const promise = seam.bridge.pickDirectory(controller.signal)
    const id = requestId(seam)
    seam.respond({ type: 'native.response', requestId: id, ok: true, path: '/won' })
    await expect(promise).resolves.toBe('/won')
    // A late abort after the success terminal fabricates no remote cancel.
    controller.abort()
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    expect(seam.sent).toEqual([{ type: 'native.request', requestId: id, method: 'directory.pick' }])
  })

  it('ignores a stale response for a request id it never issued', async () => {
    const seam = makeSeam()
    seam.respond({ type: 'native.response', requestId: 'never-issued', ok: true, path: '/x' })
    const controller = new AbortController()
    const promise = seam.bridge.pickDirectory(controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('ignores a duplicate success for a settled operation', async () => {
    const seam = makeSeam()
    const promise = seam.bridge.openPath('/tmp/a', new AbortController().signal)
    const id = requestId(seam)
    seam.respond({ type: 'native.response', requestId: id, ok: true })
    await expect(promise).resolves.toBeUndefined()
    // A second success for the same id must not throw an unhandled rejection.
    seam.respond({ type: 'native.response', requestId: id, ok: true })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  })

  it('settles with the cancel terminal on a main-issued cancel', async () => {
    const seam = makeSeam()
    const promise = seam.bridge.pickDirectory(new AbortController().signal)
    seam.respond({ type: 'native.cancel', requestId: requestId(seam), reason: 'generation ended' })
    await expect(promise).rejects.toMatchObject({ name: 'NativeError', code: 'cancelled', message: 'generation ended' })
  })

  it('drops a malformed response and stays pending for the valid one', async () => {
    const seam = makeSeam()
    const promise = seam.bridge.openPath('/tmp/a', new AbortController().signal)
    const id = requestId(seam)
    seam.respond({ type: 'native.response', requestId: id, ok: 'yes' })
    // Still pending after the malformed drop: only the valid response settles.
    seam.respond({ type: 'native.response', requestId: id, ok: true })
    await expect(promise).resolves.toBeUndefined()
  })

  it('settles a success whose shape mismatches the caller method as a no-settle', async () => {
    const seam = makeSeam()
    const promise = seam.bridge.openPath('/tmp/a', new AbortController().signal)
    // A chooser-shaped success arrives for an openPath operation: the
    // operation stays pending until its own terminal.
    seam.respond({ type: 'native.response', requestId: requestId(seam), ok: true, path: '/x' })
    seam.respond({ type: 'native.response', requestId: requestId(seam), ok: true })
    await expect(promise).resolves.toBeUndefined()
  })

  it('settles every pending operation with channel-closed on dispose', async () => {
    const seam = makeSeam()
    const pick = seam.bridge.pickDirectory(new AbortController().signal)
    const open = seam.bridge.openPath('/tmp/a', new AbortController().signal)
    seam.bridge.dispose()
    await expect(pick).rejects.toMatchObject({ name: 'NativeError', code: 'channel-closed' })
    await expect(open).rejects.toMatchObject({ name: 'NativeError', code: 'channel-closed' })
    // Dispose is idempotent and terminal for new operations.
    seam.bridge.dispose()
    expect(() => seam.bridge.pickDirectory(new AbortController().signal)).toThrow(NativeError)
  })

  it('settles pending operations when the supervisor disconnects', async () => {
    const seam = makeSeam()
    const pick = seam.bridge.pickDirectory(new AbortController().signal)
    seam.disconnect()
    await expect(pick).rejects.toMatchObject({ name: 'NativeError', code: 'channel-closed' })
  })

  it('unsubscribes its channel listeners on dispose', async () => {
    const seam = makeSeam()
    const pick = seam.bridge.pickDirectory(new AbortController().signal)
    seam.bridge.dispose()
    await expect(pick).rejects.toBeInstanceOf(NativeError)
    // After dispose the seam's message delivery reaches no listener.
    seam.respond({ type: 'native.response', requestId: 'x', ok: true, path: '/y' })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  })
})
