/**
 * Stage 10 correction — the pinned DSH clipboard write under the desktop
 * permission policy. Real Electron + real desktop-runtime + real pinned DSH
 * composition: the stage 10 default-deny permission policy once broke every
 * Copy affordance, because the pinned helper
 * (`packages/client/ui-primitives/src/clipboard.ts`) prefers
 * `navigator.clipboard.writeText` and reports failure when the browser
 * declines — and Electron 43 routes that call to the session's permission
 * REQUEST handler with `clipboard-sanitized-write` (deterministic probe on
 * the `dsh-app://127.0.0.1` origin: no handler → the write lands; default
 * deny → NotAllowedError; the exact allowlist → the write lands). This suite
 * is the standing integration proof: a real code-block Copy in the built app
 * puts the exact block text on the macOS pasteboard through the policy's
 * single exception.
 * Self-skips without built artifacts, a GUI session, or the macOS
 * pasteboard (`pbcopy`/`pbpaste`).
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const pasteboardAvailable = process.platform === 'darwin'

// The exact text the code block carries; the assertion compares the
// pasteboard against what the block's own <pre> holds.
const CANARY = 'dsh-clipboard-canary-9f3c-42'

// ── scripted deterministic provider (one text turn with a code fence) ──────

const TURN_TEXT = `Here is the clipboard canary for the desktop correction.

\`\`\`text
${CANARY}
\`\`\``

function sse(data: string): string { return `data: ${data}\n\n` }
function sseStop(): string {
  return sse('{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}') + sse('[DONE]')
}

function handleProviderRequest(request: IncomingMessage, response: ServerResponse): void {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => { body += chunk })
  request.on('end', () => {
    try {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let parsed: { max_tokens?: unknown } = {}
      try { parsed = JSON.parse(body) as { max_tokens?: unknown } } catch { /* non-JSON probes get the idle stream */ }
      if (parsed.max_tokens === 64) {
        response.end(sse('{"choices":[{"delta":{"content":"Clipboard canary title"}}]}') + sseStop())
        return
      }
      const isCanaryTurn = body.includes('clipboard canary copy')
      response.end(
        sse(JSON.stringify({ choices: [{ delta: { content: isCanaryTurn ? TURN_TEXT : 'clipboard idle' } }] }))
        + sseStop(),
      )
    } catch {
      if (!response.destroyed) {
        try { response.end() } catch { /* already destroyed */ }
      }
    }
  })
}

// ── macOS pasteboard ───────────────────────────────────────────────────────

function readPasteboard(): string {
  return execSync('pbpaste', { encoding: 'utf8' })
}
function writePasteboard(text: string): void {
  execSync('pbcopy', { input: text })
}

// ── world ──────────────────────────────────────────────────────────────────

let provider: ReturnType<typeof createServer>
let providerUrl: string
let work: string
let userData: string
let home: string
let workspaceDir: string
let app: ElectronApplication
let win: Page
let originalPasteboard: string | undefined

/** Wait for the pinned client tree to be live and the composer writable. */
async function awaitClientLive(): Promise<void> {
  await win.waitForFunction(() => {
    const state = document.getElementById('root')?.dataset.state
    return (state === 'ready' || state === 'failed') && (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ !== undefined
  }, undefined, { timeout: 120_000 })
  expect(await win.evaluate(() => document.getElementById('root')?.dataset.state)).toBe('ready')
  const deadline = Date.now() + 60_000
  for (;;) {
    const editable = await win.evaluate(() => {
      const el = document.querySelector('[data-composer-card] textarea') as HTMLTextAreaElement | null
      return el !== null && !el.readOnly
    })
    if (editable) return
    if (Date.now() > deadline) throw new Error('the composer never became editable after boot')
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
}

/** Seed the workspace registry the fresh profile starts without. */
function seedWorkspaceRegistry(harnessHome: string, dir: string): void {
  const now = new Date().toISOString()
  const storages = join(harnessHome, 'storages')
  mkdirSync(storages, { recursive: true })
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-clipboard'], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-clipboard': { path: dir, title: 'clipboard-probe', sessionIds: [], createdAt: now, updatedAt: now },
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
      DEEPSEEK_API_KEY: 'keyless-desktop-clipboard',
      DEEPSEEK_BASE_URL: providerUrl,
    },
  })
}

describe.skipIf(!guiAvailable() || !runtimeBuilt || !pasteboardAvailable)('desktop DSH clipboard (stage 10 correction)', () => {
  beforeAll(async () => {
    originalPasteboard = readPasteboard()
    provider = createServer(handleProviderRequest)
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as AddressInfo
    providerUrl = `http://127.0.0.1:${address.port}`
    work = mkdtempSync(join(tmpdir(), 'dsh-desktop-clipboard-'))
    userData = join(work, 'user-data')
    home = join(userData, 'harness')
    mkdirSync(join(work, 'clipboard-ws'), { recursive: true })
    workspaceDir = realpathSync(join(work, 'clipboard-ws'))
    seedWorkspaceRegistry(home, workspaceDir)
    app = await launchApp()
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await awaitClientLive()
    // The first-run notice backdrop would intercept clicks; acknowledge it
    // exactly as a first-run user would (the ack is durable).
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
    if (originalPasteboard !== undefined) writePasteboard(originalPasteboard)
    if (app !== undefined) await app.close().catch(() => {})
    await new Promise<void>(resolve => provider?.close(() => { resolve() }))
    rmSync(work, { recursive: true, force: true })
  }, 120_000)

  it('copies a code block through the real DSH helper onto the macOS pasteboard', async () => {
    // 1. One scripted turn whose assistant reply carries the canary in a
    // code fence — the real assistant-message rendering path.
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('clipboard canary copy')
    await composer.press('Enter')
    const block = win.locator('.md-code-block').filter({ hasText: CANARY }).first()
    await block.waitFor({ timeout: 90_000 })

    // 2. Isolate the pasteboard: sentinel in, original restored in afterAll.
    const sentinel = `clipboard-sentinel-${Date.now()}`
    writePasteboard(sentinel)
    expect(readPasteboard().trimEnd()).toBe(sentinel)

    // 3. The text the block's own copy handler will write (its <pre>), so
    // the assertion compares pasteboard against the exact source text.
    const copiedText = await block.locator('pre').first().evaluate(el => el.textContent)
    expect(copiedText?.trimEnd()).toBe(CANARY)

    // 4. The real affordance: the block banner's Copy button. A refused
    // write leaves the pinned helper's success feedback absent.
    const copyButton = block.locator('button').first()
    const idleLabel = await copyButton.textContent()
    await copyButton.click()
    await expect.poll(async () => (await copyButton.textContent()) !== idleLabel, { timeout: 10_000 }).toBe(true)

    // 5. The browser accepted the write: the pasteboard holds the exact
    // block text — through the policy's single clipboard-write exception.
    await expect.poll(async () => readPasteboard().trimEnd(), { timeout: 10_000 }).toBe(copiedText.trimEnd())
  }, 180_000)
})
