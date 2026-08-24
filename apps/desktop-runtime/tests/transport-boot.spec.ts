/**
 * Real-boot acceptance for the desktop transport: forks the built runtime
 * under a temporary home and drives the transport over the child IPC channel
 * exactly the way the dumb broker does — keyless unary round trips through
 * the real host plane, stream open/ack/close, unknown-stream refusal, and
 * channel close. Self-skips when the entry has not been built (`pnpm run
 * build`).
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

interface ReadyPayload {
  type: 'runtime.ready'
  runtimeVersion: string
  dshVersion: string
  capabilities: { apiProxy: boolean; httpServer: boolean }
}

interface WireMessage {
  type: string
  [key: string]: unknown
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

/** Waits the readiness fact, then demultiplexes transport messages off the same channel. */
class TransportLink {
  private queue: WireMessage[] = []
  private waiters: Array<() => void> = []
  ready: Promise<ReadyPayload>

  constructor(private readonly child: ChildProcess) {
    this.ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`runtime did not report ready within ${String(READY_TIMEOUT_MS)} ms`))
      }, READY_TIMEOUT_MS)
      child.on('message', (message: unknown) => {
        const value = message as WireMessage | null
        if (value !== null && typeof value === 'object' && value.type === 'runtime.ready') {
          clearTimeout(timer)
          resolveReady(value as unknown as ReadyPayload)
          return
        }
        if (value !== null && typeof value === 'object' && value.type !== 'runtime.ready') {
          // The child edge encodes byte fields; restore them like the supervisor does.
          const decoded = fromOpaqueTransportWire(value)
          if (decoded !== null) {
            this.queue.push(decoded)
            for (const wake of this.waiters.splice(0)) wake()
          }
        }
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

  async next(timeoutMs = MESSAGE_TIMEOUT_MS): Promise<WireMessage | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending = this.queue.shift()
      if (pending !== undefined) return pending
      if (Date.now() >= deadline) return undefined
      await new Promise<void>((resolveNext) => {
        const timer = setTimeout(resolveNext, deadline - Date.now())
        this.waiters.push(() => {
          clearTimeout(timer)
          resolveNext()
        })
      })
    }
  }

  async ofType(type: string, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<WireMessage> {
    const message = await this.next(timeoutMs)
    if (message === undefined) throw new Error(`no ${type} message within ${String(timeoutMs)} ms`)
    expect(message.type).toBe(type)
    return message
  }
}

/** Drive one fetch over the link; resolves the assembled response facts. */
async function runFetch(link: TransportLink, requestId: string, url: string, body: Uint8Array): Promise<{ status: number; body: string }> {
  link.send({ type: 'fetch.open', requestId, url, method: 'POST', headers: [['content-type', 'application/json']] })
  link.send({ type: 'fetch.request.chunk', requestId, sequence: 0, data: body })
  link.send({ type: 'fetch.request.end', requestId })
  const head = await link.ofType('fetch.response.head')
  const chunks: Uint8Array[] = []
  for (;;) {
    const message = await link.next()
    if (message === undefined) throw new Error(`fetch ${requestId}: no further response message`)
    if (message.type === 'fetch.response.end') break
    if (message.type === 'fetch.error') throw new Error(`fetch ${requestId} failed: ${String(message.code)} ${String(message.message)}`)
    expect(message.type).toBe('fetch.response.chunk')
    chunks.push(message.data as Uint8Array)
  }
  return { status: head.status as number, body: Buffer.concat(chunks).toString('utf8') }
}

function clientRequest(rpcId: string, method: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: 'client-request', rpcId, method, payload }))
}

describe.skipIf(!existsSync(ENTRY))('desktop transport boot', () => {
  let home: string
  let child: ChildProcess
  let link: TransportLink

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-desktop-transport-'))
    child = forkRuntime(home)
    link = new TransportLink(child)
    const ready = await link.ready
    expect(ready.capabilities).toEqual({ apiProxy: true, httpServer: false })
  }, READY_TIMEOUT_MS + 10_000)

  afterAll(async () => {
    if (child.exitCode === null && child.kill()) {
      await new Promise<void>((resolveExit) => {
        child.once('exit', () => { resolveExit() })
      })
    }
  }, SHUTDOWN_TIMEOUT_MS)

  it('round trips a keyless session.list fetch through the real host plane', async () => {
    const result = await runFetch(link, 'boot-sessions', 'http://dsh.local/api/session.list', clientRequest('boot-rpc-1', 'session.list', {}))
    expect(result.status).toBe(200)
    const envelope = JSON.parse(result.body) as { type: string; rpcId: string; result: { ok: boolean; value?: { items?: unknown[] } } }
    expect(envelope.type).toBe('server-response')
    expect(envelope.rpcId).toBe('boot-rpc-1')
    expect(envelope.result.ok).toBe(true)
    expect(envelope.result.value?.items).toEqual([])
  }, 45_000)

  it('round trips a keyless agentPreset.list fetch', async () => {
    const result = await runFetch(link, 'boot-presets', 'http://dsh.local/api/agentPreset.list', clientRequest('boot-rpc-2', 'agentPreset.list', {}))
    expect(result.status).toBe(200)
    const envelope = JSON.parse(result.body) as { type: string; result: { ok: boolean } }
    expect(envelope.type).toBe('server-response')
    expect(envelope.result.ok).toBe(true)
  }, 45_000)

  it('answers a 404 for an unknown api path with the carrier status', async () => {
    const result = await runFetch(link, 'boot-404', 'http://dsh.local/api/nope.nope', clientRequest('boot-rpc-3', 'nope.nope', {}))
    expect(result.status).toBe(404)
  }, 45_000)

  it('opens the mux downlink, acks it, and closes it on request', async () => {
    link.send({ type: 'stream.open', streamId: 'boot-mux', url: 'http://dsh.local/api/events.mux' })
    const ack = await link.ofType('stream.open.ack')
    expect(ack.streamId).toBe('boot-mux')
    expect(ack.ok).toBe(true)
    link.send({ type: 'stream.close', streamId: 'boot-mux', reason: 'done' })
    // A client-initiated close is not answered with a terminal; drain the
    // frames the pump emitted (the carrier's own open comment is one) so
    // later tests see a quiet channel.
    let drained = 0
    for (;;) {
      const message = await link.next(500)
      if (message === undefined) break
      expect(message.type).toBe('stream.frame')
      expect(message.streamId).toBe('boot-mux')
      drained++
    }
    expect(drained).toBeGreaterThanOrEqual(1)
  }, 45_000)

  it('refuses an unknown stream url', async () => {
    link.send({ type: 'stream.open', streamId: 'boot-unknown', url: 'http://dsh.local/api/unknown' })
    const ack = await link.ofType('stream.open.ack')
    expect(ack.streamId).toBe('boot-unknown')
    expect(ack.ok).toBe(false)
    expect(ack.reason).toBe('unknown-stream')
  }, 45_000)

  it('ends its transport operations on runtime.transport-closed and stays alive', async () => {
    link.send({ type: 'runtime.transport-closed' })
    // The channel is torn down: a fresh open gets no ack until re-opened, and
    // the process is still serving. Prove liveness with a unary round trip.
    const result = await runFetch(link, 'boot-after-close', 'http://dsh.local/api/session.list', clientRequest('boot-rpc-4', 'session.list', {}))
    expect(result.status).toBe(200)
  }, 45_000)

  it('still disposes the whole tree on runtime.shutdown and exits 0', async () => {
    const exitCode = new Promise<number | null>((resolveExit) => {
      child.once('exit', (code) => { resolveExit(code) })
    })
    child.send({ type: 'runtime.shutdown' })
    await expect(exitCode).resolves.toBe(0)
  }, SHUTDOWN_TIMEOUT_MS)
})
