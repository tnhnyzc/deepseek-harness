/**
 * Stage 6 parity: the pinned DSH web UI, running in the desktop shell over
 * the desktop transport, behaves like `dsh web` for the normal user
 * workflow. Real Electron + real desktop-runtime + real pinned DSH
 * composition + real client tree; the only non-real element is a scripted
 * deterministic LLM provider on loopback HTTP, reached through the pinned
 * DeepSeek provider's `DEEPSEEK_BASE_URL` seam — the same keyless seam the
 * web lane's real-host e2e uses. The OS directory dialog is the one surface
 * that cannot be driven here; workspace selection is proven through the
 * seeded-registry + startup auto-selection path, and the dialog itself is
 * covered by the manual smoke.
 * Self-skips without a built app or a GUI session.
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

/** One scripted provider step: paced text chunks or a single tool call. */
type TurnStep =
  | { kind: 'text'; chunks: [text: string, delayMs: number][]; finish: boolean }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }

/** Per-turn scripts keyed by the marker the test puts in the prompt text. */
const TURNS: Record<string, TurnStep[]> = {
  'parity turn a': [
    { kind: 'text', chunks: [['STREAM_A_PARTIAL_', 250], ['STREAM_A_DONE', 250]], finish: true },
  ],
  'parity turn b': [
    { kind: 'tool', name: 'bash', args: { command: 'echo parity-b > b-out.txt', description: 'write the parity b file' } },
    { kind: 'text', chunks: [['TOOL_B_DONE', 100]], finish: true },
  ],
  'parity turn c': [
    { kind: 'tool', name: 'bash', args: { command: 'echo parity-c > c-out.txt', description: 'write the parity c file' } },
    {
      kind: 'tool', name: 'bash',
      args: {
        command: 'echo parity-c > c-out.txt', description: 'write the parity c file',
        sandbox_permissions: 'workspace-write', justification: 'the read-only sandbox refused the write this task needs',
      },
    },
    { kind: 'text', chunks: [['APPROVAL_C_DONE', 100]], finish: true },
  ],
  'parity turn d': [
    { kind: 'tool', name: 'bash', args: { command: 'echo parity-d > d-out.txt', description: 'write the parity d file' } },
    {
      kind: 'tool', name: 'bash',
      args: {
        command: 'echo parity-d > d-out.txt', description: 'write the parity d file',
        sandbox_permissions: 'workspace-write', justification: 'the read-only sandbox refused the write this task needs',
      },
    },
    { kind: 'text', chunks: [['APPROVAL_D_DENIED', 100]], finish: true },
  ],
  'parity turn e': [
    {
      kind: 'tool', name: 'ask_user_question',
      args: {
        questions: [{
          id: 'color', question: 'Pick a color for the parity probe.', header: 'Color',
          options: [{ label: 'Blue' }, { label: 'Green' }],
        }],
      },
    },
    { kind: 'text', chunks: [['QUESTION_E_DONE', 100]], finish: true },
  ],
  'parity turn f': [
    {
      kind: 'text',
      chunks: [
        ['CANCEL_CHUNK_1', 400], ['CANCEL_CHUNK_2', 400], ['CANCEL_CHUNK_3', 400], ['CANCEL_CHUNK_4', 400],
        ['CANCEL_CHUNK_5', 400], ['CANCEL_CHUNK_6', 400], ['CANCEL_CHUNK_7', 400], ['CANCEL_CHUNK_8', 400],
      ],
      finish: true,
    },
  ],
}

const TITLE_TEXT = 'Parity probe title'
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
        tool_calls: [{ index: 0, id: `call_parity_${toolCallCounter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
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
      try { parsed = JSON.parse(body) as { max_tokens?: unknown } } catch { /* non-JSON probes get the title stream */ }
      if (parsed.max_tokens === 64) {
        response.end(sse(`{"choices":[{"delta":{"content":"${TITLE_TEXT}"}}]}`) + sseStop())
        return
      }
      const { marker, step } = route(body)
      const steps = marker !== undefined ? TURNS[marker] : undefined
      const current = steps?.[step]
      if (current === undefined) {
        // Outside the script (stray or replanned request): finish with text.
        response.end(sse('{"choices":[{"delta":{"content":"parity idle"}}]}') + sseStop())
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
      body: JSON.stringify({ type: 'client-request', rpcId: `parity-${m}`, method: m, payload: p }),
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
  /** Projection baseline for the row (the cold list's title hint). */
  projections?: { asOfSeq: number; values: Record<string, unknown> }
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
      if (checksum && buffer.length - offset < 4) complete = false
      else if (checksum) offset += 4
    }
    if (!complete || offset <= start) break
    frames.push({ start, end: offset })
  }
  return frames
    .map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    .join('')
}

/** The session/title rows currently durable in the on-disk JSONL logs. */
function sessionLogTitles(): Record<string, { seq: number; title: unknown; source: unknown }[]> {
  const logs: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd') logs.push(path)
    }
  }
  walk(home)
  const out: Record<string, { seq: number; title: unknown; source: unknown }[]> = {}
  for (const file of logs) {
    const text = decodeSessionArtifact(file)
    out[file] = text.split('\n').filter(Boolean).map((line) => {
      try {
        const record = JSON.parse(line) as { type?: unknown; seq?: unknown; data?: { title?: unknown; source?: { kind?: unknown } } }
        return record.type === 'session/title'
          ? { seq: Number(record.seq), title: record.data?.title, source: record.data?.source?.kind }
          : null
      } catch {
        return null
      }
    }).filter((row): row is { seq: number; title: unknown; source: unknown } => row !== null)
  }
  return out
}

/** Poll until the write-behind has durably written the title row. */
async function awaitDurableTitle(title: string, source: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const rows of Object.values(sessionLogTitles())) {
      if (rows.some(row => row.title === title && row.source === source)) return
    }
    if (Date.now() > deadline) break
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  throw new Error(`title row "${title}" (source ${source}) never durable; on-disk rows: ${JSON.stringify(sessionLogTitles())}`)
}

/** The conversation composer is live when its textarea is writable. */
function composerEditable(): Promise<boolean> {
  return win.evaluate(() => {
    const el = document.querySelector('[data-composer-card] textarea') as HTMLTextAreaElement | null
    return el !== null && !el.readOnly
  })
}

/** The session tree lives in the sidebar, which a fresh profile opens collapsed. */
async function openSidebar(): Promise<void> {
  const toggle = win.getByRole('button', { name: 'Open sidebar' })
  if (await toggle.count() > 0) {
    await toggle.first().click()
    await win.locator('[role="treeitem"]').first().waitFor({ timeout: 15_000 })
  }
}

function assertCleanConsole(): void {
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
}

describe.skipIf(!guiAvailable() || !runtimeBuilt)('desktop DSH web parity', () => {
  beforeAll(async () => {
    provider = createServer(handleProviderRequest)
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as AddressInfo
    providerUrl = `http://127.0.0.1:${address.port}`
    work = mkdtempSync(join(tmpdir(), 'dsh-desktop-parity-'))
    userData = join(work, 'user-data')
    home = join(userData, 'harness')
    mkdirSync(join(work, 'parity-ws'), { recursive: true })
    workspaceDir = realpathSync(join(work, 'parity-ws'))
    seedWorkspaceRegistry(home, workspaceDir)
    app = await launchApp()
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (error) => { pageErrors.push(error.message) })
    win.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await win.waitForFunction(() => {
      const state = document.getElementById('root')?.dataset.state
      return state === 'ready' || state === 'failed'
    }, undefined, { timeout: 120_000 })
    expect(await win.evaluate(() => document.getElementById('root')?.dataset.state)).toBe('ready')
    // The pinned UI's product-wide first-run notice renders shortly after
    // boot (it follows the settings scope, not the ready signal): wait for
    // it and acknowledge it through its own button, exactly as a first-run
    // user would. Its backdrop mask would intercept every later click.
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

  it('lists the seeded workspace with its blank session and an unlocked composer', async () => {
    await win.waitForFunction(() => {
      const globals = globalThis as { __DSH_BOOT__?: unknown }
      return globals.__DSH_BOOT__ !== undefined && document.querySelector('.shell-state') === null
    }, undefined, { timeout: 30_000 })
    // The client's startup auto-selection connects the most recent workspace
    // and opens its blank session once the baselines are in; the unlocked
    // composer is the terminal state of that user-visible path.
    await expect.poll(composerEditable, { timeout: 60_000 }).toBe(true)
    const workspaces = await rpc<{ items: { workspaceId: string; title: string; path: string }[] }>('workspace.list', {})
    expect(workspaces.items.map(item => item.title)).toEqual(['parity-probe'])
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(sessions.items).toHaveLength(1)
    expect(sessions.items[0]?.blank).toBe(true)
    expect(sessions.items[0]?.running).toBe(false)
    assertCleanConsole()
  }, 90_000)

  it('streams an assistant reply incrementally', async () => {
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('parity turn a')
    await composer.press('Enter')
    // Incremental streaming: the partial text must paint BEFORE the final text.
    await win.waitForFunction(
      () => {
        const text = document.body.innerText
        return text.includes('STREAM_A_PARTIAL_') && !text.includes('STREAM_A_DONE')
      },
      undefined,
      { timeout: 30_000, polling: 50 },
    )
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('STREAM_A_DONE')), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('parity turn a')), { timeout: 10_000 }).toBe(true)
    assertCleanConsole()
  }, 90_000)

  it('renders the bash tool call and result in the conversation and trajectory', async () => {
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('parity turn b')
    await composer.press('Enter')
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('TOOL_B_DONE')), { timeout: 60_000 }).toBe(true)
    // The collapsed tool card shows the tool and its description; opening
    // the row reveals the command it ran.
    const toolRow = win.locator('[data-chat-flow-key]').filter({ hasText: 'write the parity b file' }).first()
    await expect.poll(async () => toolRow.count(), { timeout: 15_000 }).toBe(1)
    await toolRow.click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('b-out.txt')), { timeout: 15_000 }).toBe(true)
    // The trajectory view carries the same round.
    await win.getByRole('tab', { name: 'Trajectory' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('b-out.txt')), { timeout: 15_000 }).toBe(true)
    await win.getByRole('tab', { name: 'Chat' }).click()
    assertCleanConsole()
  }, 120_000)

  it('asks for approval on a sandbox escalation and runs it after Allow once', async () => {
    await switchAccessMode('Read Only')
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('parity turn c')
    await composer.press('Enter')
    const panel = win.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    await panel.getByRole('button', { name: 'Allow once' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('APPROVAL_C_DONE')), { timeout: 60_000 }).toBe(true)
    expect(await panel.count()).toBe(0)
    // World state: the granted escalation is what let the write run.
    expect(readFileSync(join(workspaceDir, 'c-out.txt'), 'utf8')).toContain('parity-c')
    assertCleanConsole()
  }, 180_000)

  it('rejects the escalation on Reject and does not run the command', async () => {
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('parity turn d')
    await composer.press('Enter')
    const panel = win.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    await panel.getByRole('button', { name: 'Reject' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('APPROVAL_D_DENIED')), { timeout: 60_000 }).toBe(true)
    expect(await panel.count()).toBe(0)
    expect(existsSync(join(workspaceDir, 'd-out.txt'))).toBe(false)
    assertCleanConsole()
  }, 180_000)

  it('answers an ask_user_question through the question composer', async () => {
    await switchAccessMode('Workspace Write')
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('parity turn e')
    await composer.press('Enter')
    const question = win.locator('[data-question-key]')
    await question.waitFor({ timeout: 60_000 })
    await expect.poll(() => question.getByText('Pick a color for the parity probe.').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await question.getByRole('radio', { name: /Blue/ }).click()
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('QUESTION_E_DONE')), { timeout: 60_000 }).toBe(true)
    expect(await question.count()).toBe(0)
    assertCleanConsole()
  }, 180_000)

  it('cancels a running turn with Stop generating', async () => {
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('parity turn f')
    await composer.press('Enter')
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('CANCEL_CHUNK_1')), { timeout: 30_000 }).toBe(true)
    const stop = win.getByRole('button', { name: 'Stop generating' })
    await stop.click({ timeout: 10_000 })
    await expect.poll(async () => stop.count(), { timeout: 30_000 }).toBe(0)
    await expect.poll(composerEditable, { timeout: 30_000 }).toBe(true)
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(sessions.items.every(item => !item.running)).toBe(true)
    assertCleanConsole()
  }, 120_000)

  it('renames the session from the row menu', async () => {
    await openSidebar()
    // The row's action cell is display:none until the row is hovered; the
    // session row is identified by the direct child that carries its menu
    // button (the workspace group row only contains it as a descendant).
    const row = win.locator(`[role="treeitem"]:has(> span:has(button[aria-label="Session actions for ${TITLE_TEXT}"]))`)
    await row.first().waitFor({ timeout: 30_000 })
    await row.first().hover()
    await row.locator('button[aria-label^="Session actions for"]').first().click()
    await win.getByRole('menuitem', { name: 'Rename' }).click()
    const dialog = win.getByRole('dialog')
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.locator('input[aria-label="Session name"]').fill('Parity renamed')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await win.locator('[role="treeitem"]').filter({ hasText: 'Parity renamed' }).first().waitFor({ timeout: 15_000 })
    // Durability: the user rename must reach the session log on disk.
    await awaitDurableTitle('Parity renamed', 'user', 10_000)
    assertCleanConsole()
  }, 90_000)

  it('creates a second session with New session', async () => {
    await win.getByRole('button', { name: 'New session' }).first().click()
    await expect.poll(async () => (await rpc<{ items: SessionSummary[] }>('session.list', {})).items.length, { timeout: 15_000 }).toBe(2)
    // The new blank session is open with a live composer.
    await expect.poll(composerEditable, { timeout: 15_000 }).toBe(true)
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(sessions.items.filter(item => item.blank).length).toBeGreaterThanOrEqual(1)
    assertCleanConsole()
  }, 90_000)

  it('shows the provider and model settings', async () => {
    // The Settings trigger sits in the sidebar foot.
    await openSidebar()
    await win.getByRole('button', { name: 'Settings' }).first().click()
    await win.getByRole('tab', { name: 'Models' }).or(win.getByRole('button', { name: 'Models', exact: true })).first().click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('DeepSeek')), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('Add provider')), { timeout: 10_000 }).toBe(true)
    await win.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
    // The composer's model seat shows the live session model.
    await expect.poll(async () =>
      (await win.locator('button[aria-label^="Select model, current DeepSeek-V4-Flash"]').count()) > 0, { timeout: 15_000 }).toBe(true)
    assertCleanConsole()
  }, 90_000)

  it('recovers both sessions after a clean restart', async () => {
    await app.close()
    app = await launchApp()
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    // Scope the console gate to the restarted app (the first launch was
    // already asserted clean by the earlier tests).
    pageErrors.length = 0
    consoleErrors.length = 0
    win.on('pageerror', (error) => { pageErrors.push(error.message) })
    win.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await win.waitForFunction(() => {
      const state = document.getElementById('root')?.dataset.state
      return state === 'ready' || state === 'failed'
    }, undefined, { timeout: 120_000 })
    expect(await win.evaluate(() => document.getElementById('root')?.dataset.state)).toBe('ready')
    // Auto-selection restores the workspace and reopens its (reused) blank
    // session before the welcome question is meaningful.
    await expect.poll(composerEditable, { timeout: 60_000 }).toBe(true)
    // The welcome acknowledgement persisted: no first-run notice on relaunch.
    expect(await win.getByRole('button', { name: 'Continue' }).count()).toBe(0)
    await expect.poll(async () => (await rpc<{ items: SessionSummary[] }>('session.list', {})).items.length, { timeout: 30_000 }).toBe(2)
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(sessions.items.every(item => !item.running)).toBe(true)
    // The cold list reads the title from the persisted projection cache: the
    // projection cache's disposal drain durably checkpointed the rename during
    // the clean shutdown above, so the latest title shows without opening the
    // session (a rename after the last checkpoint must not stay invisible).
    expect(sessions.items.some(item => item.projections?.values.title === 'Parity renamed')).toBe(true)
    // The session that carried the turns reopens with its rendered history.
    // Only a non-blank session row carries its row-menu button, which names the
    // durable row (the blank sibling renders a New Session placeholder).
    await openSidebar()
    const sessionRow = win.locator('[role="treeitem"]').filter({ has: win.locator('button[aria-label^="Session actions for"]') }).first()
    await sessionRow.waitFor({ timeout: 15_000 })
    await sessionRow.click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('QUESTION_E_DONE')), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('TOOL_B_DONE')), { timeout: 15_000 }).toBe(true)
    // The durable user rename is reflected once the session's log is replayed
    // on open.
    await expect.poll(async () => (await sessionRow.innerText()).split('\n')[0], { timeout: 15_000 }).toBe('Parity renamed')
    // Durability: the user rename is the durable title in the log.
    const postRestartTitles = Object.values(sessionLogTitles()).flat()
    expect(postRestartTitles.some(row => row.title === 'Parity renamed' && row.source === 'user')).toBe(true)
    // Console: the restarted client's first inspect-manifest sync waits for the
    // Connection readiness seam, so cold boot must come up clean.
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  }, 240_000)
})

// ── helpers ──────────────────────────────────────────────────────────────────

function seedWorkspaceRegistry(harnessHome: string, dir: string): void {
  const now = new Date().toISOString()
  const storages = join(harnessHome, 'storages')
  mkdirSync(storages, { recursive: true })
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-parity'], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-parity': { path: dir, title: 'parity-probe', sessionIds: [], createdAt: now, updatedAt: now },
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
      DEEPSEEK_API_KEY: 'keyless-desktop-parity',
      DEEPSEEK_BASE_URL: providerUrl,
    },
  })
}

async function switchAccessMode(mode: 'Read Only' | 'Workspace Write'): Promise<void> {
  await win.locator('button[aria-label^="Access mode"]').click()
  await win.getByRole('menuitem', { name: mode }).click()
  await expect.poll(async () =>
    (await win.locator(`button[aria-label="Access mode, current: ${mode}"]`).count()) > 0, { timeout: 15_000 }).toBe(true)
}
