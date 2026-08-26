/**
 * Stage 8 session and event correctness (SPEC §22): the event-log guarantees
 * the parity workflow does not pin — exact event accounting and ordering for
 * a burst turn (no loss, duplication, reordering, or coalescing of
 * semantically separate events), a cancelled run terminating streaming with
 * the transcript and the durable log in exact agreement, a pending approval
 * and a pending question surviving a renderer reload and staying answerable,
 * and a renderer reload mid-stream folding the durable log exactly (no event
 * disappears between the history fetch and the live subscription, nothing is
 * synthesized). Real Electron + real desktop-runtime + real pinned DSH
 * composition; the only non-real element is the scripted deterministic LLM
 * provider on the `DEEPSEEK_BASE_URL` seam, as in the stage 6 parity suite.
 * Self-skips without built artifacts or a GUI session.
 */
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
  // Text then a tool call in ONE model response (the only way the agent loop
  // interleaves them): the content deltas and the tool call are one step.
  | { kind: 'text-tool'; chunks: [text: string, delayMs: number][]; tool: { name: string; args: Record<string, unknown> } }

/** Per-turn scripts keyed by the marker the test puts in the prompt text. */
const TURNS: Record<string, TurnStep[]> = {
  // A burst: two text messages interleaved with two tool rounds — the
  // separate text messages must stay separate, in order, around the tools.
  'correct burst': [
    {
      kind: 'text-tool',
      chunks: [['BURST_A1_', 200], ['BURST_A2', 200]],
      tool: { name: 'bash', args: { command: 'echo burst-one > burst1.txt', description: 'write the burst file one' } },
    },
    {
      kind: 'text-tool',
      chunks: [['BURST_B1_', 100], ['BURST_B2', 100]],
      tool: { name: 'bash', args: { command: 'echo burst-two > burst2.txt', description: 'write the burst file two' } },
    },
    { kind: 'text', chunks: [['BURST_C1', 100]], finish: true },
  ],
  // A long stream for the cancel and the reload-mid-stream scenarios: a
  // distinctive final chunk lets the tests prove nothing lands after the cut.
  'correct cancel': [
    {
      kind: 'text',
      chunks: [
        ['CANCELX_1', 300], ['CANCELX_2', 300], ['CANCELX_3', 300], ['CANCELX_4', 300],
        ['CANCELX_5', 300], ['CANCELX_6', 300], ['CANCELX_7', 300], ['CANCELX_8', 300],
      ],
      finish: true,
    },
  ],
  'correct reload-stream': [
    {
      kind: 'text',
      chunks: [
        ['RELOADX_1', 400], ['RELOADX_2', 400], ['RELOADX_3', 400], ['RELOADX_4', 400],
        ['RELOADX_5', 400], ['RELOADX_6', 400], ['RELOADX_7', 400], ['RELOADX_FINAL', 400],
      ],
      finish: true,
    },
  ],
  'correct approval-reload': [
    {
      kind: 'tool', name: 'bash',
      args: {
        command: 'echo approval-reload > ar-out.txt', description: 'write the approval reload file',
        sandbox_permissions: 'workspace-write', justification: 'the read-only sandbox refused the write this task needs',
      },
    },
    { kind: 'text', chunks: [['APPROVAL_RELOAD_DONE', 100]], finish: true },
  ],
  'correct question-reload': [
    {
      kind: 'tool', name: 'ask_user_question',
      args: {
        questions: [{
          id: 'shape', question: 'Pick a shape for the correctness probe.', header: 'Shape',
          options: [{ label: 'Square' }, { label: 'Circle' }],
        }],
      },
    },
    { kind: 'text', chunks: [['QUESTION_RELOAD_DONE', 100]], finish: true },
  ],
}

let toolCallCounter = 0

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
        tool_calls: [{ index: 0, id: `call_correct_${toolCallCounter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
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
        response.end(sse('{"choices":[{"delta":{"content":"Correctness probe title"}}]}' + sseStop()))
        return
      }
      const { marker, step } = route(body)
      const steps = marker !== undefined ? TURNS[marker] : undefined
      const current = steps?.[step]
      if (current === undefined) {
        // Outside the script (stray or replanned request): finish with text.
        response.end(sse('{"choices":[{"delta":{"content":"correct idle"}}]}') + sseStop())
        return
      }
      if (current.kind === 'tool') {
        response.end(sseToolCall(current.name, current.args))
        return
      }
      if (current.kind === 'text-tool') {
        for (const [text, delayMs] of current.chunks) {
          if (response.destroyed) return
          await new Promise((resolve) => { setTimeout(resolve, delayMs) })
          if (response.destroyed) return
          response.write(sse(`{"choices":[{"delta":{"content":"${text}"}}]}`))
        }
        if (!response.destroyed) response.end(sseToolCall(current.tool.name, current.tool.args))
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
      // A destroyed socket during pacing is the expected cancel outcome.
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
const consoleErrors: string[] = []

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
      body: JSON.stringify({ type: 'client-request', rpcId: `correct-${m}`, method: m, payload: p }),
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

/** Every durable session-log record, in on-disk (seq) order, across all sessions. */
function sessionLogRecords(): Array<{ seq: number; type: string; data: unknown }> {
  const logs: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd') logs.push(path)
    }
  }
  walk(home)
  const records: Array<{ seq: number; type: string; data: unknown }> = []
  for (const file of logs) {
    for (const line of decodeSessionArtifact(file).split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as { seq?: unknown; type?: unknown; data?: unknown }
        if (typeof record.type === 'string' && typeof record.seq === 'number') {
          records.push({ seq: record.seq, type: record.type, data: record.data ?? null })
        }
      } catch { /* a torn trailing line mid-flush is not a record */ }
    }
  }
  return records
}

/**
 * Durable streamed text, counted by exact `text-delta` chunk. The chunk
 * protocol (block-start / text-delta / block-end / usage / finish) repeats a
 * block's full text in its `block-end` record, so a substring count would
 * double-count; only the deltas are the streamed units.
 */
function loggedChunkTokens(tokens: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const token of tokens) counts[token] = 0
  for (const record of sessionLogRecords()) {
    if (record.type !== 'assistant/chunk') continue
    const chunk = (record.data as { chunk?: { type?: unknown; text?: unknown } })?.chunk
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') continue
    const current = counts[chunk.text]
    if (current !== undefined) counts[chunk.text] = current + 1
  }
  return counts
}

/** How often one token occurs in a string (exact-multiplicity probe). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function assertCleanConsole(): void {
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
}

/** The conversation composer is live when its textarea is writable. */
function composerEditable(): Promise<boolean> {
  return win.evaluate(() => {
    const el = document.querySelector('[data-composer-card] textarea') as HTMLTextAreaElement | null
    return el !== null && !el.readOnly
  })
}

/** The conversation rows in DOM (rendering) order. */
function chatFlowRows(): Promise<string[]> {
  return win.evaluate(() =>
    [...document.querySelectorAll('[data-chat-flow-key]')].map(row => row.textContent ?? ''),
  )
}

/** Wait for the pinned client tree to be live on (a reloaded) window. */
async function awaitClientLive(): Promise<void> {
  await win.waitForFunction(() => {
    const state = document.getElementById('root')?.dataset.state
    return (state === 'ready' || state === 'failed') && (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ !== undefined
  }, undefined, { timeout: 120_000 })
  expect(await win.evaluate(() => document.getElementById('root')?.dataset.state)).toBe('ready')
  // expect.poll needs a test context; beforeAll calls this too, so poll plainly.
  const deadline = Date.now() + 60_000
  for (;;) {
    if (await composerEditable()) return
    if (Date.now() > deadline) throw new Error('the composer never became editable after boot/reload')
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

describe.skipIf(!guiAvailable() || !runtimeBuilt)('desktop DSH event correctness (stage 8)', () => {
  beforeAll(async () => {
    provider = createServer(handleProviderRequest)
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as AddressInfo
    providerUrl = `http://127.0.0.1:${address.port}`
    work = mkdtempSync(join(tmpdir(), 'dsh-desktop-correct-'))
    userData = join(work, 'user-data')
    home = join(userData, 'harness')
    mkdirSync(join(work, 'correct-ws'), { recursive: true })
    workspaceDir = realpathSync(join(work, 'correct-ws'))
    seedWorkspaceRegistry(home, workspaceDir)
    app = await launchApp()
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (error) => { pageErrors.push(error.message) })
    win.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await awaitClientLive()
    // The product-wide first-run notice renders shortly after boot and its
    // backdrop mask would intercept every later click; acknowledge it exactly
    // as a first-run user would (the ack is durable, so later reloads are free).
    const continueButton = win.getByRole('button', { name: 'Continue' })
    try {
      await continueButton.waitFor({ state: 'visible', timeout: 60_000 })
      await continueButton.click()
      await continueButton.waitFor({ state: 'detached', timeout: 10_000 })
    } catch {
      // The notice is absent: this home already acknowledged it.
    }
  }, 240_000)

  afterAll(async () => {
    if (app !== undefined) await app.close().catch(() => {})
    await new Promise<void>(resolve => provider?.close(() => { resolve() }))
    rmSync(work, { recursive: true, force: true })
  }, 120_000)

  it('folds a burst turn exactly: order, multiplicity, and no coalescing', async () => {
    await sendPrompt('correct burst')
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('BURST_C1')), { timeout: 90_000 }).toBe(true)
    const rows = await chatFlowRows()
    const joined = rows.join('\u0000')
    // Rendering order: message A, tool one, message B, tool two, message C.
    const iA = joined.indexOf('BURST_A1_')
    const iT1 = joined.indexOf('write the burst file one')
    const iB = joined.indexOf('BURST_B1_')
    const iT2 = joined.indexOf('write the burst file two')
    const iC = joined.indexOf('BURST_C1')
    expect([iA, iT1, iB, iT2, iC].every(index => index !== -1)).toBe(true)
    expect(iA).toBeLessThan(iT1)
    expect(iT1).toBeLessThan(iB)
    expect(iB).toBeLessThan(iT2)
    expect(iT2).toBeLessThan(iC)
    // Each semantically separate event once: the two text messages stay
    // separate rows (not coalesced across the tool rounds), each tool card
    // renders exactly once.
    expect(rows.filter(row => row.includes('BURST_A1_')).length).toBe(1)
    expect(rows.filter(row => row.includes('BURST_B1_')).length).toBe(1)
    expect(rows.filter(row => row.includes('write the burst file one')).length).toBe(1)
    expect(rows.filter(row => row.includes('write the burst file two')).length).toBe(1)
    // No partial-then-final duplication inside the finished messages.
    const body = await win.evaluate(() => document.body.innerText)
    for (const token of ['BURST_A1_', 'BURST_A2', 'BURST_B1_', 'BURST_B2', 'BURST_C1']) {
      expect(countOccurrences(body, token), `token ${token}`).toBe(1)
    }
    // The durable log agrees: every chunk exactly once, in the scripted
    // order, around the two tool rounds, under one turn/end.
    const tokens = ['BURST_A1_', 'BURST_A2', 'BURST_B1_', 'BURST_B2', 'BURST_C1']
    const logged = loggedChunkTokens(tokens)
    for (const token of tokens) expect(logged[token], `logged ${token}`).toBe(1)
    const records = sessionLogRecords()
    const seqOf = (probe: (r: { seq: number; type: string; data: unknown }) => boolean): number =>
      Math.max(-1, ...records.filter(probe).map(r => r.seq))
    const deltaSeq = (token: string): number => seqOf((r) => {
      const chunk = (r.data as { chunk?: { type?: unknown; text?: unknown } })?.chunk
      return r.type === 'assistant/chunk' && chunk?.type === 'text-delta' && chunk.text === token
    })
    const sA1 = deltaSeq('BURST_A1_')
    const sA2 = deltaSeq('BURST_A2')
    const sT1 = seqOf(r => r.type === 'tool/call' && JSON.stringify(r.data).includes('burst file one'))
    const sB1 = deltaSeq('BURST_B1_')
    const sT1r = seqOf(r => r.type === 'tool/result' && r.seq > sT1 && r.seq < sB1)
    const sT2 = seqOf(r => r.type === 'tool/call' && JSON.stringify(r.data).includes('burst file two'))
    const sC1 = deltaSeq('BURST_C1')
    const sEnd = seqOf(r => r.type === 'turn/end')
    expect([sA1, sA2, sT1, sT1r, sB1, sT2, sC1, sEnd].every(s => s !== -1)).toBe(true)
    expect(sA1).toBeLessThan(sA2)
    expect(sA2).toBeLessThan(sT1)
    expect(sT1).toBeLessThan(sT1r)
    expect(sT1r).toBeLessThan(sB1)
    expect(sB1).toBeLessThan(sT2)
    expect(sT2).toBeLessThan(sC1)
    expect(sC1).toBeLessThan(sEnd)
    // Exactly one tool round per call: no duplicated tool events in the log.
    expect(records.filter(r => r.type === 'tool/call' && JSON.stringify(r.data).includes('burst file')).length).toBe(2)
    assertCleanConsole()
  }, 180_000)

  it('terminates a cancelled run with transcript and durable log in exact agreement', async () => {
    const before = new Set(sessionLogRecords().map(r => r.seq))
    await sendPrompt('correct cancel')
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('CANCELX_1')), { timeout: 30_000 }).toBe(true)
    const stop = win.getByRole('button', { name: 'Stop generating' })
    await stop.click({ timeout: 10_000 })
    await expect.poll(async () => stop.count(), { timeout: 30_000 }).toBe(0)
    await expect.poll(composerEditable, { timeout: 30_000 }).toBe(true)
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(sessions.items.every(item => !item.running)).toBe(true)
    // Nothing after the cut: the script's tail never reached the log, and
    // the transcript agrees with the log token for token — the fold neither
    // drops a logged chunk nor renders one the log lacks (and nothing is
    // synthesized to make the interrupted turn look finished).
    const tokens = ['CANCELX_1', 'CANCELX_2', 'CANCELX_3', 'CANCELX_4', 'CANCELX_5', 'CANCELX_6', 'CANCELX_7', 'CANCELX_8']
    const logged = loggedChunkTokens(tokens)
    const body = await win.evaluate(() => document.body.innerText)
    for (const token of tokens) {
      expect(countOccurrences(body, token), `rendered ${token}`).toBe(logged[token])
    }
    expect(logged['CANCELX_8'], 'the tail chunk after the cancel must not be durable').toBe(0)
    expect(body.includes('CANCELX_8')).toBe(false)
    // The turn still ended: a durable terminal exists after the cut.
    const after = sessionLogRecords().filter(r => !before.has(r.seq))
    expect(after.some(r => r.type === 'turn/end')).toBe(true)
    assertCleanConsole()
  }, 180_000)

  it('survives a renderer reload mid-stream and folds the durable log exactly', async () => {
    const before = new Set(sessionLogRecords().map(r => r.seq))
    await sendPrompt('correct reload-stream')
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('RELOADX_1')), { timeout: 30_000 }).toBe(true)
    // Mid-stream: a few chunks are in flight when the renderer goes away —
    // the window between the old subscription dying and the new history
    // fetch plus subscription re-arming is where a dropped event would
    // vanish. The reload detaches the client but does not cancel the run:
    // the turn keeps executing in the runtime and completes, so every
    // chunk — including ones emitted after the detach — must be durable
    // exactly once and folded by the reconnected client.
    await new Promise((resolve) => { setTimeout(resolve, 900) })
    await win.reload()
    await awaitClientLive()
    await expect.poll(async () => {
      const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
      return sessions.items.every(item => !item.running)
    }, { timeout: 60_000 }).toBe(true)
    await openTurnSession()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('RELOADX_FINAL')), { timeout: 30_000 }).toBe(true)
    const tokens = ['RELOADX_1', 'RELOADX_2', 'RELOADX_3', 'RELOADX_4', 'RELOADX_5', 'RELOADX_6', 'RELOADX_7', 'RELOADX_FINAL']
    const logged = loggedChunkTokens(tokens)
    for (const token of tokens) expect(logged[token], `logged ${token}`).toBe(1)
    const body = await win.evaluate(() => document.body.innerText)
    for (const token of tokens) {
      expect(countOccurrences(body, token), `rendered ${token}`).toBe(1)
    }
    // The fold is lossless end to end: the final message carries the full
    // concatenated text in order.
    const records = sessionLogRecords()
    const finalMessage = records.filter(r => r.type === 'assistant/message' && JSON.stringify(r.data).includes('RELOADX_FINAL')).at(-1)
    expect(JSON.stringify(finalMessage?.data)).toContain('RELOADX_1RELOADX_2RELOADX_3RELOADX_4RELOADX_5RELOADX_6RELOADX_7RELOADX_FINAL')
    // The turn completed — the reload must not leave it stuck or aborted.
    const after = records.filter(r => !before.has(r.seq))
    expect(JSON.stringify(after.filter(r => r.type === 'turn/end').at(-1)?.data)).toContain('"completed"')
    // Every new durable record is one this scenario can explain: no event
    // type a mid-stream reload cannot produce appears in the gap. (Each
    // prompt is spliced into the next-turn inbox and removed again at turn
    // start, so the splices of this turn's own prompt are expected.)
    for (const r of after) {
      expect(['user/message', 'assistant/chunk', 'assistant/message', 'turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'request/context', 'session/title', 'session/title-llm-request', 'agent/inbox/spliced'], `unexpected gap event ${r.type}`).toContain(r.type)
    }
    assertCleanConsole()
  }, 300_000)

  it('keeps a pending approval alive across a renderer reload and answers it', async () => {
    await switchAccessMode('Read Only')
    await sendPrompt('correct approval-reload')
    const panel = win.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    // The pending interaction is runtime state, not renderer state: the
    // reload must not lose it or cancel the waiting turn.
    await win.reload()
    await awaitClientLive()
    await openTurnSession()
    const reloadedPanel = win.locator('[data-approval-key]')
    await reloadedPanel.waitFor({ timeout: 60_000 })
    await reloadedPanel.getByRole('button', { name: 'Allow once' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('APPROVAL_RELOAD_DONE')), { timeout: 60_000 }).toBe(true)
    expect(await reloadedPanel.count()).toBe(0)
    expect(readFileSync(join(workspaceDir, 'ar-out.txt'), 'utf8')).toContain('approval-reload')
    // The answer is durable: the ask and the decision are logged, linked to
    // the escalated tool call, not just rendered.
    const records = sessionLogRecords()
    const call = records.find(r => r.type === 'tool/call' && JSON.stringify(r.data).includes('approval reload file'))
    expect(call, 'the escalated bash call must be logged').toBeDefined()
    if (call === undefined) throw new Error('the escalated bash call must be logged')
    const callId = (call.data as { callId?: unknown }).callId
    const asked = records.find(r => r.type === 'approval/asked' && (r.data as { callId?: unknown }).callId === callId && r.seq > call.seq)
    expect(asked, 'the escalated call must have a logged approval/asked').toBeDefined()
    if (asked === undefined) throw new Error('the escalated call must have a logged approval/asked')
    const askedId = (asked.data as { id?: unknown }).id
    expect(records.some(r => r.type === 'approval/decided' && (r.data as { id?: unknown }).id === askedId && r.seq > asked.seq), 'the decision must be logged after the ask').toBe(true)
    assertCleanConsole()
  }, 240_000)

  it('keeps a pending question alive across a renderer reload and answers it', async () => {
    await switchAccessMode('Workspace Write')
    await sendPrompt('correct question-reload')
    const question = win.locator('[data-question-key]')
    await question.waitFor({ timeout: 60_000 })
    await win.reload()
    await awaitClientLive()
    await openTurnSession()
    const reloadedQuestion = win.locator('[data-question-key]')
    await reloadedQuestion.waitFor({ timeout: 60_000 })
    await expect.poll(() => reloadedQuestion.getByText('Pick a shape for the correctness probe.').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await reloadedQuestion.getByRole('radio', { name: /Square/ }).click()
    await reloadedQuestion.getByRole('button', { name: 'Submit' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('QUESTION_RELOAD_DONE')), { timeout: 60_000 }).toBe(true)
    expect(await reloadedQuestion.count()).toBe(0)
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(sessions.items.every(item => !item.running)).toBe(true)
    assertCleanConsole()
  }, 240_000)
})

// ── helpers ──────────────────────────────────────────────────────────────────

function seedWorkspaceRegistry(harnessHome: string, dir: string): void {
  const now = new Date().toISOString()
  const storages = join(harnessHome, 'storages')
  mkdirSync(storages, { recursive: true })
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-correct'], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-correct': { path: dir, title: 'correct-probe', sessionIds: [], createdAt: now, updatedAt: now },
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
      DEEPSEEK_API_KEY: 'keyless-desktop-correct',
      DEEPSEEK_BASE_URL: providerUrl,
    },
  })
}
