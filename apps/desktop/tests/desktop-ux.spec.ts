/**
 * Stage 7 desktop UX: the native window sizing, the live application menu,
 * and the closed command bridge end to end. Real Electron + real
 * desktop-runtime + real pinned DSH client: menu clicks and the platform
 * accelerator are exercised through the live native menu, every UX item is
 * proven to dispatch the existing DSH client action it names (a new blank
 * session, the add-workspace directory flow into the patched OS dialog,
 * the composer's stop, the row's rename dialog, the settings panel, the
 * sidebar fold), and out-of-vocabulary bridge payloads are refused by the
 * preload. The only non-real elements are the scripted deterministic LLM
 * provider (the parity seam) and the patched directory dialog.
 * Self-skips without a built app or a GUI session.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { _electron as electron } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DESKTOP_APP_NAME } from '../src/main/menu.ts'

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

// ── scripted deterministic provider (the parity seam, stage 7 cut) ──────────

type TurnStep = { kind: 'text'; chunks: [text: string, delayMs: number][]; finish: boolean }

/** Per-turn scripts keyed by the marker the test puts in the prompt text. */
const TURNS: Record<string, TurnStep[]> = {
  // Eight paced chunks keep the run long enough for the menu's cancel to land mid-stream.
  'ux cancel': [
    { kind: 'text', chunks: [['UXX_A', 350], ['UXX_B', 350], ['UXX_C', 350], ['UXX_D', 350], ['UXX_E', 350], ['UXX_F', 350], ['UXX_G', 350], ['UXX_H', 350]], finish: true },
  ],
  'ux done': [
    { kind: 'text', chunks: [['UX_DONE', 100]], finish: true },
  ],
}

const TITLE_TEXT = 'UX probe title'

function sse(data: string): string { return `data: ${data}\n\n` }
function sseStop(): string {
  return sse('{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}') + sse('[DONE]')
}

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
      const current = marker !== undefined ? TURNS[marker]?.[step] : undefined
      if (current === undefined) {
        response.end(sse('{"choices":[{"delta":{"content":"ux idle"}}]}') + sseStop())
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
      body: JSON.stringify({ type: 'client-request', rpcId: `ux-${m}`, method: m, payload: p }),
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
}

async function sessionCount(): Promise<number> {
  const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
  return sessions.items.length
}

async function sendCommand(command: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('desktop ux test: no window')
    win.webContents.send('dsh-desktop:command', payload)
  }, command)
}

/** One node of the live menu dump. */
interface MenuNode {
  label: string
  role?: string | undefined
  accelerator?: string | null
  enabled: boolean
  children: MenuNode[]
}

/** Dump the live native menu as a plain structure the test can assert on. */
async function menuDump(): Promise<MenuNode[] | null> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    if (menu === null) return null
    const walk = (items: Electron.MenuItem[]): MenuNode[] =>
      items.map(item => ({
        label: item.label,
        role: item.role,
        accelerator: item.accelerator,
        enabled: item.enabled,
        children: item.submenu === null || item.submenu === undefined ? [] : walk(item.submenu.items),
      }))
    return walk(menu.items)
  })
}

/** Click a native menu item by its top-down label path in the main process. */
async function clickMenu(path: string[]): Promise<boolean> {
  return app.evaluate(({ Menu }, labels) => {
    const menu = Menu.getApplicationMenu()
    if (menu === null) return false
    let pool: Electron.MenuItem[] = menu.items
    let found: Electron.MenuItem | undefined
    for (const label of labels) {
      const item = pool.find(candidate => candidate.label === label)
      if (item === undefined) return false
      found = item
      if (item.submenu !== null && item.submenu !== undefined) pool = item.submenu.items
    }
    found?.click()
    return true
  }, path)
}

const TOGGLE_SELECTOR = 'button[aria-label="Open sidebar"], button[aria-label="Collapse sidebar"], button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]'

/** The sidebar fold toggle's current aria-label, or null while the shell shows. */
function toggleLabel(): Promise<string | null> {
  return win.evaluate((selector) => {
    const button = document.querySelector(selector)
    return button?.getAttribute('aria-label') ?? null
  }, TOGGLE_SELECTOR)
}

async function openSidebar(): Promise<void> {
  const toggle = win.locator(TOGGLE_SELECTOR)
  if (await toggle.count() > 0) {
    await toggle.first().click()
    await win.locator('[role="treeitem"]').first().waitFor({ timeout: 15_000 })
  }
}

/** The conversation composer is live when its textarea is writable. */
function composerEditable(): Promise<boolean> {
  return win.evaluate(() => {
    const el = document.querySelector('[data-composer-card] textarea') as HTMLTextAreaElement | null
    return el !== null && !el.readOnly
  })
}

function assertCleanConsole(): void {
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
}

describe.skipIf(!guiAvailable() || !runtimeBuilt)('desktop UX', () => {
  beforeAll(async () => {
    provider = createServer(handleProviderRequest)
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as AddressInfo
    providerUrl = `http://127.0.0.1:${address.port}`
    work = mkdtempSync(join(tmpdir(), 'dsh-desktop-ux-'))
    userData = join(work, 'user-data')
    home = join(userData, 'harness')
    mkdirSync(join(work, 'ux-ws'), { recursive: true })
    // Same identity canon as the packaged smoke: seed through the product's
    // realpathNormalize (fs.realpath) so the stored path is a fixed point of
    // the attach-time cwd check (8.3 short temp roots on the windows runner).
    workspaceDir = await realpath(join(work, 'ux-ws'))
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
    await win.waitForFunction(() => {
      const globals = globalThis as { __DSH_BOOT__?: unknown }
      return globals.__DSH_BOOT__ !== undefined && document.querySelector('.shell-state') === null
    }, undefined, { timeout: 30_000 })
    // The pinned UI's first-run notice renders shortly after boot; its
    // backdrop would intercept every later click.
    const continueButton = win.getByRole('button', { name: 'Continue' })
    try {
      await continueButton.waitFor({ state: 'visible', timeout: 60_000 })
      await continueButton.click()
      await continueButton.waitFor({ state: 'detached', timeout: 10_000 })
    } catch {
      // The notice is absent: this home already acknowledged it.
    }
    // Startup auto-selection opens the seeded workspace's blank session.
    await win.waitForFunction(() => {
      const el = document.querySelector('[data-composer-card] textarea')
      return el !== null && !(el as HTMLTextAreaElement).readOnly
    }, undefined, { timeout: 60_000 })
  }, 240_000)

  afterAll(async () => {
    if (app !== undefined) await app.close().catch(() => {})
    await new Promise<void>(resolve => provider?.close(() => { resolve() }))
    rmSync(work, { recursive: true, force: true })
  }, 120_000)

  it('opens at the desktop content size and clamps at the minimum', async () => {
    const contentBounds = (): Promise<{ width: number; height: number }> => app.evaluate(({ BrowserWindow }) => {
      const [bw] = BrowserWindow.getAllWindows()
      if (bw === undefined) throw new Error('app window missing')
      const rect = bw.getContentBounds()
      return { width: rect.width, height: rect.height }
    })
    const content = await contentBounds()
    expect(content.width).toBe(1280)
    expect(content.height).toBe(800)
    // The content minimum keeps the DSH layout out of its narrow (rail)
    // regime: shrinking below it clamps instead of collapsing the app.
    // The restore rides the same main-process call so the window never
    // stays shrunk for a later test.
    const clamped = await app.evaluate(({ BrowserWindow }) => {
      const [bw] = BrowserWindow.getAllWindows()
      if (bw === undefined) throw new Error('app window missing')
      const original = bw.getBounds()
      bw.setBounds({ x: original.x, y: original.y, width: 640, height: 480 })
      const rect = bw.getContentBounds()
      bw.setBounds(original)
      return { width: rect.width, height: rect.height }
    })
    expect(clamped.width).toBeGreaterThanOrEqual(1024)
    expect(clamped.height).toBeGreaterThanOrEqual(600)
    assertCleanConsole()
  }, 60_000)

  it('installs the live native menu with the SPEC surface', async () => {
    const dump = await menuDump()
    expect(dump).not.toBeNull()
    const top = (dump ?? []).map(item => item.label)
    expect(top).toContain('File')
    expect(top).toContain('Edit')
    expect(top).toContain('View')
    expect(top).toContain('Session')
    expect(top).toContain('Help')
    const isMac = process.platform === 'darwin'
    if (isMac) expect(top).toContain(DESKTOP_APP_NAME)
    const byLabel = (label: string) => (dump ?? []).find(item => item.label === label)?.children ?? []
    // The live accelerator echoes the registered template string, unnormalized.
    const file = byLabel('File')
    expect(file.find(item => item.label === 'New Session')?.accelerator).toBe('CmdOrCtrl+N')
    expect(file.find(item => item.label === 'Open Workspace…')?.accelerator).toBe('CmdOrCtrl+O')
    // Settings… lives in the macOS application menu, in File elsewhere.
    const settingsHome = isMac ? DESKTOP_APP_NAME : 'File'
    expect(byLabel(settingsHome).find(item => item.label === 'Settings…')?.accelerator).toBe('CmdOrCtrl+,')
    const view = byLabel('View')
    expect(view.find(item => item.label === 'Toggle Sidebar')?.accelerator).toBe('CmdOrCtrl+\\')
    // Role items render platform-localized labels (macOS: "Actual Size"), so
    // assert the roles; the live MenuItem reports them lowercased.
    expect(view.some(item => item.role === 'zoomin')).toBe(true)
    expect(view.some(item => item.role === 'zoomout')).toBe(true)
    expect(view.some(item => item.role === 'resetzoom')).toBe(true)
    expect(view.some(item => item.role === 'toggledevtools')).toBe(true)
    expect(byLabel('Session').map(item => item.label)).toEqual(['New Session', 'Cancel Current Run', 'Rename Session'])
    const help = byLabel('Help')
    expect(help.find(item => item.label === 'DeepSeek Harness Documentation')?.enabled).toBe(false)
    expect(help.find(item => item.label === 'View Runtime Logs')?.enabled).toBe(false)
    assertCleanConsole()
  }, 60_000)

  it('refuses out-of-vocabulary bridge payloads', async () => {
    const before = await sessionCount()
    await sendCommand('session.delete')
    await app.evaluate(({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('dsh-desktop:command', payload)
    }, { nope: true })
    // Give a (buggy) handler time to act: nothing may.
    await new Promise((resolve) => { setTimeout(resolve, 1_500) })
    expect(await sessionCount()).toBe(before)
    assertCleanConsole()
  }, 60_000)

  it('flips the sidebar through the bridge channel', async () => {
    const before = await toggleLabel()
    expect(before).not.toBeNull()
    await sendCommand('toggle-sidebar')
    await expect.poll(toggleLabel, { timeout: 15_000 }).not.toBe(before)
    await sendCommand('toggle-sidebar')
    await expect.poll(toggleLabel, { timeout: 15_000 }).toBe(before)
    assertCleanConsole()
  }, 60_000)

  it('creates a session through the File menu', async () => {
    // A finished turn first: while a workspace's blank session is current,
    // the pinned New Session action reuses it by design, so the new-session
    // count only moves from a non-blank current session.
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('ux done')
    await composer.press('Enter')
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('UX_DONE')), { timeout: 30_000 }).toBe(true)
    const before = await sessionCount()
    expect(await clickMenu(['File', 'New Session'])).toBe(true)
    await expect.poll(sessionCount, { timeout: 15_000 }).toBe(before + 1)
    await expect.poll(composerEditable, { timeout: 15_000 }).toBe(true)
    assertCleanConsole()
  }, 90_000)

  it('drives the add-workspace directory flow into the OS dialog', async () => {
    await openSidebar()
    // The OS chooser is the one surface the test cannot drive; patch the
    // dialog port in the main process, record the call, and answer cancel.
    await app.evaluate(({ dialog }) => {
      const recorder = { calls: 0, properties: [] as string[] }
      ;(globalThis as Record<string, unknown>).__uxDialogRecorder = recorder
      const stub = (a?: unknown, b?: unknown): Promise<{ canceled: boolean; filePaths: string[] }> => {
        const options = (a !== undefined && typeof a === 'object' && b === undefined)
          ? a as { properties?: string[] }
          : (b ?? {}) as { properties?: string[] }
        recorder.calls += 1
        for (const property of options.properties ?? []) recorder.properties.push(property)
        return Promise.resolve({ canceled: true, filePaths: [] })
      }
      ;(dialog as unknown as Record<string, unknown>).showOpenDialog = stub
    })
    const workspacesBefore = await rpc<{ items: { workspaceId: string }[] }>('workspace.list', {})
    expect(await clickMenu(['File', 'Open Workspace…'])).toBe(true)
    // The add-only picker raises the composed directory flow, which drives
    // host.pickDirectory into the desktop picker and the patched dialog.
    const recorder = await app.evaluate(async () => {
      const read = (): { calls: number; properties: string[] } | undefined =>
        (globalThis as Record<string, unknown>).__uxDialogRecorder as { calls: number; properties: string[] } | undefined
      const deadline = Date.now() + 20_000
      for (;;) {
        const current = read()
        if (current !== undefined && current.calls > 0) return current
        if (Date.now() > deadline) return read() ?? { calls: 0, properties: [] }
        await new Promise((resolve) => { setTimeout(resolve, 250) })
      }
    })
    expect(recorder.calls).toBe(1)
    expect(recorder.properties).toContain('openDirectory')
    // Cancel: no workspace is adopted, the affordance stays available.
    await expect.poll(async () => (await rpc<{ items: { workspaceId: string }[] }>('workspace.list', {})).items.length, { timeout: 10_000 })
      .toBe(workspacesBefore.items.length)
    assertCleanConsole()
  }, 90_000)

  it('cancels a running turn through the Session menu', async () => {
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('ux cancel')
    await composer.press('Enter')
    const stop = win.locator('button[aria-label="Stop generating"], button[aria-label="停止生成"]')
    await stop.first().waitFor({ timeout: 30_000 })
    expect(await clickMenu(['Session', 'Cancel Current Run'])).toBe(true)
    await expect.poll(async () => stop.count(), { timeout: 30_000 }).toBe(0)
    await expect.poll(composerEditable, { timeout: 30_000 }).toBe(true)
    const sessions = await rpc<{ items: SessionSummary[] }>('session.list', {})
    expect(sessions.items.every(item => !item.running)).toBe(true)
    assertCleanConsole()
  }, 120_000)

  it('renames the selected session through the Session menu', async () => {
    // The current session carries the canceled turn's partial content, so
    // its row renders the action cell the rename gesture needs.
    await openSidebar()
    expect(await clickMenu(['Session', 'Rename Session'])).toBe(true)
    const dialog = win.getByRole('dialog').filter({ has: win.locator('input[aria-label="Session name"], input[aria-label="会话名称"]') })
    await dialog.waitFor({ timeout: 15_000 })
    const input = dialog.locator('input[aria-label="Session name"], input[aria-label="会话名称"]')
    await input.fill('UX renamed')
    await dialog.getByRole('button', { name: /^(Rename|重命名)$/ }).click()
    await win.locator('[role="treeitem"]').filter({ hasText: 'UX renamed' }).first().waitFor({ timeout: 15_000 })
    assertCleanConsole()
  }, 90_000)

  it('registers the platform new-session accelerator on the live menu', async () => {
    // Electron registers menu accelerators at the OS level; CDP-synthesized
    // key input (the only input an automated driver has) never reaches that
    // registration, so the key press itself stays in the manual smoke. The
    // automation proves the two halves separately: the accelerator is
    // registered on the live item, and the item's command dispatches the
    // DSH action (the File > New Session test above).
    const dump = await menuDump()
    const file = (dump ?? []).find(item => item.label === 'File')?.children ?? []
    expect(file.find(item => item.label === 'New Session')?.accelerator).toBe('CmdOrCtrl+N')
    expect(file.find(item => item.label === 'Open Workspace…')?.accelerator).toBe('CmdOrCtrl+O')
    assertCleanConsole()
  }, 60_000)

  it('opens settings through the canonical menu item', async () => {
    // The canonical Settings home differs per platform (the macOS
    // application menu, File on the other platforms), but it is always the
    // same closed command reaching the same pinned DSH settings dialog.
    const settingsPath = process.platform === 'darwin'
      ? [DESKTOP_APP_NAME, 'Settings…']
      : ['File', 'Settings…']
    expect(await clickMenu(settingsPath)).toBe(true)
    const dialog = win.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect.poll(async () => await win.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 10_000 }).toBe(0)
    if (process.platform !== 'darwin') {
      // The non-mac About item exercises the platform panel seam.
      await app.evaluate(({ app }) => {
        const recorder = { calls: 0 }
        ;(globalThis as Record<string, unknown>).__uxAboutRecorder = recorder
        const original = app.showAboutPanel.bind(app)
        ;(app as unknown as Record<string, unknown>).showAboutPanel = (): void => {
          recorder.calls += 1
          original()
        }
      })
      expect(await clickMenu(['Help', `About ${DESKTOP_APP_NAME}`])).toBe(true)
      await expect.poll(() => app.evaluate(() => (
        (globalThis as Record<string, unknown>).__uxAboutRecorder as { calls: number }
      ).calls), { timeout: 10_000 }).toBe(1)
    }
    assertCleanConsole()
  }, 90_000)
})

// ── helpers ──────────────────────────────────────────────────────────────────

function seedWorkspaceRegistry(harnessHome: string, dir: string): void {
  const now = new Date().toISOString()
  const storages = join(harnessHome, 'storages')
  mkdirSync(storages, { recursive: true })
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-ux'], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-ux': { path: dir, title: 'ux-probe', sessionIds: [], createdAt: now, updatedAt: now },
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
      DEEPSEEK_API_KEY: 'keyless-desktop-ux',
      DEEPSEEK_BASE_URL: providerUrl,
    },
  })
}
