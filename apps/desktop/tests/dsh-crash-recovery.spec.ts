/**
 * Stage 9 runtime crash recovery (SPEC §23): a real runtime crash, injected
 * as a process-group SIGKILL of the standalone desktop-runtime child, during
 * each of idle, model generation, tool (shell command) execution, the
 * approval wait, the user-question wait, and subagent execution. After every
 * crash: the renderer stays alive, the generation's transport is dead and
 * every pending request rejects, the failure screen shows the reason and the
 * retained runtime diagnostics, and a user restart boots a fresh generation
 * whose client tree reboots in place and reconnects from the persisted DSH
 * state. The interrupted turn is closed by the pinned persistence repair
 * (`turn/end` with the `interrupted` reason — never `completed`), and the
 * session stays resumable. Real Electron + real desktop-runtime + real pinned
 * DSH composition; the only non-real element is the scripted deterministic
 * LLM provider on the `DEEPSEEK_BASE_URL` seam, as in the stage 6/8 suites.
 * Self-skips without built artifacts or a GUI session.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { _electron as electron } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const appDir = join(import.meta.dirname, '..')
const mainEntry = join(appDir, 'dist', 'main', 'index.js')
const rendererIndex = join(appDir, 'dist', 'renderer', 'index.html')
const runtimeEntry = join(appDir, '..', 'desktop-runtime', 'dist', 'index.js')
const bundledNode = join(appDir, 'node', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'node.exe' : 'node')

function guiAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
}

const built = existsSync(mainEntry) && existsSync(rendererIndex)
const runtimeBuilt = built && existsSync(runtimeEntry) && existsSync(bundledNode)

// ── scripted deterministic provider ─────────────────────────────────────────

type TurnStep =
  | { kind: 'text'; chunks: [text: string, delayMs: number][]; finish: boolean }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }

/** Per-turn scripts keyed by the marker the test puts in the prompt text. */
const TURNS: Record<string, TurnStep[]> = {
  // A long slow stream for the mid-generation crash: long enough that the
  // cut lands mid-stream whatever the durable flush latency, with a
  // distinctive final chunk that proves nothing lands after the cut.
  'crash stream': [
    {
      kind: 'text',
      chunks: [
        ['CRASHX_1', 300], ['CRASHX_2', 300], ['CRASHX_3', 300], ['CRASHX_4', 300],
        ['CRASHX_5', 300], ['CRASHX_6', 300], ['CRASHX_7', 300], ['CRASHX_8', 300],
        ['CRASHX_9', 300], ['CRASHX_10', 300], ['CRASHX_11', 300], ['CRASHX_12', 300],
        ['CRASHX_13', 300], ['CRASHX_14', 300], ['CRASHX_15', 300], ['CRASHX_16', 300],
        ['CRASHX_17', 300], ['CRASHX_18', 300], ['CRASHX_19', 300], ['CRASHX_FINAL', 300],
      ],
      finish: true,
    },
  ],
  // A shell command the crash interrupts mid-execution: the file the command
  // would write must not exist after recovery (the tool never completed).
  'crash tool': [
    {
      kind: 'tool', name: 'bash',
      args: { command: 'sleep 8 && echo crash-tool-done > ct-out.txt', description: 'long sleep the crash interrupts' },
    },
  ],
  // Escalated in read-only mode: the crash lands while the approval wait is
  // pending, so the tool never runs and the file is never written.
  'crash approval': [
    {
      kind: 'tool', name: 'bash',
      args: {
        command: 'echo approval-crash > ac-out.txt', description: 'write the approval crash file',
        sandbox_permissions: 'workspace-write', justification: 'the read-only sandbox refused the write this task needs',
      },
    },
  ],
  'crash question': [
    {
      kind: 'tool', name: 'ask_user_question',
      args: {
        questions: [{
          id: 'shape', question: 'Pick a shape for the crash recovery probe.', header: 'Shape',
          options: [{ label: 'Square' }, { label: 'Circle' }],
        }],
      },
    },
  ],
  // The parent dispatches a waiting subagent; the child's own model calls
  // route through the `crash subagent child` marker below.
  'crash subagent': [
    {
      kind: 'tool', name: 'subagent',
      args: {
        description: 'Crash probe child',
        prompt: 'crash subagent child work',
        run_in_background: false,
      },
    },
  ],
  // The subagent's own stream: slow enough that the crash lands mid-run.
  'crash subagent child': [
    {
      kind: 'text',
      chunks: [
        ['SUBCH_1', 400], ['SUBCH_2', 400], ['SUBCH_3', 400],
        ['SUBCH_4', 400], ['SUBCH_5', 400], ['SUBCH_FINAL', 400],
      ],
      finish: true,
    },
  ],
  // The post-recovery prompt proving the session resumed into a completed turn.
  'crash resume': [
    { kind: 'text', chunks: [['CRASH_RESUME_DONE', 100]], finish: true },
  ],
}

let toolCallCounter = 0
/** Model requests the subagent child served (crash-during-subagent evidence). */
let subagentChildRequests = 0

function sse(data: string): string { return `data: ${data}\n\n` }
function sseStop(): string {
  return sse('{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}') + sse('[DONE]')
}
function sseToolCall(name: string, args: Record<string, unknown>): string {
  toolCallCounter += 1
  return sse(JSON.stringify({
    choices: [{
      delta: {
        role: 'assistant', content: null,
        tool_calls: [{ index: 0, id: `call_crash_${toolCallCounter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  })) + sse('{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}') + sse('[DONE]')
}

/** The last user-text marker and how many tool results follow it (the turn step). */
function route(body: string): { marker: string | undefined; step: number } {
  let messages: unknown
  try {
    messages = (JSON.parse(body) as { messages?: unknown }).messages
  } catch {
    return { marker: undefined, step: 0 }
  }
  if (!Array.isArray(messages)) return { marker: undefined, step: 0 }
  let marker: string | undefined
  let markerIndex = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as { role?: unknown; content?: unknown }
    if (message?.role !== 'user') continue
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? (message.content as { type?: unknown; text?: unknown }[]).map(item => typeof item?.text === 'string' ? item.text : '').join(' ')
        : ''
    for (const key of Object.keys(TURNS)) {
      if (text.includes(key)) {
        marker = key
        markerIndex = index
      }
    }
  }
  if (marker === undefined) return { marker: undefined, step: 0 }
  let step = 0
  for (let index = markerIndex + 1; index < messages.length; index += 1) {
    if ((messages[index] as { role?: unknown })?.role === 'tool') step += 1
  }
  return { marker, step }
}

function handleProviderRequest(request: IncomingMessage, response: ServerResponse): void {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => { body += chunk })
  const serve = async (): Promise<void> => {
    try {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let parsed: { max_tokens?: unknown } = {}
      try { parsed = JSON.parse(body) as { max_tokens?: unknown } } catch { /* non-JSON probes get the idle stream */ }
      if (parsed.max_tokens === 64) {
        // The automatic-title call (a small max_tokens request): a neutral
        // title, never a scripted step.
        response.end(sse('{"choices":[{"delta":{"content":"Crash recovery probe"}}]}' + sseStop()))
        return
      }
      const { marker, step } = route(body)
      if (marker === 'crash subagent child') subagentChildRequests += 1
      const steps = marker !== undefined ? TURNS[marker] : undefined
      const current = steps?.[step]
      if (current === undefined) {
        // Outside the script (stray or replanned request): finish with text.
        response.end(sse('{"choices":[{"delta":{"content":"crash idle"}}]}') + sseStop())
        return
      }
      if (current.kind === 'tool') {
        response.end(sseToolCall(current.name, current.args))
        return
      }
      for (const [text, delayMs] of current.chunks) {
        if (response.destroyed) return
        await new Promise((resolve) => { setTimeout(resolve, delayMs) })
        if (response.destroyed) return
        response.write(sse(`{"choices":[{"delta":{"content":"${text}"}}]}`))
      }
      if (current.finish && !response.destroyed) response.end(sseStop())
    } catch {
      // A destroyed socket during pacing is the expected crash outcome.
      if (!response.destroyed) {
        try { response.end() } catch { /* already destroyed */ }
      }
    }
  }
  request.on('end', () => { void serve() })
}

// ── world ────────────────────────────────────────────────────────────────────

let provider: ReturnType<typeof createServer>
let providerUrl: string
let work: string
let userData: string
let home: string
let workspaceDir: string
let app: ElectronApplication
let win: Page
const pageErrors: string[] = []

interface RpcEnvelope<T> {
  type: string
  result: { ok: boolean; value: T; error?: { code?: string; message?: string } }
}

function rpc<T>(method: string, payload: unknown): Promise<T> {
  return win.evaluate(async ({ m, p }: { m: string; p: unknown }) => {
    const transport = globalThis as unknown as { __DSH_TRANSPORT__: { fetch: (input: URL, init: RequestInit) => Promise<Response> } }
    const response = await transport.__DSH_TRANSPORT__.fetch(new URL(`/api/${m}`, location.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `crash-${m}`, method: m, payload: p }),
    })
    return JSON.parse(await response.text()) as RpcEnvelope<T>
  }, { m: method, p: payload }).then((envelope) => {
    if (!envelope.result.ok) throw new Error(`${method} failed: ${envelope.result.error?.code}: ${envelope.result.error?.message}`)
    return envelope.result.value
  })
}

interface SessionSummary {
  sessionId: string
  blank: boolean
  running: boolean
  cwd?: string
}

/**
 * Decode a session artifact. The shipped JSONL backend stores a
 * concatenated Zstandard frame container (one frame per durable batch);
 * Node's one-shot zstd API reads only the first frame, so the frame
 * boundaries are located structurally, mirroring the backend's scanner.
 */
function decodeSessionArtifact(file: string): string {
  if (!file.endsWith('.zstd')) return readFileSync(file, 'utf8')
  const buffer = readFileSync(file)
  const ZSTD_MAGIC = 0xfd2fb528
  const frames: { start: number; end: number }[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    let complete = true
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) { complete = false } else { offset += remainingHeaderBytes }
    if (complete) {
      for (;;) {
        if (buffer.length - offset < 3) { complete = false; break }
        const blockHeader = buffer.readUIntLE(offset, 3)
        offset += 3
        const lastBlock = (blockHeader & 1) !== 0
        const blockType = (blockHeader >>> 1) & 0x03
        const blockSize = blockHeader >>> 3
        const payloadBytes = blockType === 0x01 ? 1 : blockSize
        if (buffer.length - offset < payloadBytes) { complete = false; break }
        offset += payloadBytes
        if (lastBlock) break
      }
    }
    if (complete) {
      if (checksum && offset + 4 > buffer.length) complete = false
      else if (checksum) offset += 4
    }
    if (!complete || offset <= start) break
    frames.push({ start, end: offset })
  }
  return frames
    .map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    .join('')
}

interface LogRecord {
  seq: number
  type: string
  data: unknown
}

/** One durable session log (file and its records in seq order). */
interface SessionLog {
  file: string
  records: LogRecord[]
}

function parseLogRecords(file: string): LogRecord[] {
  const records: LogRecord[] = []
  for (const line of decodeSessionArtifact(file).split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as { seq?: unknown; type?: unknown; data?: unknown }
      if (typeof record.type === 'string' && typeof record.seq === 'number') {
        records.push({ seq: record.seq, type: record.type, data: record.data ?? null })
      }
    } catch { /* a torn trailing line mid-flush is not a record */ }
  }
  return records
}

/** Every durable session log under the home, one entry per file. */
function sessionLogs(): SessionLog[] {
  const logs: SessionLog[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd') logs.push({ file: path, records: parseLogRecords(path) })
    }
  }
  walk(home)
  return logs
}

/** Every durable record, in on-disk (seq) order, across all sessions. */
function sessionLogRecords(): LogRecord[] {
  return sessionLogs().flatMap(log => log.records)
}

/** The log file holding one record whose `type` and data match the probes. */
function logContaining(type: string, dataProbe: string): SessionLog | undefined {
  return sessionLogs().find(log => log.records.some(r => r.type === type && JSON.stringify(r.data).includes(dataProbe)))
}

/** The durable `tool/call` record whose payload contains the probe text. */
function findToolCall(probe: string): { seq: number; callId: string; turn: number } | undefined {
  const record = sessionLogRecords().find(r => r.type === 'tool/call' && JSON.stringify(r.data).includes(probe))
  if (record === undefined) return undefined
  const data = record.data as { callId?: unknown; turn?: unknown }
  if (typeof data.callId !== 'string' || typeof data.turn !== 'number') return undefined
  return { seq: record.seq, callId: data.callId, turn: data.turn }
}

/**
 * The pinned repair's outcome for one recorded call: a synthetic
 * `tool/result` citing the call, with the recovery error code.
 */
function callOutcome(callId: string): string | undefined {
  const result = sessionLogRecords().find(r => r.type === 'tool/result'
    && JSON.stringify((r.data as { message?: { source?: { callId?: unknown } } }).message?.source ?? {}).includes(callId))
  return (result?.data as { error?: { code?: unknown } })?.error?.code as string | undefined
}

/** Whether one turn's durable end carries the pinned `interrupted` reason. */
function turnInterrupted(turn: number): boolean {
  return sessionLogRecords().some(r => r.type === 'turn/end'
    && (r.data as { turn?: unknown }).turn === turn
    && (r.data as { reason?: { kind?: unknown } })?.reason?.kind === 'interrupted')
}

/** Poll the durable log for one recorded call until it is present. */
async function waitForCall(probe: string, timeoutMs = 60_000): Promise<{ seq: number; callId: string; turn: number }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const call = findToolCall(probe)
    if (call !== undefined) return call
    if (Date.now() > deadline) throw new Error(`timeout waiting for the ${probe} call to be recorded`)
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
}

/** The turn/end reason kind of every durably ended turn, by turn number. */
function turnEndReasons(): Map<number, string> {
  const reasons = new Map<number, string>()
  for (const record of sessionLogRecords()) {
    if (record.type !== 'turn/end') continue
    const data = record.data as { turn?: unknown; reason?: { kind?: unknown } }
    if (typeof data.turn === 'number' && typeof data.reason?.kind === 'string') {
      reasons.set(data.turn, data.reason.kind)
    }
  }
  return reasons
}

/** Poll the durable log until the predicate holds (the crash-recovery closers are written on session load). */
async function waitForLog(
  check: (records: Array<{ seq: number; type: string; data: unknown }>) => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check(sessionLogRecords())) return
    if (Date.now() > deadline) throw new Error('timeout waiting for the durable log to reach the expected state')
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
}

// ── crash injection ──────────────────────────────────────────────────────────

/**
 * The live desktop-runtime child of this suite's app. Other suites boot
 * their own runtime from the same entry in parallel, so the match requires
 * the parent to be this suite's Electron main.
 */
function findRuntimePid(mainPid: number): number {
  const rows = execFileSync('ps', ['-axwww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const foreign: number[] = []
  for (const row of rows.split('\n')) {
    if (!row.includes(runtimeEntry)) continue
    const fields = row.trimStart().split(/\s+/)
    const pid = Number(fields[0])
    const ppid = Number(fields[1])
    if (!Number.isFinite(pid) || pid <= 0) continue
    if (ppid === mainPid) return pid
    foreign.push(pid)
  }
  throw new Error(
    `no runtime child of electron main ${mainPid} running ${runtimeEntry}`
    + (foreign.length > 0 ? ` (foreign candidates: ${foreign.join(', ')})` : ''),
  )
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function awaitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000
  while (processAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`runtime pid ${pid} did not exit`)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
}

/**
 * Kill the runtime's whole process group: the forked child leads its own
 * group, so the group SIGKILL reaches its descendants — the shell tool, the
 * subagent worker — exactly like the supervisor's forced kill.
 */
async function killRuntime(): Promise<void> {
  const mainPid = app.process().pid
  if (mainPid === undefined) throw new Error('the electron main pid is unknown')
  const pid = findRuntimePid(mainPid)
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      process.kill(pid, 'SIGKILL')
    }
  }
  await awaitGone(pid)
}

// ── shell and recovery helpers ───────────────────────────────────────────────

function rootState(): Promise<string | undefined> {
  return win.evaluate(() => document.getElementById('root')?.dataset.state)
}

async function awaitState(state: string, timeoutMs = 120_000): Promise<void> {
  await win.waitForFunction(
    (expected: string) => document.getElementById('root')?.dataset.state === expected,
    state,
    { timeout: timeoutMs },
  )
}

/**
 * The failure screen's facts. The diagnostics block renders only when the
 * runtime's retained output is non-empty (the pinned runtime is quiet in
 * normal operation, so an absent block on a clean crash is expected); the
 * reason line always carries the exit code or signal.
 */
function failureScreenFacts(): Promise<{ status: string; diagnostics: string | null; hasRestart: boolean }> {
  return win.evaluate(() => {
    const status = document.querySelector('.shell-status')?.textContent ?? ''
    const diagnostics = document.querySelector('.shell-diagnostics')?.textContent ?? null
    const hasRestart = document.querySelector('button.shell-restart') !== null
    return { status, diagnostics, hasRestart }
  })
}

/** Wait for the failure screen, then restart the runtime through it. */
async function crashAndRestart(): Promise<void> {
  await killRuntime()
  await awaitState('failed')
  const facts = await failureScreenFacts()
  expect(facts.status, 'the failure screen must name the crash').toContain('runtime exited unexpectedly')
  if (facts.diagnostics !== null) expect(facts.diagnostics, 'rendered diagnostics must be retained output').not.toBe('')
  expect(facts.hasRestart, 'the failure screen must offer the restart').toBe(true)
  expect(pageErrors).toEqual([])
  const restart = win.locator('button.shell-restart')
  await restart.click()
  await awaitState('ready')
  await awaitClientLive()
}

/** The conversation composer is live when its textarea is writable. */
function composerEditable(): Promise<boolean> {
  return win.evaluate(() => {
    const el = document.querySelector('[data-composer-card] textarea') as HTMLTextAreaElement | null
    return el !== null && !el.readOnly
  })
}

/**
 * Wait for the pinned client tree to be live on (a rebooted) window. After a
 * restart the boot globals survive from the first generation, so the
 * composer — which only exists once the new tree has fully booted — is the
 * real gate.
 */
async function awaitClientLive(): Promise<void> {
  await win.waitForFunction(() => {
    const state = document.getElementById('root')?.dataset.state
    return (state === 'ready' || state === 'failed') && (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ !== undefined
  }, undefined, { timeout: 120_000 })
  expect(await rootState()).toBe('ready')
  const deadline = Date.now() + 90_000
  for (;;) {
    if (await composerEditable()) return
    if (Date.now() > deadline) throw new Error('the composer never became editable after boot/restart')
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
}

/** The session tree lives in the sidebar, which a fresh profile opens collapsed. */
async function openSidebar(): Promise<void> {
  const toggle = win.getByRole('button', { name: 'Open sidebar' })
  if (await toggle.count() > 0) {
    await toggle.first().click()
    await win.locator('[role="treeitem"]').first().waitFor({ timeout: 15_000 })
  }
}

/**
 * Reopen the session that carried the turns. Auto-selection reuses the
 * workspace's session, but the conversation view is only guaranteed by an
 * explicit row open: only a non-blank session row carries its row-menu
 * button (the blank sibling renders a New Session placeholder).
 */
async function openTurnSession(): Promise<void> {
  await openSidebar()
  const sessionRow = win.locator('[role="treeitem"]').filter({ has: win.locator('button[aria-label^="Session actions for"]') }).first()
  await sessionRow.waitFor({ timeout: 30_000 })
  await sessionRow.click()
}

/** Send one prompt into the composer. */
async function sendPrompt(text: string): Promise<void> {
  const composer = win.locator('[data-composer-card] textarea')
  await composer.fill(text)
  await composer.press('Enter')
}

/** Switch the session sandbox access mode through the composer seat. */
async function switchAccessMode(mode: 'Read Only' | 'Workspace Write'): Promise<void> {
  await win.locator('button[aria-label^="Access mode"]').click()
  await win.getByRole('menuitem', { name: mode }).click()
  await expect.poll(async () =>
    (await win.locator(`button[aria-label="Access mode, current: ${mode}"]`).count()) > 0, { timeout: 15_000 }).toBe(true)
}

function bodyText(): Promise<string> {
  return win.evaluate(() => document.body.innerText)
}

function assertNoPageErrors(): void {
  expect(pageErrors).toEqual([])
}

/** No session reports a live run on the recovered runtime. */
async function assertNothingRunning(): Promise<void> {
  const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
  expect(sessions.items.every(item => !item.running)).toBe(true)
}

describe.skipIf(!guiAvailable() || !runtimeBuilt)('desktop DSH crash recovery (stage 9)', () => {
  beforeAll(async () => {
    provider = createServer(handleProviderRequest)
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as AddressInfo
    providerUrl = `http://127.0.0.1:${address.port}`
    work = mkdtempSync(join(tmpdir(), 'dsh-desktop-crash-'))
    userData = join(work, 'user-data')
    home = join(userData, 'harness')
    mkdirSync(join(work, 'crash-ws'), { recursive: true })
    workspaceDir = realpathSync(join(work, 'crash-ws'))
    seedWorkspaceRegistry(home, workspaceDir)
    app = await launchApp()
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (error) => { pageErrors.push(error.message) })
    await awaitClientLive()
    // The product-wide first-run notice renders shortly after boot and its
    // backdrop mask would intercept every later click; acknowledge it exactly
    // as a first-run user would (the ack is durable, so later boots are free).
    const continueButton = win.getByRole('button', { name: 'Continue' })
    try {
      await continueButton.waitFor({ state: 'visible', timeout: 60_000 })
      await continueButton.click()
      await continueButton.waitFor({ state: 'detached', timeout: 10_000 })
    } catch {
      // The notice is absent: this home already acknowledged it.
    }
  }, 300_000)

  afterAll(async () => {
    if (app !== undefined) await app.close().catch(() => {})
    await new Promise<void>(resolve => provider?.close(() => { resolve() }))
    rmSync(work, { recursive: true, force: true })
  }, 120_000)

  it('crashes while idle: failure screen, live renderer, dead transport, working restart', async () => {
    // The transport is the boot generation's channel: after the crash it
    // must reject deterministically instead of hanging the caller.
    const transportDead = await killRuntime().then(async () => {
      await awaitState('failed')
      return win.evaluate(async () => {
        const hooks = (globalThis as unknown as { __DSH_TRANSPORT__: { fetch: (input: URL, init?: RequestInit) => Promise<Response> } })
        try {
          await hooks.__DSH_TRANSPORT__.fetch(new URL('/api/session.list', location.origin), { method: 'POST', body: '{}' })
          return false
        } catch {
          return true
        }
      })
    })
    expect(transportDead, 'every pending transport request must reject after the crash').toBe(true)
    const facts = await failureScreenFacts()
    // The group SIGKILL death is named: signal, not a code.
    expect(facts.status).toContain('signal SIGKILL')
    // The pinned runtime is quiet in normal operation: the diagnostics block
    // renders only when the ring retained output.
    if (facts.diagnostics !== null) expect(facts.diagnostics).not.toBe('')
    // The renderer process survived the crash: it answers evaluates.
    expect(await win.evaluate(() => 1 + 1)).toBe(2)
    assertNoPageErrors()
    const restart = win.locator('button.shell-restart')
    await restart.click()
    await awaitState('ready')
    await awaitClientLive()
    // The recovered generation serves the persisted-state surface.
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(Array.isArray(sessions.items)).toBe(true)
    assertNoPageErrors()
  }, 240_000)

  it('crashes mid-generation: the turn is interrupted, not completed, and the session resumes', async () => {
    await sendPrompt('crash stream')
    // Cut only once a chunk is durably recorded: the recovered transcript's
    // prefix must be provable from the log, not from flush timing.
    await waitForLog(list => list.some(r => r.type === 'assistant/chunk' && JSON.stringify(r.data).includes('CRASHX_1')))
    const before = new Set(sessionLogRecords().map(r => r.seq))
    await crashAndRestart()
    await openTurnSession()
    await expect.poll(() => bodyText().then(text => /CRASHX_\d/.test(text)), { timeout: 60_000 }).toBe(true)
    // The durably recorded prefix survived; nothing after the cut: the
    // scripted tail never reached the log or the recovered transcript.
    expect(sessionLogRecords().some(r => r.type === 'assistant/chunk' && JSON.stringify(r.data).includes('CRASHX_1'))).toBe(true)
    const body = await bodyText()
    expect(body).not.toContain('CRASHX_FINAL')
    expect(sessionLogRecords().some(r => JSON.stringify(r).includes('CRASHX_FINAL'))).toBe(false)
    // The pinned persistence repair closed the interrupted tail: a turn/end
    // with the `interrupted` reason exists, and no turn ended `completed` in
    // this crash window.
    await waitForLog(list => list.some((r) => {
      if (r.type !== 'turn/end') return false
      const data = r.data as { reason?: { kind?: unknown } }
      return data.reason?.kind === 'interrupted'
    }))
    expect([...turnEndReasons().values()].some(kind => kind === 'interrupted')).toBe(true)
    const afterSeqs = sessionLogRecords().filter(r => r.seq > Math.max(...before, 0))
    expect(afterSeqs.every(r => r.type !== 'turn/end' || (r.data as { reason?: { kind?: unknown } })?.reason?.kind !== 'completed'),
      'the interrupted turn must not be reported completed').toBe(true)
    await assertNothingRunning()
    // Resumable: a new prompt on the recovered session completes normally.
    await sendPrompt('crash resume')
    await expect.poll(() => bodyText().then(text => text.includes('CRASH_RESUME_DONE')), { timeout: 60_000 }).toBe(true)
    await waitForLog((list) => {
      const latest = Math.max(...list.filter(r => r.type === 'turn/end').map(r => (r.data as { turn: number }).turn))
      const end = list.find(r => r.type === 'turn/end' && (r.data as { turn: unknown }).turn === latest)
      return (end?.data as { reason?: { kind?: unknown } })?.reason?.kind === 'completed'
    })
    await assertNothingRunning()
    assertNoPageErrors()
  }, 300_000)

  it('crashes during a tool (shell) command: the recorded call is closed with an unknown outcome', async () => {
    await sendPrompt('crash tool')
    // The tool is durably recorded before it runs; kill while its shell
    // command is mid-execution.
    await waitForLog(list => list.some(r => r.type === 'tool/call' && JSON.stringify(r.data).includes('sleep 8')))
    const call = findToolCall('sleep 8')
    expect(call, 'the interrupted shell call must be durably recorded').toBeDefined()
    if (call === undefined) throw new Error('the interrupted shell call must be durably recorded')
    await crashAndRestart()
    await openTurnSession()
    // The pinned repair closed the recorded call with its recovery result
    // (outcome unknown) before closing the step and the turn.
    await waitForLog(() => callOutcome(call.callId) === 'TOOL_OUTCOME_UNKNOWN')
    await waitForLog(() => turnInterrupted(call.turn))
    // The command never completed: the file it would write does not exist.
    expect(existsSync(join(workspaceDir, 'ct-out.txt'))).toBe(false)
    // The recovered turn renders failed with the pinned recovery text for
    // the interrupted call — the tool outcome is unknown, never completed.
    await expect.poll(() => bodyText().then(text => text.includes('interrupted after it was recorded')), { timeout: 30_000 }).toBe(true)
    await assertNothingRunning()
    assertNoPageErrors()
  }, 300_000)

  it('crashes while waiting for approval: the pending wait dies with the runtime', async () => {
    await switchAccessMode('Read Only')
    await sendPrompt('crash approval')
    const panel = win.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    // The escalated call is recorded before the wait; capture it for the
    // outcome assertion.
    const call = await waitForCall('approval crash file', 30_000)
    await crashAndRestart()
    await openTurnSession()
    // The pending approval is runtime state: the recovered runtime holds no
    // such wait, so no stale, unanswerable panel may render.
    await expect.poll(() => win.locator('[data-approval-key]').count(), { timeout: 30_000 }).toBe(0)
    // The interrupted turn is closed by the pinned repair like any other:
    // the escalated call's outcome is unknown, its turn ends interrupted.
    await waitForLog(() => callOutcome(call.callId) === 'TOOL_OUTCOME_UNKNOWN')
    await waitForLog(() => turnInterrupted(call.turn))
    // The escalated write never ran.
    expect(existsSync(join(workspaceDir, 'ac-out.txt'))).toBe(false)
    await assertNothingRunning()
    assertNoPageErrors()
  }, 300_000)

  it('crashes while waiting for a user question: the pending wait dies with the runtime', async () => {
    await sendPrompt('crash question')
    const question = win.locator('[data-question-key]')
    await question.waitFor({ timeout: 60_000 })
    const call = await waitForCall('crash recovery probe', 30_000)
    await crashAndRestart()
    await openTurnSession()
    // The pending question is runtime state: no stale, unanswerable panel.
    await expect.poll(() => win.locator('[data-question-key]').count(), { timeout: 30_000 }).toBe(0)
    await waitForLog(() => callOutcome(call.callId) === 'TOOL_OUTCOME_UNKNOWN')
    await waitForLog(() => turnInterrupted(call.turn))
    await assertNothingRunning()
    assertNoPageErrors()
  }, 300_000)

  it('crashes during subagent execution: recovery is deterministic and the child never completes', async () => {
    await sendPrompt('crash subagent')
    // The parent recorded the waiting delegation, and the child's model
    // request is in flight: kill while the subagent is mid-run.
    const call = await waitForCall('Crash probe child')
    const childDeadline = Date.now() + 60_000
    while (subagentChildRequests < 1) {
      if (Date.now() > childDeadline) throw new Error('the subagent child never reached the provider')
      await new Promise((resolve) => { setTimeout(resolve, 100) })
    }
    await new Promise((resolve) => { setTimeout(resolve, 400) })
    await crashAndRestart()
    await openTurnSession()
    // The child's stream died mid-run: its final chunk never became durable
    // anywhere.
    expect(sessionLogRecords().some(r => JSON.stringify(r).includes('SUBCH_FINAL'))).toBe(false)
    // The pinned repair closed the waiting delegation with an unknown
    // outcome and interrupted the parent turn.
    await waitForLog(() => callOutcome(call.callId) === 'TOOL_OUTCOME_UNKNOWN')
    await waitForLog(() => turnInterrupted(call.turn))
    // The recovered parent log is balanced: every recorded turn/start has
    // its matching turn/end. (The child's own session log is a separate
    // file, loaded only if its conversation is opened; it is excluded here.)
    const parentLog = logContaining('tool/call', 'Crash probe child')
    expect(parentLog, 'the parent session log must hold the delegation').toBeDefined()
    if (parentLog === undefined) throw new Error('the parent session log must hold the delegation')
    await waitForLog(() => {
      const current = logContaining('tool/call', 'Crash probe child')
      if (current === undefined) return false
      const starts = current.records.filter(r => r.type === 'turn/start').map(r => (r.data as { turn: number }).turn)
      const ends = new Set(current.records.filter(r => r.type === 'turn/end').map(r => (r.data as { turn: number }).turn))
      return starts.every(turn => ends.has(turn))
    })
    // The delegation is visible in the recovered UI (the session's subagent
    // badge), rendered from the persisted log.
    await expect.poll(() => bodyText().then(text => /subagent/.test(text)), { timeout: 30_000 }).toBe(true)
    await assertNothingRunning()
    assertNoPageErrors()
  }, 300_000)

  it('survives a second crash generation with all persisted state intact', async () => {
    await crashAndRestart()
    await openTurnSession()
    // Wait for the reloaded history to settle, then check the recovered
    // transcript (the conversation window may not reach the first turn's
    // rows after two crash generations of the runtime).
    await expect.poll(() => bodyText().then(text => !text.includes('Loading history…')), { timeout: 60_000 }).toBe(true)
    const body = await bodyText()
    expect(body).toContain('CRASH_RESUME_DONE')
    // The interrupted tool turn's pinned recovery rendering survived both
    // crash generations.
    expect(body).toContain('interrupted after it was recorded')
    expect(/subagent/.test(body)).toBe(true)
    // The earliest turn's durable prefix and its interrupted end survived
    // both crash generations, with no tail token ever written.
    const records = sessionLogRecords()
    expect(records.some(r => r.type === 'assistant/chunk' && JSON.stringify(r.data).includes('CRASHX_1'))).toBe(true)
    expect(records.some(r => JSON.stringify(r).includes('CRASHX_FINAL'))).toBe(false)
    expect([...turnEndReasons().values()]).toContain('interrupted')
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(sessions.items.some(item => !item.blank)).toBe(true)
    await assertNothingRunning()
    assertNoPageErrors()
  }, 300_000)

  it('quits cleanly while failed without hanging', async () => {
    await killRuntime()
    await awaitState('failed')
    expect((await failureScreenFacts()).hasRestart).toBe(true)
    // before-quit must not attempt a stop on a dead runtime; the app exits.
    await app.close()
  }, 240_000)
})

// ── helpers ──────────────────────────────────────────────────────────────────

function seedWorkspaceRegistry(harnessHome: string, dir: string): void {
  const now = new Date().toISOString()
  const storages = join(harnessHome, 'storages')
  mkdirSync(storages, { recursive: true })
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-crash'], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-crash': { path: dir, title: 'crash-probe', sessionIds: [], createdAt: now, updatedAt: now },
      },
    },
  }
  writeFileSync(join(storages, 'workspace.json'), JSON.stringify(doc, null, 2) + '\n')
}

async function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    args: [appDir, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'keyless-desktop-crash',
      DEEPSEEK_BASE_URL: providerUrl,
    },
  })
}
