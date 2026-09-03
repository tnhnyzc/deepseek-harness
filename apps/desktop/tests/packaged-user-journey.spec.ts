/**
 * Layer D (packaged) — the real user workflow against the ACTUAL release
 * artifact, not the development Electron. This tier owns the release-unit
 * concerns the dev canonical journey cannot: the distributable archive
 * extracting to a launchable app, `app.isPackaged`, the bundled standalone
 * Node booting DSH, running OUTSIDE the repository checkout under a
 * constrained PATH (no system Node/npm/pnpm resolvable), a basic session
 * workflow (stream + tool), a clean quit, and reopening with the session
 * restored.
 *
 * The packaged binary is the seam an external observer has: the Node-level
 * inspector is fused off in the release build (a live-code path into the main
 * process), so — exactly as the packaged CDP smoke — the shell is driven over
 * the browser-level DevTools endpoint (`--remote-debugging-port=0`, read from
 * the binary's own stderr) via a Playwright `connectOverCDP` session. The
 * archive is extracted to a temp location outside the repository before
 * launch, so the shipped unit is proven self-contained (no source checkout
 * resolution, no stale development `dist`).
 *
 * `app.isPackaged` and the runtime facts come from the env-gated, read-only
 * `DSH_DESKTOP_SMOKE` report channel (the same seam the per-platform CI smoke
 * uses; it is inert without the env flag). The session workflow itself is pure
 * UI — composer, transport, durable logs — never a backdoor.
 *
 * Self-skips without a built archive or a GUI session.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScriptedProvider, type ScriptedProvider } from './support/deterministic-provider.ts'
import {
  acknowledgeFirstRun,
  composerEditable,
  e2eRequired,
  rpc,
  seedWorkspaceRegistry,
  skipUnless,
  waitForShellReady,
  type SessionSummary,
} from './support/electron-world.ts'

const appDir = join(import.meta.dirname, '..')
const outDir = join(appDir, 'out')
const APP_PRODUCT_NAME = 'DeepSeek Harness Desktop'
const platform = process.platform

/** Whether this host can display an Electron window. */
function guiAvailable(): boolean {
  if (platform === 'darwin' || platform === 'win32') return true
  return process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
}

/** The distributable archive under `out/` for this platform-arch. */
function locateArchive(): string {
  const ext = platform === 'linux' ? 'tar.gz' : 'zip'
  const matches = readdirSync(outDir).filter(name =>
    name.startsWith(`${APP_PRODUCT_NAME}-`) && name.endsWith(`-${platform}-${process.arch}.${ext}`))
  if (matches.length !== 1) throw new Error(`expected exactly one ${platform} archive under ${outDir}, found ${matches.length}: ${matches.join(', ')}`)
  return join(outDir, matches[0] as string)
}

/** The Electron binary inside a packaged artifact. */
function binaryPath(artifact: string): string {
  if (platform === 'darwin') return join(artifact, 'Contents', 'MacOS', APP_PRODUCT_NAME)
  if (platform === 'win32') return join(artifact, `${APP_PRODUCT_NAME}.exe`)
  return join(artifact, APP_PRODUCT_NAME)
}

/** The artifact's pinned DSH version, from the embedded build manifest. */
function manifestDshVersion(artifact: string): string {
  const resources = platform === 'darwin' ? join(artifact, 'Contents', 'Resources') : join(artifact, 'resources')
  const manifest = JSON.parse(readFileSync(join(resources, 'build-manifest.json'), 'utf8')) as { deepseekHarnessVersion: string }
  return manifest.deepseekHarnessVersion
}

/** Extract a release archive to a fresh directory; returns the artifact root. */
function extractArchive(archive: string, dest: string): string {
  mkdirSync(dest, { recursive: true })
  if (platform === 'linux') {
    spawnSync('tar', ['-xzf', archive, '-C', dest], { stdio: 'ignore' })
  } else {
    spawnSync('unzip', ['-q', archive, '-d', dest], { stdio: 'ignore' })
  }
  if (platform === 'darwin') return join(dest, `${APP_PRODUCT_NAME}.app`)
  const entry = readdirSync(dest, { withFileTypes: true }).find(e => e.isDirectory())
  if (entry === undefined) throw new Error(`no directory in the extracted archive under ${dest}`)
  return join(dest, entry.name)
}

/** Read the browser DevTools port the binary prints to its stderr. */
function readDevToolsPort(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out waiting for the DevTools endpoint line')) }, 60_000)
    const onLine = (chunk: Buffer): void => {
      for (const line of String(chunk).split('\n')) {
        if (line.startsWith('DevTools listening on ')) {
          clearTimeout(timer)
          child.stderr?.off('data', onLine)
          resolve(Number(new URL(line.slice('DevTools listening on '.length)).port))
        }
      }
    }
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`the packaged binary failed to start: ${error.message}`)) })
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`the app exited before its window attached (code ${String(code)}, signal ${String(signal)})`)) })
    child.stderr?.on('data', onLine)
  })
}

/** The app's window is the `dsh-app://` page target in the CDP target list. */
async function findAppPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 60_000
  for (;;) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('dsh-app://')) return page
      }
    }
    if (Date.now() > deadline) throw new Error('the app window never appeared as a dsh-app:// page')
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
}

/** The env-gated read-only report: isPackaged + runtime facts (the CI smoke's seam). */
interface SmokeReport {
  isPackaged: boolean
  runtime: { state: string; dshVersion?: string; reason?: string }
  childPid: number | null
}
async function smokeReport(page: Page): Promise<SmokeReport> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const report = await page.evaluate(() => {
      const bridge = (globalThis as { dshDesktop?: { smokeReport?: () => Promise<unknown> } }).dshDesktop
      if (bridge?.smokeReport === undefined) return null
      return bridge.smokeReport() as Promise<SmokeReport>
    })
    if (report !== null) return report
    if (Date.now() > deadline) throw new Error('the DSH_DESKTOP_SMOKE report was never exposed to the preload')
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
}

/**
 * Quit the running app through its own termination path, escalating to a hard
 * kill so the harness never hangs on a process that refused to close.
 */
function quitApp(child: ChildProcess): void {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
    return
  }
  if (platform === 'darwin') {
    spawnSync('osascript', ['-e', `tell application "${APP_PRODUCT_NAME}" to quit`], { stdio: 'ignore' })
  } else {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

/** Wait for the composer to become writable (a non-test `expect.poll` cannot run in `beforeAll`). */
async function waitForComposer(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await composerEditable(page)) return
    if (Date.now() > deadline) throw new Error('the composer never became editable after boot')
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
}

/** Wait for the process to exit; escalate to a hard kill at the deadline. */
async function waitExited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return true
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      return child.exitCode !== null || child.signalCode !== null
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
}

const hasArtifact = (() => {
  try {
    locateArchive()
    return true
  } catch {
    return false
  }
})()

describe.skipIf(skipUnless(guiAvailable(), hasArtifact))('packaged user journey (the release artifact)', () => {
  let provider: ScriptedProvider
  let work: string
  let userData: string
  let home: string
  let workspaceDir: string
  let extracted: string
  let app: { browser: Browser; child: ChildProcess; page: Page } | undefined

  const constrainedEnv = (): NodeJS.ProcessEnv => ({
    // Inherit the host session (DISPLAY/HOME/Windows system vars) and constrain
    // only PATH: the product must boot with no Node/npm/pnpm/dsh resolvable —
    // the runtime runs under the explicitly-forked bundled Node, never PATH.
    ...process.env,
    PATH: platform === 'win32' ? 'C:\\Windows\\system32;C:\\Windows' : '/usr/bin:/bin:/usr/sbin:/sbin',
    DSH_DESKTOP_SMOKE: '1',
    DEEPSEEK_API_KEY: 'keyless-packaged-journey',
    DEEPSEEK_BASE_URL: provider.url,
  })

  const launchPackaged = async (artifact: string): Promise<{ browser: Browser; child: ChildProcess; page: Page }> => {
    const child = spawn(binaryPath(artifact), [`--user-data-dir=${userData}`, '--remote-debugging-port=0', '--no-sandbox'], {
      env: constrainedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const port = await readDevToolsPort(child)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`)
    const page = await findAppPage(browser)
    await page.waitForLoadState('domcontentloaded')
    return { browser, child, page }
  }

  const closeApp = async (running: { browser: Browser; child: ChildProcess }): Promise<void> => {
    await running.browser.close().catch(() => {})
    if (running.child.exitCode === null && running.child.signalCode === null) {
      quitApp(running.child)
      await waitExited(running.child, 15_000)
    }
  }

  beforeAll(async () => {
    if (e2eRequired) {
      if (!guiAvailable()) throw new Error('required packaged E2E lane has no GUI session (DISPLAY/xvfb missing)')
      if (!hasArtifact) throw new Error('required packaged E2E lane has no built release archive; the package step must run first')
    }
    provider = await createScriptedProvider({
      'pkg stream turn': [
        { kind: 'text', chunks: [['PKG_PARTIAL_', 150], ['PKG_STREAM_DONE', 150]], finish: true },
      ],
      'pkg tool turn': [
        { kind: 'tool', name: 'bash', args: { command: 'echo pkg > pkg-out.txt', description: 'write the packaged file' } },
        { kind: 'text', chunks: [['PKG_TOOL_DONE', 100]], finish: true },
      ],
    }, 'Packaged journey title')
    work = mkdtempSync(join(tmpdir(), 'dsh-packaged-journey-'))
    userData = join(work, 'user-data')
    home = join(userData, 'harness')
    mkdirSync(join(work, 'pkg-ws'), { recursive: true })
    workspaceDir = await realpath(join(work, 'pkg-ws'))
    writeFileSync(join(workspaceDir, 'keep.txt'), 'workspace\n')
    // A known workspace so the basic session workflow has somewhere to run
    // (the fresh-profile + real-picker path is owned by the dev journey).
    seedWorkspaceRegistry(home, workspaceDir, 'packaged-journey', 'ws-pkg')
    // Extract the release archive OUTSIDE the repository: the launched unit is
    // the real distribution artifact and must not resolve anything from the
    // source checkout.
    extracted = extractArchive(locateArchive(), join(work, 'artifact'))
    app = await launchPackaged(extracted)
    await waitForShellReady(app.page)
    await acknowledgeFirstRun(app.page)
    await waitForComposer(app.page, 60_000)
  }, 300_000)

  afterAll(async () => {
    if (app !== undefined) await closeApp(app).catch(() => {})
    await provider.close()
    rmSync(work, { recursive: true, force: true })
  }, 120_000)

  it('boots the extracted archive outside the repo as a packaged app with the bundled Node', async () => {
    const current = app
    if (current === undefined) throw new Error('no packaged app under test')
    const report = await smokeReport(current.page)
    expect(report.isPackaged).toBe(true)
    // The runtime is ready and runs the artifact's pinned DSH under the
    // explicitly-forked bundled Node (the constrained PATH has no system Node).
    expect(report.runtime.state).toBe('ready')
    expect(report.runtime.dshVersion).toBe(manifestDshVersion(extracted))
    // The real DSH UI is live: the client tree booted and the composer is open.
    expect(await composerEditable(current.page)).toBe(true)
  }, 90_000)

  it('runs a basic session workflow on the packaged app', async () => {
    const page = app?.page
    if (page === undefined) throw new Error('no packaged app under test')
    const composer = page.locator('[data-composer-card] textarea')
    await composer.fill('pkg stream turn')
    await composer.press('Enter')
    // Incremental streaming, then the final text.
    await page.waitForFunction(() => document.body.innerText.includes('PKG_PARTIAL_') && !document.body.innerText.includes('PKG_STREAM_DONE'), undefined, { timeout: 30_000, polling: 50 })
    await expect.poll(() => page.evaluate(() => document.body.innerText.includes('PKG_STREAM_DONE')), { timeout: 30_000 }).toBe(true)
    await composer.fill('pkg tool turn')
    await composer.press('Enter')
    await expect.poll(() => page.evaluate(() => document.body.innerText.includes('PKG_TOOL_DONE')), { timeout: 60_000 }).toBe(true)
    // World state: the tool really ran in the packaged workspace.
    expect(existsSync(join(workspaceDir, 'pkg-out.txt'))).toBe(true)
  }, 150_000)

  it('quits cleanly and reopens with the session restored', async () => {
    const first = app
    if (first === undefined) throw new Error('no packaged app under test')
    await closeApp(first)
    // Reopen against the same profile: the session and its turns survive.
    const reopened = await launchPackaged(extracted)
    app = reopened
    const page = reopened.page
    await waitForShellReady(page)
    await expect.poll(() => composerEditable(page), { timeout: 60_000 }).toBe(true)
    const sessions = await rpc<{ items: SessionSummary[] }>(page, 'session.list', {}, 'pkg')
    expect(sessions.items.length).toBeGreaterThanOrEqual(1)
    expect(sessions.items.every(item => !item.running)).toBe(true)
    // The reopened conversation still carries the streamed reply.
    await expect.poll(() => page.evaluate(() => document.body.innerText.includes('PKG_STREAM_DONE')), { timeout: 30_000 }).toBe(true)
  }, 240_000)

  it('the release archive is checksum-valid and reproducibly extractable', async () => {
    const archive = locateArchive()
    // Integrity: the archive's digest matches its committed `.sha256` sidecar
    // (the release traceability contract), so a downloaded archive is the
    // exact artifact the build produced.
    const sidecar = readFileSync(`${archive}.sha256`, 'utf8').trim()
    const [expectedSha, ...nameParts] = sidecar.split(/\s+/)
    expect(nameParts.join(' ')).toBe(archive.split('/').pop())
    expect(createHash('sha256').update(readFileSync(archive)).digest('hex')).toBe(expectedSha)
    // A second independent extraction of the same archive still yields a
    // complete, launchable artifact (reproducibility of the distribution unit).
    const again = extractArchive(archive, join(work, 'extracted-again'))
    expect(existsSync(binaryPath(again))).toBe(true)
    expect(existsSync(manifestPath(again))).toBe(true)
  }, 300_000)
})

function manifestPath(artifact: string): string {
  const resources = platform === 'darwin' ? join(artifact, 'Contents', 'Resources') : join(artifact, 'resources')
  return join(resources, 'build-manifest.json')
}
