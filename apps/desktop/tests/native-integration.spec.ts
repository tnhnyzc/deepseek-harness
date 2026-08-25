/**
 * Combined acceptance for the desktop native capability channel: forks the
 * built runtime under a temporary home and drives it with the REAL main-side
 * channel (`createNativeChannel`) over a fake OS capability port — the DSH
 * pick crosses as native.request, the caller abort crosses as native.abort
 * and ends the main-side logical request immediately, and the late dialog
 * completion the operator eventually makes is dropped at main rather than
 * emitted as a stale response. Self-skips when the runtime entry has not
 * been built (`pnpm run build`).
 */

import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isNativeAbortMessage, isNativeRequestMessage } from '@deepseek-ai/dsh-desktop-runtime/native'
import { fromOpaqueTransportWire, toOpaqueTransportWire } from '@deepseek-ai/dsh-desktop-runtime/transport'
import { createNativeChannel } from '../src/main/native-channel.ts'
import { createNativeCapabilities } from '../src/main/native-capabilities.ts'

const ENTRY = resolve(import.meta.dirname, '..', '..', 'desktop-runtime', 'dist', 'index.js')
const RUNTIME_CWD = resolve(import.meta.dirname, '..', '..', 'desktop-runtime')
const READY_TIMEOUT_MS = 120_000
const MESSAGE_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 30_000

const CHOSEN_DIRECTORY = '/tmp/dsh-native-integration/chosen'

interface WireMessage {
  type: string
  [key: string]: unknown
}

interface DialogOutcome {
  canceled: boolean
  filePaths: string[]
}

/** One OS port invocation the test controls: resolve it when the operator "decides". */
interface PendingCall<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function controlled<T>(): PendingCall<T> {
  let resolveValue: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolveValue = resolvePromise })
  return {
    promise,
    resolve: (value) => {
      resolveValue(value)
    },
  }
}

/** One controllable invocation per OS call: each dialog is its own promise. */
function makeFakePorts(): {
  pickCalls: PendingCall<DialogOutcome>[]
  openCalls: PendingCall<string>[]
  showOpenDialog: () => Promise<DialogOutcome>
  openPath: () => Promise<string>
} {
  const pickCalls: PendingCall<DialogOutcome>[] = []
  const openCalls: PendingCall<string>[] = []
  return {
    pickCalls,
    openCalls,
    showOpenDialog: () => { const call = controlled<DialogOutcome>(); pickCalls.push(call); return call.promise },
    openPath: () => { const call = controlled<string>(); openCalls.push(call); return call.promise },
  }
}

/** The i-th recorded call; the caller's waitFor asserts the length first. */
function callAt<T>(calls: PendingCall<T>[], i: number): PendingCall<T> {
  const call = calls[i]
  if (call === undefined) throw new Error(`port call ${String(i)} was never recorded`)
  return call
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

/** The native family of one main→child message. */
function isNativeOutbound(value: object): boolean {
  return (value as WireMessage).type === 'native.response' || (value as WireMessage).type === 'native.cancel'
}

/** The child edge, minus Electron: ready detection, the transport queue, and the real native channel. */
class IntegrationLink {
  private transportQueue: WireMessage[] = []
  private transportWaiters: Array<() => void> = []
  sentToChild: object[] = []
  ready: Promise<void>

  /** Only the channel's own outbound family (transport frames are the test's own traffic). */
  nativeOutbound(): object[] {
    return this.sentToChild.filter(isNativeOutbound)
  }

  constructor(private readonly child: ChildProcess, private readonly channel: { handle: (value: unknown) => void }) {
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
        if (isNativeRequestMessage(value) || isNativeAbortMessage(value)) {
          // The supervisor's demux: the native family goes to the channel.
          this.channel.handle(value)
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
    this.sentToChild.push(message)
    this.child.send(toOpaqueTransportWire(message))
  }

  async nextTransport(timeoutMs = MESSAGE_TIMEOUT_MS): Promise<WireMessage | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending = this.transportQueue.shift()
      if (pending !== undefined) return pending
      if (Date.now() >= deadline) return undefined
      await this.park(deadline)
    }
  }

  private park(deadline: number): Promise<void> {
    return new Promise<void>((resolvePark) => {
      const waiter = (): void => {
        clearTimeout(timer)
        const i = this.transportWaiters.indexOf(waiter)
        if (i >= 0) this.transportWaiters.splice(i, 1)
        resolvePark()
      }
      const timer = setTimeout(waiter, Math.max(deadline - Date.now(), 0))
      this.transportWaiters.push(waiter)
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
async function readFetch(link: IntegrationLink, requestId: string): Promise<FetchResult> {
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
function openFetch(link: IntegrationLink, requestId: string, rpcId: string, method: string, payload: Record<string, unknown>): void {
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

describe.skipIf(!existsSync(ENTRY))('desktop native channel integration', () => {
  let home: string
  let child: ChildProcess
  let link: IntegrationLink
  let channel: ReturnType<typeof createNativeChannel>
  let ports: ReturnType<typeof makeFakePorts>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-desktop-native-it-'))
    ports = makeFakePorts()
    child = forkRuntime(home)
    channel = createNativeChannel({
      capabilities: createNativeCapabilities({
        showOpenDialog: () => ports.showOpenDialog(),
        openPath: () => ports.openPath(),
      }),
      send: (message) => { link?.send(message) },
      getWindow: () => undefined,
    })
    link = new IntegrationLink(child, channel)
    await link.ready
  }, READY_TIMEOUT_MS + 10_000)

  afterAll(async () => {
    if (child.exitCode === null && child.kill()) {
      await new Promise<void>((resolveExit) => {
        child.once('exit', () => { resolveExit() })
      })
    }
  }, SHUTDOWN_TIMEOUT_MS)

  it('settles a pick through the real channel and the real bridge', async () => {
    openFetch(link, 'it-pick', 'it-rpc-1', 'host.pickDirectory', {})
    // The channel dispatched to the OS port: the dialog is open.
    await vi.waitFor(() => { expect(ports.pickCalls).toHaveLength(1) })
    callAt(ports.pickCalls, 0).resolve({ canceled: false, filePaths: [CHOSEN_DIRECTORY] })
    const result = await readFetch(link, 'it-pick')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.result).toEqual({ ok: true, value: { path: CHOSEN_DIRECTORY } })
    expect(link.nativeOutbound()).toHaveLength(1)
    expect(link.nativeOutbound()[0]).toMatchObject({ type: 'native.response', ok: true, path: CHOSEN_DIRECTORY })
    expect(channel.pendingIds()).toEqual([])
  }, 45_000)

  it('ends the main-side request on caller abort and drops the late dialog completion', async () => {
    const sentBefore = link.nativeOutbound().length
    openFetch(link, 'it-pick-abort', 'it-rpc-2', 'host.pickDirectory', {})
    // The channel dispatched to the OS port; the request is pending there
    // while the dialog stays open.
    await vi.waitFor(() => { expect(ports.pickCalls).toHaveLength(2) })
    await vi.waitFor(() => { expect(channel.pendingIds()).toHaveLength(1) })
    // The DSH caller gives up while the dialog is still visible.
    link.send({ type: 'fetch.abort', requestId: 'it-pick-abort' })
    // The runtime crossed the caller cancel; the channel marked the request
    // logically terminal immediately. Nothing is sent back for it.
    await vi.waitFor(() => { expect(channel.pendingIds()).toEqual([]) })
    expect(link.nativeOutbound()).toHaveLength(sentBefore)
    // The operator eventually makes a selection: the late completion is
    // dropped at main, never emitted as a stale response.
    callAt(ports.pickCalls, 1).resolve({ canceled: false, filePaths: [CHOSEN_DIRECTORY] })
    await new Promise<void>((resolveSleep) => { setTimeout(resolveSleep, 100) })
    expect(link.nativeOutbound()).toHaveLength(sentBefore)
    expect(channel.pendingIds()).toEqual([])
    // The channel stays healthy for the next request.
    openFetch(link, 'it-pick-after', 'it-rpc-3', 'host.pickDirectory', {})
    await vi.waitFor(() => { expect(ports.pickCalls).toHaveLength(3) })
    callAt(ports.pickCalls, 2).resolve({ canceled: true, filePaths: [] })
    const result = await readFetch(link, 'it-pick-after')
    const envelope = JSON.parse(result.body) as Envelope
    expect(envelope.result).toEqual({ ok: true, value: { path: null } })
  }, 45_000)

  it('still disposes the whole tree on runtime.shutdown and exits 0', async () => {
    const exitCode = new Promise<number | null>((resolveExit) => {
      child.once('exit', (code) => { resolveExit(code) })
    })
    child.send({ type: 'runtime.shutdown' })
    await expect(exitCode).resolves.toBe(0)
  }, SHUTDOWN_TIMEOUT_MS)
})
