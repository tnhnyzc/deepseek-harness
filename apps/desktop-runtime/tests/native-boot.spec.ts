/**
 * Real-boot acceptance for the desktop native capability channel: forks the
 * built runtime under a temporary home and plays the Electron main side over
 * the child IPC channel — the runtime's host.pickDirectory and host.openPath
 * cross as native.request messages and settle only on the main-side
 * responses, a client abort terminates an in-flight operation and crosses as
 * a real native.abort message whose late result is dropped, and a
 * main-issued cancel settles the pick as a channel failure. Self-skips when
 * the entry has not been built (`pnpm run build`).
 */

import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fromOpaqueTransportWire, toOpaqueTransportWire } from '../src/transport.ts'

const ENTRY = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const RUNTIME_CWD = resolve(import.meta.dirname, '..')
const READY_TIMEOUT_MS = 120_000
const MESSAGE_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 30_000

const CHOSEN_DIRECTORY = '/tmp/dsh-native-boot/chosen'
const OPEN_TARGET = '/tmp/dsh-native-boot/document.txt'

interface WireMessage {
  type: string
  [key: string]: unknown
}

interface NativeRequest {
  type: 'native.request'
  requestId: string
  method: 'directory.pick' | 'path.open'
  path?: string
}

interface NativeAbort {
  type: 'native.abort'
  requestId: string
  reason: string
}

function forkRuntime(home: string): ChildProcess {
  return fork(ENTRY, [], {
    execPath: process.execPath,
    execArgv: [],
    cwd: RUNTIME_CWD,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DSH_DESKTOP: '1',
      DSH_HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
}

/**
 * The test's stand-in for Electron main: demultiplexes the child IPC channel
 * into the transport pump and the native capability queue, and answers
 * native requests the way the main-side channel would.
 */
class NativeLink {
  private transportQueue: WireMessage[] = []
  private transportWaiters: Array<() => void> = []
  private nativeQueue: NativeRequest[] = []
  private nativeWaiters: Array<() => void> = []
  private abortQueue: NativeAbort[] = []
  private abortWaiters: Array<() => void> = []
  ready: Promise<void>

  constructor(private readonly child: ChildProcess) {
    this.ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`runtime did not report ready within ${String(READY_TIMEOUT_MS)} ms`))
      }, READY_TIMEOUT_MS)
      child.on('message', (message: unknown) => {
        const value = message as WireMessage | null
        if (value === null || typeof value !== 'object') return
        if (value.type === 'runtime.ready') {
          clearTimeout(timer)
          resolveReady()
          return
        }
        if (value.type === 'native.request') {
          this.nativeQueue.push(value as unknown as NativeRequest)
          for (const wake of this.nativeWaiters.splice(0)) wake()
          return
        }
        if (value.type === 'native.abort') {
          this.abortQueue.push(value as unknown as NativeAbort)
          for (const wake of this.abortWaiters.splice(0)) wake()
          return
        }
        const decoded = fromOpaqueTransportWire(value)
        if (decoded === null) return
        this.transportQueue.push(decoded as WireMessage)
        for (const wake of this.transportWaiters.splice(0)) wake()
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`runtime exited before ready (code ${String(code)}, signal ${String(signal)})`))
      })
    })
  }

  send(message: object): void {
    this.child.send(toOpaqueTransportWire(message))
  }

  /** The next transport message; transport and native traffic are separate queues. */
  async nextTransport(timeoutMs = MESSAGE_TIMEOUT_MS): Promise<WireMessage | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending = this.transportQueue.shift()
      if (pending !== undefined) return pending
      if (Date.now() >= deadline) return undefined
      await this.park(this.transportWaiters, deadline)
    }
  }

  async nextNativeRequest(timeoutMs = MESSAGE_TIMEOUT_MS): Promise<NativeRequest> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending = this.nativeQueue.shift()
      if (pending !== undefined) return pending
      if (Date.now() >= deadline) throw new Error(`no native.request within ${String(timeoutMs)} ms`)
      await this.park(this.nativeWaiters, deadline)
    }
  }

  async nextNativeAbort(timeoutMs = MESSAGE_TIMEOUT_MS): Promise<NativeAbort> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending = this.abortQueue.shift()
      if (pending !== undefined) return pending
      if (Date.now() >= deadline) throw new Error(`no native.abort within ${String(timeoutMs)} ms`)
      await this.park(this.abortWaiters, deadline)
    }
  }

  /** No further aborts in flight: the queue stays empty for the grace period. */
  async drainAborts(timeoutMs = 300): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const pending = this.abortQueue.shift()
      if (pending !== undefined) throw new Error(`unexpected late native.abort for ${pending.requestId}`)
      await new Promise<void>((resolveSleep) => { setTimeout(resolveSleep, 50) })
    }
  }

  private park(waiters: Array<() => void>, deadline: number): Promise<void> {
    return new Promise<void>((resolvePark) => {
      const waiter = (): void => {
        clearTimeout(timer)
        const i = waiters.indexOf(waiter)
        if (i >= 0) waiters.splice(i, 1)
        resolvePark()
      }
      const timer = setTimeout(waiter, Math.max(deadline - Date.now(), 0))
      waiters.push(waiter)
    })
  }

  async drainNative(timeoutMs = 500): Promise<NativeRequest[]> {
    const out: NativeRequest[] = []
    while (true) {
      const pending = this.nativeQueue.shift()
      if (pending !== undefined) { out.push(pending); continue }
      const more = await this.nextNative(timeoutMs)
      if (more !== undefined) out.push(more)
      else break
    }
    return out
  }

  private nextNative(timeoutMs: number): Promise<NativeRequest | undefined> {
    return new Promise<NativeRequest | undefined>((resolveNext) => {
      // The waiter removes itself on every settlement: a timed-out waiter left
      // in the array would steal the next message from a later consumer.
      const waiter = (): void => {
        clearTimeout(timer)
        const i = this.nativeWaiters.indexOf(waiter)
        if (i >= 0) this.nativeWaiters.splice(i, 1)
        resolveNext(this.nativeQueue.shift())
      }
      const timer = setTimeout(waiter, timeoutMs)
      this.nativeWaiters.push(waiter)
    })
  }
}

function clientRequest(rpcId: string, method: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: 'client-request', rpcId, method, payload }))
}

interface FetchResult {
  status: number
  body: string
}

/** Drive the response messages of one already-opened fetch to completion. */
async function readFetch(link: NativeLink, requestId: string): Promise<FetchResult> {
  let status = 0
  const chunks: Uint8Array[] = []
  for (;;) {
    const message = await link.nextTransport()
    if (message === undefined) throw new Error(`fetch ${requestId}: channel went quiet`)
    if (message.requestId !== requestId || message.type === 'fetch.request.credit') continue
    if (message.type === 'fetch.error') throw new Error(`fetch ${requestId} failed: ${String(message.code)} ${String(message.message)}`)
    if (message.type === 'fetch.response.head') { status = message.status as number; continue }
    if (message.type === 'fetch.response.chunk') { chunks.push(message.data as Uint8Array); continue }
    if (message.type === 'fetch.response.end') return { status, body: Buffer.concat(chunks).toString('utf8') }
  }
}

/** Open one POST fetch; the body carries one client request. */
function openFetch(link: NativeLink, requestId: string, rpcId: string, method: string, payload: Record<string, unknown>): void {
  link.send({ type: 'fetch.open', requestId, url: `http://dsh.local/api/${method}`, method: 'POST', headers: [['content-type', 'application/json']] })
  link.send({ type: 'fetch.request.chunk', requestId, sequence: 0, data: clientRequest(rpcId, method, payload) })
  link.send({ type: 'fetch.request.end', requestId })
}

/** The parsed carrier envelope of one fetch body. */
interface Envelope {
  type: string
  rpcId: string
  result: { ok: boolean; value?: Record<string, unknown>; error?: { code: string; message: string } }
}

describe.skipIf(!existsSync(ENTRY))('desktop native capability boot', () => {
  let home: string
  let child: ChildProcess
  let link: NativeLink

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-desktop-native-'))
    child = forkRuntime(home)
    link = new NativeLink(child)
    await link.ready
  }, READY_TIMEOUT_MS + 10_000)

  afterAll(async () => {
    if (child.exitCode === null && child.kill()) {
      await new Promise<void>((resolveExit) => {
        child.once('exit', () => { resolveExit() })
      })
    }
  }, SHUTDOWN_TIMEOUT_MS)

  it('reports the injected opener through host.describe', async () => {
    openFetch(link, 'native-describe', 'native-rpc-1', 'host.describe', {})
    const result = await readFetch(link, 'native-describe')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.result.ok).toBe(true)
    expect(envelope.result.value?.canOpenPath).toBe(true)
  }, 45_000)

  it('crosses host.pickDirectory to the main side and carries the chosen path back', async () => {
    openFetch(link, 'native-pick', 'native-rpc-2', 'host.pickDirectory', {})
    const nativeRequest = await link.nextNativeRequest()
    expect(nativeRequest.method).toBe('directory.pick')
    expect(nativeRequest.requestId).not.toBe('')
    link.send({ type: 'native.response', requestId: nativeRequest.requestId, ok: true, path: CHOSEN_DIRECTORY })
    const result = await readFetch(link, 'native-pick')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.type).toBe('server-response')
    expect(envelope.rpcId).toBe('native-rpc-2')
    expect(envelope.result).toEqual({ ok: true, value: { path: CHOSEN_DIRECTORY } })
  }, 45_000)

  it('carries the operator cancel of the chooser back as a null path', async () => {
    openFetch(link, 'native-pick-cancel', 'native-rpc-3', 'host.pickDirectory', {})
    const nativeRequest = await link.nextNativeRequest()
    expect(nativeRequest.method).toBe('directory.pick')
    link.send({ type: 'native.response', requestId: nativeRequest.requestId, ok: true, path: null })
    const result = await readFetch(link, 'native-pick-cancel')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.result).toEqual({ ok: true, value: { path: null } })
  }, 45_000)

  it('crosses host.openPath with the DSH-resolved path and carries the open back', async () => {
    openFetch(link, 'native-open', 'native-rpc-4', 'host.openPath', { path: OPEN_TARGET })
    const nativeRequest = await link.nextNativeRequest()
    expect(nativeRequest.method).toBe('path.open')
    expect(nativeRequest.path).toBe(OPEN_TARGET)
    link.send({ type: 'native.response', requestId: nativeRequest.requestId, ok: true })
    const result = await readFetch(link, 'native-open')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.result).toEqual({ ok: true, value: { opened: true } })
  }, 45_000)

  it('maps a main-side open failure onto the DSH wire vocabulary', async () => {
    openFetch(link, 'native-open-fail', 'native-rpc-5', 'host.openPath', { path: OPEN_TARGET })
    const nativeRequest = await link.nextNativeRequest()
    expect(nativeRequest.method).toBe('path.open')
    link.send({ type: 'native.response', requestId: nativeRequest.requestId, ok: false, code: 'open-failed', message: 'no default application' })
    const result = await readFetch(link, 'native-open-fail')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.result.ok).toBe(false)
    expect(envelope.result.error?.code).toBe('internal')
    expect(envelope.result.error?.message).toContain('no default application')
  }, 45_000)

  it('settles a main-issued cancel as a channel failure, not an operator cancel', async () => {
    openFetch(link, 'native-pick-cancel-msg', 'native-rpc-6', 'host.pickDirectory', {})
    const nativeRequest = await link.nextNativeRequest()
    expect(nativeRequest.method).toBe('directory.pick')
    link.send({ type: 'native.cancel', requestId: nativeRequest.requestId, reason: 'generation ended' })
    const result = await readFetch(link, 'native-pick-cancel-msg')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.result.ok).toBe(false)
    expect(envelope.result.error?.code).toBe('internal')
    expect(envelope.result.error?.message).toContain('generation ended')
  }, 45_000)

  it('terminates an in-flight pick on client abort, crosses the caller cancel, and drops the late result', async () => {
    openFetch(link, 'native-pick-abort', 'native-rpc-7', 'host.pickDirectory', {})
    const nativeRequest = await link.nextNativeRequest()
    expect(nativeRequest.method).toBe('directory.pick')
    link.send({ type: 'fetch.abort', requestId: 'native-pick-abort' })
    // The caller cancellation crosses as a real runtime→main message for
    // exactly this request.
    const abort = await link.nextNativeAbort()
    expect(abort.requestId).toBe(nativeRequest.requestId)
    expect(abort.reason).not.toBe('')
    // The late chooser result settles nothing: the operation is terminal.
    link.send({ type: 'native.response', requestId: nativeRequest.requestId, ok: true, path: CHOSEN_DIRECTORY })
    await expect(link.drainAborts()).resolves.toBeUndefined()
    // The runtime stays healthy: a later pick still crosses the channel and
    // settles normally.
    openFetch(link, 'native-pick-after-abort', 'native-rpc-8', 'host.pickDirectory', {})
    const second = await link.nextNativeRequest()
    expect(second.method).toBe('directory.pick')
    link.send({ type: 'native.response', requestId: second.requestId, ok: true, path: CHOSEN_DIRECTORY })
    const result = await readFetch(link, 'native-pick-after-abort')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.result).toEqual({ ok: true, value: { path: CHOSEN_DIRECTORY } })
    // No operation is in flight: nothing further crosses the channel.
    await expect(link.drainNative(300)).resolves.toEqual([])
  }, 45_000)

  it('terminates an in-flight open on client abort and crosses the caller cancel', async () => {
    openFetch(link, 'native-open-abort', 'native-rpc-9', 'host.openPath', { path: OPEN_TARGET })
    const nativeRequest = await link.nextNativeRequest()
    expect(nativeRequest.method).toBe('path.open')
    link.send({ type: 'fetch.abort', requestId: 'native-open-abort' })
    const abort = await link.nextNativeAbort()
    expect(abort.requestId).toBe(nativeRequest.requestId)
    // The late open completion settles nothing and emits nothing further.
    link.send({ type: 'native.response', requestId: nativeRequest.requestId, ok: true })
    await expect(link.drainAborts()).resolves.toBeUndefined()
  }, 45_000)

  it('still disposes the whole tree on runtime.shutdown and exits 0', async () => {
    const exitCode = new Promise<number | null>((resolveExit) => {
      child.once('exit', (code) => { resolveExit(code) })
    })
    child.send({ type: 'runtime.shutdown' })
    await expect(exitCode).resolves.toBe(0)
  }, SHUTDOWN_TIMEOUT_MS)
})
