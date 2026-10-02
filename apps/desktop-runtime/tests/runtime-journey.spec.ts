/**
 * Layer B — runtime integration: boot the REAL pinned DSH runtime (the built
 * `dist/index.js`) with NO Electron, and drive a normal user turn end to end
 * over the same fork-IPC transport the desktop broker uses.
 *
 * This tier owns the DSH-side behaviour in isolation from the carrier:
 * boot → ready → session/create → session/prompt → the session/follow stream →
 * session/cancel → session/page → shutdown. DSH is never mocked; the only scripted
 * element is the deterministic loopback model the pinned DeepSeek provider
 * reaches through `DEEPSEEK_BASE_URL`. If the agent loop, the event log, the
 * stream carrier, or the persistence breaks, this suite fails — without an
 * Electron window in the picture, so a failure localises to the runtime tier.
 *
 * Self-skips when the runtime has not been built (`pnpm run build`).
 */
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScriptedProvider, type ScriptedProvider } from '../../desktop/tests/support/deterministic-provider.ts'
import { e2eRequired, skipUnless } from '../../desktop/tests/support/electron-world.ts'
import { encodeRemotePayload, RemoteItemReader } from '../src/remote-codec.ts'
import { fromOpaqueTransportWire, toOpaqueTransportWire } from '../src/transport.ts'

const ENTRY = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const RUNTIME_CWD = resolve(import.meta.dirname, '..')
const READY_TIMEOUT_MS = 120_000
const MESSAGE_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 30_000

/** The web fallback port the disabled webserver row would bind. */
const WEB_FALLBACK_PORT = 3080

interface ReadyPayload {
  type: 'runtime.ready'
  runtimeVersion: string
  dshVersion: string
  capabilities: { connection: boolean; httpServer: boolean }
}

interface WireMessage {
  type: string
  [key: string]: unknown
}

/**
 * The fork-IPC transport link. Stream data (`stream.frame`/`end`/`error`) is
 * routed to a registered sink so it never competes with the fetch round trips
 * for the control queue; everything else (readiness, fetch, stream control)
 * lands in the FIFO the tests read.
 */
class RuntimeLink {
  private queue: WireMessage[] = []
  private waiters: Array<() => void> = []
  private streamSink: ((message: WireMessage) => void) | null = null
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
          const decoded = fromOpaqueTransportWire(value)
          if (decoded === null) return
          if (this.streamSink !== null && (decoded.type === 'stream.frame' || decoded.type === 'stream.end' || decoded.type === 'stream.error')) {
            this.streamSink(decoded)
            return
          }
          this.queue.push(decoded)
          for (const wake of this.waiters.splice(0)) wake()
        }
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`runtime exited before ready (code ${String(code)}, signal ${String(signal)})`))
      })
    })
  }

  setStreamSink(sink: (message: WireMessage) => void): void {
    this.streamSink = sink
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

  async untilType(type: string, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<WireMessage> {
    for (;;) {
      const message = await this.next(timeoutMs)
      if (message === undefined) throw new Error(`no ${type} message within ${String(timeoutMs)} ms`)
      if (message.type === type) return message
    }
  }
}

function clientRequest(rpcId: string, method: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: 'client-request', rpcId, method, payload }))
}

/** Drive one fetch over the link; resolves the assembled response. */
async function runFetch(link: RuntimeLink, requestId: string, url: string, body: Uint8Array): Promise<{ status: number; body: string }> {
  link.send({ type: 'fetch.open', requestId, url, method: 'POST', headers: [['content-type', 'application/json']] })
  link.send({ type: 'fetch.request.chunk', requestId, sequence: 0, data: body })
  link.send({ type: 'fetch.request.end', requestId })
  await link.untilType('fetch.request.credit')
  const head = await link.untilType('fetch.response.head')
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

/** One host-plane RPC; resolves the envelope value or throws the host error. */
async function rpc<T>(link: RuntimeLink, rpcId: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const result = await runFetch(link, rpcId, `http://dsh.local/api/${method}`, clientRequest(rpcId, method, payload))
  if (result.status !== 200) throw new Error(`${method} returned status ${String(result.status)}: ${result.body.slice(0, 300)}`)
  const envelope = JSON.parse(result.body) as {
    type: string
    result: { ok: boolean; value: T; error?: { code?: string; message?: string } }
  }
  if (!envelope.result.ok) throw new Error(`${method} failed: ${envelope.result.error?.code}: ${envelope.result.error?.message}`)
  return envelope.result.value
}

/**
 * Read the settled history page at the follow stream's durable cursor, polling
 * until the page's records contain the probe (bounded) so a cold durable read
 * that lags the live stream settles instead of racing.
 */
async function pageUntilContains(
  link: RuntimeLink,
  rpcId: string,
  sessionId: string,
  probe: string,
  follow: SessionFollow,
  timeoutMs: number,
): Promise<{ records: Array<{ type: string }> }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = await rpc<{ records: Array<{ type: string }> }>(link, rpcId, 'session/page', {
      args: { request: { address: { kind: 'session', sessionId }, throughSeq: follow.durableCursor(), maxMessages: 200 } },
    })
    if (JSON.stringify(page.records).includes(probe)) return page
    if (Date.now() >= deadline) throw new Error(`session/page never carried ${JSON.stringify(probe)} within ${String(timeoutMs)} ms (records ${String(page.records.length)})`)
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
}

/**
 * One opened session/follow stream. The carrier frames each decoded stream
 * item as a 4-byte length prefix plus its canonical JSON bytes, so the frames
 * reassemble through the codec's incremental item reader into the session's
 * snapshot and durable event frames.
 */
class SessionFollow {
  frames: unknown[] = []
  private readonly reader = new RemoteItemReader()
  private readonly notify = new Set<() => void>()

  constructor(private readonly link: RuntimeLink, private readonly streamId: string) {}

  /** Register the sink and open the follow for the addressed session; the ack is the caller's to await. */
  open(sessionId: string): void {
    this.link.setStreamSink((message) => {
      if (message.streamId !== this.streamId) return
      if (message.type !== 'stream.frame') return
      const items = this.reader.push(message.data as Uint8Array)
      if (items.length === 0) return
      this.frames.push(...items)
      for (const wake of this.notify) wake()
    })
    this.link.send({
      type: 'stream.open',
      streamId: this.streamId,
      url: 'http://dsh.local/api/session/follow',
      data: encodeRemotePayload({ args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } }),
    })
  }

  async awaitAck(): Promise<void> {
    const ack = await this.link.untilType('stream.open.ack')
    expect(ack.streamId).toBe(this.streamId)
    expect(ack.ok).toBe(true)
  }

  /** The highest durable seq observed (the snapshot cut or an appended event) — the page cursor a cold read accepts. */
  durableCursor(): number {
    let cursor = -1
    for (const frame of this.frames) {
      const value = frame as { type?: unknown; cursor?: unknown; event?: { seq?: unknown } }
      if (value.type === 'snapshot' && typeof value.cursor === 'number' && value.cursor > cursor) cursor = value.cursor
      if (value.type === 'event' && typeof value.event?.seq === 'number' && value.event.seq > cursor) cursor = value.event.seq
    }
    return cursor
  }

  /** Wait until a durable event frame (not a process-local presentation frame) contains the probe (bounded). */
  async awaitDurableContains(probe: string, timeoutMs: number): Promise<void> {
    await this.waitUntil(`carry a durable event with ${JSON.stringify(probe)}`, timeoutMs, () =>
      this.frames.some(frame => (frame as { type?: unknown }).type === 'event' && JSON.stringify(frame).includes(probe)),
    )
  }

  /** Wait until the reassembled frames contain the probe (bounded). */
  async awaitContains(probe: string, timeoutMs: number): Promise<void> {
    await this.waitUntil(`carry ${JSON.stringify(probe)}`, timeoutMs, () => JSON.stringify(this.frames).includes(probe))
  }

  private async waitUntil(description: string, timeoutMs: number, predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate()) return
      if (Date.now() >= deadline) break
      await new Promise<void>((resolveWait) => {
        let settled = false
        const onWake = (): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          this.notify.delete(onWake)
          resolveWait()
        }
        const timer = setTimeout(onWake, deadline - Date.now())
        this.notify.add(onWake)
      })
    }
    throw new Error(`the follow stream never ${description} within ${String(timeoutMs)} ms (frames ${String(this.frames.length)}; tail: ${JSON.stringify(this.frames.slice(-3)).slice(0, 400)})`)
  }
}

function forkRuntime(home: string, providerUrl: string): ChildProcess {
  return fork(ENTRY, [], {
    execPath: process.execPath,
    execArgv: [],
    cwd: RUNTIME_CWD,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DSH_DESKTOP: '1',
      DSH_HOME: home,
      DEEPSEEK_API_KEY: 'keyless-runtime-journey',
      DEEPSEEK_BASE_URL: providerUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
}

function portIsListening(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    createConnection(port, '127.0.0.1')
      .on('connect', () => { resolveProbe(true) })
      .on('error', () => { resolveProbe(false) })
  })
}

describe.skipIf(skipUnless(existsSync(ENTRY)))('desktop runtime journey (real DSH, no Electron)', () => {
  let work: string
  let home: string
  let cwd: string
  let provider: ScriptedProvider
  let child: ChildProcess
  let link: RuntimeLink
  let ready: ReadyPayload
  let mux: SessionFollow
  let sessionId: string

  beforeAll(async () => {
    if (e2eRequired && !existsSync(ENTRY)) {
      throw new Error('required runtime lane has no built runtime entry; the build step must run first')
    }
    provider = await createScriptedProvider({
      'journey stream turn': [
        { kind: 'text', chunks: [['LAYER_B_PARTIAL_', 120], ['LAYER_B_DONE', 120]], finish: true },
      ],
      'journey cancel turn': [
        {
          kind: 'text',
          chunks: [
            ['CANCEL_1', 300], ['CANCEL_2', 300], ['CANCEL_3', 300], ['CANCEL_4', 300],
            ['CANCEL_5', 300], ['CANCEL_6', 300], ['CANCEL_7', 300], ['CANCEL_FINAL', 300],
          ],
          finish: true,
        },
      ],
    }, 'Runtime journey title')
    work = mkdtempSync(join(tmpdir(), 'dsh-runtime-journey-'))
    home = join(work, 'harness')
    cwd = join(work, 'journey-cwd')
    // A fresh, empty runtime home and a fresh session cwd: nothing persisted.
    child = forkRuntime(home, provider.url)
    link = new RuntimeLink(child)
    ready = await link.ready
    // The follow stream addresses a Session, so it opens after the session
    // exists; readiness is the only fact settled at boot.
    mux = new SessionFollow(link, 'journey-follow')
  }, READY_TIMEOUT_MS + 10_000)

  afterAll(async () => {
    if (child.exitCode === null && child.kill()) {
      await new Promise<void>((resolveExit) => { child.once('exit', () => { resolveExit() }) })
    }
    await provider.close()
    rmSync(work, { recursive: true, force: true })
  }, SHUTDOWN_TIMEOUT_MS)

  it('boots the real pinned DSH to ready with the host plane and no web server', async () => {
    expect(ready.type).toBe('runtime.ready')
    expect(ready.dshVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(ready.capabilities).toEqual({ connection: true, httpServer: false })
    await expect(portIsListening(WEB_FALLBACK_PORT)).resolves.toBe(false)
  }, 30_000)

  it('creates a session at a fresh cwd through the real host plane', async () => {
    const created = await rpc<{ sessionId: string }>(link, 'journey-create', 'session/create', { args: { request: { cwd } } })
    expect(created.sessionId).toEqual(expect.any(String))
    sessionId = created.sessionId
    // The live follow opens on the session the rest of the journey addresses.
    mux.open(sessionId)
    await mux.awaitAck()
    const listed = await rpc<{ items: { sessionId: string; running: boolean; cwd?: string }[] }>(link, 'journey-list-1', 'session/list', { args: { _request: {} } })
    expect(listed.items.some(item => item.sessionId === sessionId)).toBe(true)
    expect(listed.items.find(item => item.sessionId === sessionId)?.running).toBe(false)
  }, 60_000)

  it('streams a prompt through the real agent loop onto the live follow stream', async () => {
    const accepted = await rpc<{ accepted: boolean }>(link, 'journey-prompt-1', 'session/prompt', {
      args: { request: { requestId: 'journey-prompt-1', sessionId, mode: 'queue', content: [{ type: 'text', text: 'journey stream turn' }] } },
    })
    expect(accepted.accepted).toBe(true)
    // The real event log carries the model content over the stream, and the
    // durable event frame proves the turn committed before the cold page read.
    await mux.awaitDurableContains('LAYER_B_DONE', 60_000)
    const page = await pageUntilContains(link, 'journey-page-1', sessionId, 'LAYER_B_DONE', mux, 30_000)
    expect(JSON.stringify(page.records)).toContain('LAYER_B_DONE')
  }, 120_000)

  it('cancels an active turn without a synthetic completion', async () => {
    const accepted = await rpc<{ accepted: boolean }>(link, 'journey-prompt-2', 'session/prompt', {
      args: { request: { requestId: 'journey-prompt-2', sessionId, mode: 'queue', content: [{ type: 'text', text: 'journey cancel turn' }] } },
    })
    expect(accepted.accepted).toBe(true)
    // Let the stream start, then cancel through the host plane.
    await mux.awaitContains('CANCEL_2', 30_000)
    const cancelled = await rpc<{ accepted: boolean }>(link, 'journey-cancel', 'session/cancel', { args: { request: { sessionId } } })
    expect(cancelled.accepted).toBe(true)
    // The turn settles (not running) ...
    const deadline = Date.now() + 60_000
    for (;;) {
      const listed = await rpc<{ items: { sessionId: string; running: boolean }[] }>(link, 'journey-list-2', 'session/list', { args: { _request: {} } })
      if (listed.items.find(item => item.sessionId === sessionId)?.running === false) break
      if (Date.now() > deadline) throw new Error('the cancelled turn never stopped running')
      await new Promise(resolveWait => setTimeout(resolveWait, 200))
    }
    // ... and the stream was cut short: the final chunk never reached the follow.
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000))
    expect(JSON.stringify(mux.frames)).not.toContain('CANCEL_FINAL')
  }, 120_000)

  it('replays the settled history with the streamed content intact', async () => {
    const page = await pageUntilContains(link, 'journey-page-2', sessionId, 'LAYER_B_DONE', mux, 30_000)
    expect(page.records.length).toBeGreaterThan(0)
    expect(JSON.stringify(page.records)).toContain('LAYER_B_DONE')
  }, 60_000)

  it('shuts the whole tree down cleanly on runtime.shutdown', async () => {
    const exitCode = new Promise<number | null>((resolveExit) => { child.once('exit', (code) => { resolveExit(code) }) })
    child.send({ type: 'runtime.shutdown' })
    await expect(exitCode).resolves.toBe(0)
  }, SHUTDOWN_TIMEOUT_MS)
})
