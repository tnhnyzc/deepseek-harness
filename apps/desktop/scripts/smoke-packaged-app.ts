/**
 * Packaged-app execution smoke: launches the ACTUAL packaged Electron
 * executable (outside the repository checkout), under a fresh temp
 * user-data dir and a constrained PATH, and proves the shipped artifact:
 *
 * - reaches the real DSH UI (`dsh-app://` renderer, client tree booted,
 *   composer editable) with `app.isPackaged === true`;
 * - carries the security baseline the source declares (sandbox,
 *   contextIsolation, no nodeIntegration, webSecurity, no webview, DevTools
 *   denied, the default-deny permission policy with its single clipboard
 *   exception);
 * - runs the packaged standalone runtime: `runtime.ready` under the bundled
 *   Node with the artifact's pinned DSH version, and a bounded real carrier
 *   round trip (composer turn against a scripted 127.0.0.1 provider);
 * - has the native capability channel live end to end (the runtime's
 *   `openPath` probe crosses to Electron main and back as the channel's
 *   `open-failed` failure — no OS side effect, no human click);
 * - opens zero product TCP listeners (the runtime process; the shell's only
 *   listener is this smoke's own DevTools endpoint);
 * - survives the Stage 9 crash/restart drill: abnormal root death, the
 *   window survives, the UI's Restart affordance brings a fresh generation
 *   to readiness with a new runtime pid.
 *
 * The shell is driven over the browser-level DevTools endpoint
 * (`--remote-debugging-port=0`, a Chromium switch this smoke adds at test
 * time, read from the binary's own stderr) with a minimal CDP session. The
 * Node-level inspector is deliberately unavailable in the release binary —
 * `EnableNodeCliInspectArguments` is fused off, a live-code path into the
 * main process — and Playwright's Electron support requires exactly that
 * seam; the browser endpoint is the seam an external observer has instead,
 * and it is sufficient for every assertion here. UI input (composer text,
 * Enter, button clicks) is synthetic DOM events under CDP `Runtime.evaluate`.
 *
 * Self-skips (exit 3) without a built artifact or a GUI session; the CI
 * lanes run it per platform (Linux under xvfb-run).
 *
 * Usage (from the repository root):
 *   node --import tsx/esm apps/desktop/scripts/smoke-packaged-app.ts [artifact]
 * Exit codes: 0 pass, 1 smoke failure, 2 artifact missing, 3 skipped.
 * @module @deepseek-ai/dsh-desktop/scripts/smoke-packaged-app
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { readBuildManifest } from './packaging/build-manifest.ts'
import { electronBinaryPath } from './packaging/fuses.ts'

const appDir = resolve(import.meta.dirname, '..')
const outDir = join(appDir, 'out')

interface SmokeResult {
  ok: boolean
  detail: string
}

const CARRIER_CANARY = 'dsh-packaged-carrier-canary-7d21'

/** The scripted provider's single scripted turn. */
function sse(data: string): string {
  return `data: ${data}\n\n`
}
function sseStop(): string {
  return sse('{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}') + sse('[DONE]')
}
function handleProviderRequest(request: IncomingMessage, response: ServerResponse): void {
  request.resume()
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sse(JSON.stringify({ choices: [{ delta: { content: CARRIER_CANARY } }] })) + sseStop())
  })
}

/** Whether this host can display an Electron window. */
export function guiAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
}

/** Locate the packaged artifact: an explicit argument, else the single platform directory under `out/`. */
function locateArtifact(explicit: string | undefined, platform: NodeJS.Platform): string {
  if (explicit !== undefined) return resolve(explicit)
  // Directories only: the distributable archive and its .sha256 sidecar sit
  // beside the artifact directory under `out/`.
  const candidates = readdirSync(outDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.includes(`-${platform}-`))
    .map(entry => entry.name)
  if (candidates.length !== 1) {
    throw new Error(`smoke-packaged-app: expected exactly one ${platform} artifact under ${outDir}, found ${candidates.length}: ${candidates.join(', ')}`)
  }
  const candidate = candidates[0]
  if (candidate === undefined) throw new Error(`smoke-packaged-app: no ${platform} artifact under ${outDir}`)
  const base = join(outDir, candidate)
  return platform === 'darwin' ? join(base, 'DeepSeek Harness Desktop.app') : base
}

/** The harness home the desktop shell derives from the user-data dir. */
function seedWorkspaceRegistry(home: string, dir: string): void {
  const now = new Date().toISOString()
  const storages = join(home, 'storages')
  mkdirSync(storages, { recursive: true })
  writeFileSync(join(storages, 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-smoke'], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-smoke': { path: dir, title: 'packaged-smoke', sessionIds: [], createdAt: now, updatedAt: now },
      },
    },
  }, null, 2)}\n`, { flag: 'wx' })
}

/** One pid's listening TCP sockets: the product may open none. */
function listeningTcpPids(pid: number, coOwners: readonly number[] = []): string[] {
  if (process.platform === 'darwin') {
    const out = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { encoding: 'utf8' })
    return String(out.stdout ?? '').split('\n').filter(line => line.trim() !== '')
  }
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
    return String(out.stdout ?? '').split('\n').filter((line) => {
      const fields = line.trim().split(/\s+/)
      return fields[3] === 'LISTENING' && fields[4] === String(pid)
    })
  }
  const out = spawnSync('ss', ['-tlnp'], { encoding: 'utf8' })
  return String(out.stdout ?? '').split('\n').filter((line) => {
    if (!line.includes(`pid=${String(pid)},`)) return false
    // On this host the runtime child inherits the shell's fds, so a listener
    // the co-owner holds is the co-owner's (the shell's smoke DevTools
    // endpoint shows up beside the runtime in the process list).
    return !coOwners.some(other => line.includes(`pid=${String(other)},`))
  })
}

/** The report the env-gated smoke channel returns from the shell. */
interface DesktopSmokeReport {
  isPackaged: boolean
  platform: string
  arch: string
  electronVersion: string
  childPid: number | null
  runtime: { state: string; runtimeVersion?: string; dshVersion?: string; reason?: string }
  smokeFacts: { channelRoundTrip?: { code: string }; nativeOpenPath?: { ok: boolean; code?: string; message?: string } } | null
  webPreferences: Record<string, unknown> | null
  devToolsOpened: boolean | null
  permissionPolicy: { defaultDeny: boolean; allowedPermission: string; handlers: string[] }
}

/** One CDP command/response over a page-target WebSocket. */
class CdpPage {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private closed = false
  private closeError: Error | undefined

  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof message.id !== 'number') return
      const call = this.pending.get(message.id)
      if (call === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) call.reject(new Error(`CDP error: ${message.error.message ?? 'unknown'}`))
      else call.resolve(message.result)
    }
    ws.onclose = () => {
      this.closed = true
      this.closeError = new Error('the DevTools page connection closed (the app window or process died)')
      for (const call of this.pending.values()) call.reject(this.closeError)
      this.pending.clear()
    }
  }

  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error('the DevTools page connection is closed'))
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate one page expression, awaiting a returned promise when asked. */
  async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown'}`)
    }
    return result.result?.value
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}

/** The launched app: the child process, its CDP port, and the page session. */
interface PackagedApp {
  child: ChildProcess
  pid: number
  cdpPort: number
  page: CdpPage
}

/** Wait for one stderr line, bounded. */
function waitForStderrLine(
  child: ChildProcess,
  probe: (line: string) => string | undefined,
  timeoutMs: number,
  what: string,
): Promise<string> {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`smoke-packaged-app: timed out waiting for ${what}`))
    }, timeoutMs)
    const onLine = (chunk: Buffer): void => {
      for (const line of String(chunk).split('\n')) {
        const found = probe(line)
        if (found !== undefined) {
          cleanup()
          resolveWait(found)
        }
      }
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stderr?.off('data', onLine)
    }
    child.stderr?.on('data', onLine)
  })
}

/** Poll the browser DevTools HTTP endpoint for the app's page target. */
async function waitForPageTarget(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
      if (response.ok) {
        const targets = (await response.json()) as { type?: string; url?: string; webSocketDebuggerUrl?: string }[]
        const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl !== undefined)
        if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
      }
    } catch {
      // The endpoint is not up yet (or the target list is still empty).
    }
    if (Date.now() > deadline) throw new Error('smoke-packaged-app: the app window never appeared in the DevTools target list')
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
}

/**
 * Launch the packaged binary and attach a CDP session to its window page.
 * The binary is started exactly as a user would, plus the smoke-only
 * `--remote-debugging-port=0` (a Chromium switch, unaffected by the release
 * fuses) whose endpoint is read from the binary's own stderr.
 */
async function launchPackagedApp(
  binary: string,
  userData: string,
  platform: NodeJS.Platform,
  env: Record<string, string>,
): Promise<PackagedApp> {
  // `--no-sandbox` is a harness concern, not a product config: the packaged
  // chrome-sandbox is deliberately not setuid (signing owns that), and
  // headless CI hosts (GitHub ubuntu-24.04: AppArmor blocks unprivileged
  // user namespaces) cannot start Chromium's fallback sandbox. It disables
  // Chromium's own OS-sandbox layer only; the app-level isolation the smoke
  // asserts (contextIsolation, sandboxed renderer, no nodeIntegration) is
  // Electron-side and unaffected.
  const child = spawn(binary, [`--user-data-dir=${userData}`, '--remote-debugging-port=0', '--no-sandbox'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  const onSpawnError = new Promise<never>((_, reject) => {
    child.once('error', error => reject(new Error(`smoke-packaged-app: the packaged binary failed to start: ${error.message}`)))
  })
  // Capture the app's stderr so a launch failure reports what the binary
  // actually said (missing library, sandbox or display error on a headless
  // lane, early crash) instead of only the missing DevTools line.
  const stderrTail: string[] = []
  let stderrBytes = 0
  const onStderrTail = (chunk: Buffer): void => {
    for (const line of String(chunk).split('\n')) {
      if (line === '') continue
      stderrTail.push(line)
      stderrBytes += line.length
    }
    while (stderrBytes > 6000 && stderrTail.length > 1) stderrBytes -= String(stderrTail.shift()).length
  }
  const onEarlyExit = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) => reject(new Error(`smoke-packaged-app: the app exited before its window attached (code ${String(code)}, signal ${String(signal)})`)))
  })
  child.stderr?.on('data', onStderrTail)
  let portLine: string
  try {
    portLine = await Promise.race([
      waitForStderrLine(child, line => line.startsWith('DevTools listening on ') ? line : undefined, 60_000, 'the DevTools endpoint line'),
      onSpawnError,
      onEarlyExit,
    ])
  } catch (error) {
    child.kill('SIGKILL')
    const tail = stderrTail.length > 0 ? `\napp stderr tail:\n${stderrTail.join('\n')}` : ''
    throw new Error(`${error instanceof Error ? error.message : String(error)}${tail}`)
  }
  child.stderr?.off('data', onStderrTail)
  const port = Number(new URL(portLine.slice('DevTools listening on '.length)).port)
  if (!Number.isInteger(port) || port <= 0) {
    child.kill('SIGKILL')
    throw new Error(`smoke-packaged-app: unparseable DevTools endpoint: ${portLine}`)
  }
  const pid = child.pid
  if (typeof pid !== 'number') {
    child.kill('SIGKILL')
    throw new Error('smoke-packaged-app: the spawned app has no pid')
  }
  const pageUrl = await waitForPageTarget(port, 60_000)
  const ws = new WebSocket(pageUrl)
  await new Promise<void>((resolveOpen, reject) => {
    ws.onopen = () => resolveOpen()
    ws.onerror = () => reject(new Error('smoke-packaged-app: the page DevTools connection failed'))
  })
  const page = new CdpPage(ws)
  await page.send('Runtime.enable', {})
  void platform
  return { child, pid, cdpPort: port, page }
}

/** Stop the app (kill the main process; the window dies with it). */
function stopApp(app: PackagedApp, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/F', '/PID', String(app.pid)], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(app.pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/** One CDP round trip must not outlive the harness: a hung renderer main
 *  thread never runs the expression, and an unbounded await would make every
 *  waitForPage deadline on top of it unreachable (the smoke hangs forever). */
const CDP_EVALUATE_TIMEOUT_MS = 10_000

/** `page.evaluate` with a hard bound; the timeout surfaces as a rejection. */
async function boundedEvaluate(page: CdpPage, expression: string, awaitPromise = false): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      page.evaluate(expression, awaitPromise),
      new Promise<never>((_, rejectBound) => {
        timer = setTimeout(() => rejectBound(new Error('smoke-packaged-app: CDP evaluate unresponsive (renderer hung)')), CDP_EVALUATE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Poll one page predicate, bounded. The expression must evaluate to a plain
 * boolean synchronously: this poll does not await returned promises, and a
 * promise serializes to an empty object that never matches. An unresponsive
 * CDP counts as "not yet" so the wall-clock deadline always fires.
 */
async function waitForPage(page: CdpPage, expression: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let unresponsive = 0
  for (;;) {
    let value: unknown
    try {
      value = await boundedEvaluate(page, expression)
      unresponsive = 0
    } catch {
      unresponsive += 1
      value = false
    }
    if (value === true) return
    if (Date.now() > deadline) {
      const suffix = unresponsive > 0 ? ` (CDP unresponsive for the final ${String(unresponsive)} poll(s))` : ''
      throw new Error(`smoke-packaged-app: timed out waiting for ${what}${suffix}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
}

/**
 * Forensics for a stalled crash/restart drill: who is still alive and who is
 * still running. `1 + 1` proves the renderer's JS thread; `root.dataset.state`
 * shows whether the shell has projected the failure at all (a live renderer
 * that never leaves its pre-crash state means the shell never sent the
 * transition); the DevTools HTTP endpoint (served by the shell's browser
 * process) is reachable while the browser network stack runs.
 * @param app - the launched packaged app (shell process + DevTools port).
 * @param deadPid - the runtime pid the drill just killed abnormally.
 * @param platform - the artifact's platform.
 * @returns a compact record embedded in the failure message.
 */
async function gatherCrashDrillDiagnostics(
  app: PackagedApp,
  deadPid: number,
  platform: NodeJS.Platform,
): Promise<Record<string, unknown>> {
  const pidAlive = (pid: number): boolean => {
    if (platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/NH'], { encoding: 'utf8', windowsHide: true })
      return String(out.stdout ?? '').includes(String(pid))
    }
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  let rendererEval: string
  let uiState: string
  try {
    const probe = await boundedEvaluate(app.page, '1 + 1')
    rendererEval = `ok (${String(probe)})`
    uiState = String(await boundedEvaluate(app.page, "(() => { const root = document.getElementById('root'); return root === null ? 'no-root' : (root.dataset.state ?? 'no-state') })()"))
  } catch {
    rendererEval = 'unresponsive'
    uiState = 'unresponsive'
  }
  let devtoolsHttp: string
  try {
    const res = await fetch(`http://127.0.0.1:${String(app.cdpPort)}/json/version`, { signal: AbortSignal.timeout(3_000) })
    devtoolsHttp = `http ${String(res.status)}`
  } catch (error) {
    devtoolsHttp = `unreachable (${error instanceof Error ? error.name : String(error)})`
  }
  return {
    shellPid: app.pid,
    shellExited: app.child.exitCode !== null || app.child.signalCode !== null
      ? { code: app.child.exitCode, signal: app.child.signalCode }
      : false,
    deadRuntimePid: deadPid,
    runtimeAlive: pidAlive(deadPid),
    rendererEval,
    uiState,
    devtoolsHttp,
  }
}

/**
 * Run the packaged-app smoke against one packaged artifact.
 * @param artifact - the `.app` bundle, Windows, or Linux app directory.
 * @param platform - the artifact's platform.
 * @returns the smoke outcome.
 */
export async function runPackagedAppSmoke(artifact: string, platform: NodeJS.Platform): Promise<SmokeResult> {
  const binary = electronBinaryPath(artifact, platform)
  const resources = platform === 'darwin' ? join(artifact, 'Contents', 'Resources') : join(artifact, 'resources')
  const manifestPath = join(resources, 'build-manifest.json')
  if (!existsSync(binary) || !existsSync(manifestPath)) {
    return { ok: false, detail: `artifact incomplete (binary ${binary}, manifest ${manifestPath})` }
  }
  const manifest = readBuildManifest(manifestPath)
  const failures: string[] = []
  const note = (fact: string): void => { process.stdout.write(`smoke-packaged-app: ${fact}\n`) }

  const work = mkdtempSync(join(tmpdir(), 'dsh-packaged-app-'))
  const userData = join(work, 'user-data')
  const home = join(userData, 'harness')
  const provider = createServer(handleProviderRequest)
  await new Promise<void>(resolveListen => provider.listen(0, '127.0.0.1', resolveListen))
  const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`
  let app: PackagedApp | undefined
  let drillDeadPid: number | undefined
  try {
    // Seed the workspace path through the product's own identity canon
    // (realpathNormalize == fs.realpath from node:fs/promises), not the sync
    // realpathSync: attachSession re-canonicalizes the session cwd and
    // compares it string-equal to the stored path, so the seed must be a fixed
    // point of that exact function. On the GitHub windows runner %TEMP% is an
    // 8.3 short name (C:\Users\RUNNER~1\...) where the sync and promise forms
    // disagree; on macOS and many Linux hosts the temp root is a symlink
    // (/var -> /private).
    const rawWorkspaceDir = join(work, 'workspace')
    mkdirSync(rawWorkspaceDir, { recursive: true })
    const workspaceDir = await realpath(rawWorkspaceDir)
    writeFileSync(join(workspaceDir, 'keep.txt'), 'workspace\n')
    seedWorkspaceRegistry(home, workspaceDir)

    app = await launchPackagedApp(
      binary,
      userData,
      platform,
      {
        // Inherit the host session (DISPLAY/TMPDIR/HOME/Windows system
        // variables) and constrain only PATH: the product must boot without
        // system Node/pnpm on PATH.
        ...process.env,
        PATH: platform === 'win32' ? 'C:\\Windows\\system32;C:\\Windows' : '/usr/bin:/bin:/usr/sbin:/sbin',
        DSH_DESKTOP_SMOKE: '1',
        DEEPSEEK_API_KEY: 'keyless-packaged-smoke',
        DEEPSEEK_BASE_URL: providerUrl,
      },
    )
    const page = app.page
    const readUiState = (): Promise<{ state: string; boot: boolean }> => boundedEvaluate(page, `(() => {
      const root = document.getElementById('root')
      return { state: root ? root.dataset.state : null, boot: globalThis.__DSH_BOOT__ !== undefined }
    })()`) as Promise<{ state: string; boot: boolean }>
    // The real UI must be live: the client tree booted (the boot graph
    // published) and the shell projection settled.
    await waitForPage(
      page,
      `(() => {
        const root = document.getElementById('root')
        const state = root ? root.dataset.state : null
        return (state === 'ready' || state === 'failed') && globalThis.__DSH_BOOT__ !== undefined
      })()`,
      180_000,
      'the packaged UI to boot',
    )
    const uiState = (await readUiState()).state
    if (uiState !== 'ready') {
      const report = await boundedEvaluate(page, 'globalThis.dshDesktop ? globalThis.dshDesktop.getRuntimeState() : null', true)
      throw new Error(`the packaged UI is not ready (state ${String(uiState)}; runtime ${JSON.stringify(report ?? null)})`)
    }
    // The composer editability lands after the session/workspace projection
    // settles, i.e. it is part of the boot sequence this smoke already bounds
    // at 180 s above; a cold first-run Windows machine gets the same window.
    const composerDeadline = Date.now() + 180_000
    let composerUnresponsive = 0
    for (;;) {
      let editable: unknown
      try {
        editable = await boundedEvaluate(page, `(() => {
          const el = document.querySelector('[data-composer-card] textarea')
          return el !== null && !el.readOnly
        })()`)
        composerUnresponsive = 0
      } catch {
        composerUnresponsive += 1
        editable = false
      }
      if (editable === true) break
      if (Date.now() > composerDeadline) {
        // The bare timeout proved blind on the CI runner (UI 'ready', composer
        // stuck): dump which gate holds the composer, the runtime child's
        // diagnostic tail (workspace load / session.create surface there), and
        // the hero text (is the seeded workspace visible to the picker?).
        const diagnostic = await boundedEvaluate(page, `(async () => {
          const card = document.querySelector('[data-composer-card]')
          const ta = card !== null ? card.querySelector('textarea') : null
          const root = document.getElementById('root')
          let runtime = null
          try {
            const view = globalThis.dshDesktop !== undefined ? await globalThis.dshDesktop.getRuntimeState() : null
            if (view !== null && typeof view === 'object') {
              const raw = typeof view.diagnostics === 'string' ? view.diagnostics : ''
              runtime = {
                state: view.state ?? null,
                reason: view.reason ?? null,
                diagnosticsTail: raw.split('\\n').slice(-30).join('\\n'),
              }
            } else {
              runtime = view
            }
          } catch (error) {
            runtime = \`getRuntimeState threw: \${String(error)}\`
          }
          return {
            rootState: root !== null ? root.dataset.state : null,
            bootGraph: globalThis.__DSH_BOOT__ !== undefined,
            cardPresent: card !== null,
            textarea: ta === null ? null : {
              readOnly: ta.readOnly,
              disabled: ta.disabled,
              placeholder: ta.placeholder,
              phase: ta.dataset.phase ?? null,
            },
            runtime,
            heroText: (document.body.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 300),
          }
        })()`, true).catch(() => 'CDP unresponsive at the deadline (no diagnostics)')
        const suffix = composerUnresponsive > 0 ? ' (CDP unresponsive for the final polls)' : ''
        throw new Error(`the composer never became editable after boot${suffix}; diagnostics ${JSON.stringify(diagnostic)}`)
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    // The first-run notice backdrop would intercept later interaction;
    // acknowledge it exactly as a first-run user would.
    const hasContinue = await boundedEvaluate(page, `(() => {
      const button = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === 'Continue')
      if (button === undefined) return false
      button.click()
      return true
    })()`)
    if (hasContinue === true) {
      await new Promise(resolveWait => setTimeout(resolveWait, 2_000))
    }
    note('packaged UI live: client tree booted, composer editable, app.isPackaged asserted next')

    // ── the env-gated fact report from the shell ──────────────────────────
    const readSmokeReport = async (): Promise<unknown> => boundedEvaluate(page,
      'globalThis.dshDesktop && globalThis.dshDesktop.smokeReport ? globalThis.dshDesktop.smokeReport() : \'smokeReport missing (DSH_DESKTOP_SMOKE not visible to the preload)\'',
      true,
    )
    let smokeReport = await readSmokeReport()
    if (typeof smokeReport === 'string') throw new Error(smokeReport)
    // The runtime reports its smoke facts after readiness (ready, then the
    // bounded probes, then the report), so poll for the facts to ship
    // before judging the generation.
    const factsDeadline = Date.now() + 45_000
    while ((smokeReport as DesktopSmokeReport).smokeFacts === null && Date.now() < factsDeadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
      smokeReport = await readSmokeReport()
      if (typeof smokeReport === 'string') throw new Error(smokeReport)
    }
    const report = smokeReport as unknown as DesktopSmokeReport
    if (report.isPackaged !== true) failures.push(`app.isPackaged is ${String(report.isPackaged)}`)
    if (report.platform !== manifest.platform || report.arch !== manifest.arch) {
      failures.push(`the shell runs on ${report.platform}-${report.arch}, the artifact pins ${manifest.platform}-${manifest.arch}`)
    }
    if (report.electronVersion !== manifest.electronVersion) {
      failures.push(`electron ${report.electronVersion}, the artifact pins ${manifest.electronVersion}`)
    }
    if (report.runtime.state !== 'ready') failures.push(`runtime state ${report.runtime.state} (${report.runtime.reason ?? 'no reason'})`)
    if (report.runtime.dshVersion !== manifest.deepseekHarnessVersion) {
      failures.push(`runtime dshVersion ${String(report.runtime.dshVersion)}, the artifact pins ${manifest.deepseekHarnessVersion}`)
    }
    if (typeof report.childPid !== 'number' || report.childPid <= 0) {
      failures.push(`the runtime pid is not positive (${String(report.childPid)})`)
    }
    const prefs = report.webPreferences
    for (const [field, expected] of [
      ['nodeIntegration', false], ['contextIsolation', true], ['sandbox', true],
      ['webSecurity', true], ['webviewTag', false], ['devTools', false],
    ] as const) {
      if (prefs === null || prefs[field] !== expected) {
        failures.push(`webPreferences.${field} is ${String(prefs?.[field])}, expected ${String(expected)}`)
      }
    }
    if (report.devToolsOpened !== false) failures.push(`DevTools is open (${String(report.devToolsOpened)})`)
    if (report.permissionPolicy.defaultDeny !== true || report.permissionPolicy.allowedPermission !== 'clipboard-sanitized-write'
      || report.permissionPolicy.handlers.join(',') !== 'request,check') {
      failures.push(`the permission policy is not default-deny with the single clipboard exception: ${JSON.stringify(report.permissionPolicy)}`)
    }
    const channel = report.smokeFacts?.channelRoundTrip
    if (channel === undefined || channel.code !== 'malformed-request') {
      failures.push(`the native channel round trip did not settle as malformed-request: ${JSON.stringify(channel ?? null)}`)
    } else {
      note('native channel live: the malformed-path round trip settled as malformed-request over the production channel')
    }
    const probe = report.smokeFacts?.nativeOpenPath
    if (probe === undefined) {
      failures.push('the runtime published no native round-trip facts (the DSH_DESKTOP_SMOKE generation is missing)')
    } else if (probe.ok !== false) {
      failures.push(`the native openPath probe opened an absent path: ${JSON.stringify(probe)}`)
    } else if (probe.code === 'open-failed') {
      note(`native openPath settled as open-failed (${String(probe.message).slice(0, 80)})`)
    } else if (probe.code === 'probe-aborted') {
      note('native openPath could not settle on this host (headless, no file handler); the channel round trip proved the relay')
    } else {
      failures.push(`the native openPath probe did not fail as the channel requires: ${JSON.stringify(probe)}`)
    }

    // ── zero product TCP listeners ─────────────────────────────────────────
    // The standalone runtime must open none. The shell's main process hosts
    // this smoke's own DevTools endpoint (the harness byproduct the Node
    // inspector would have been); asserting zero there would test the
    // harness, not the product.
    const runtimePid = report.childPid
    if (typeof runtimePid === 'number' && runtimePid > 0) {
      const runtimeListeners = listeningTcpPids(runtimePid, [app.pid])
      if (runtimeListeners.length > 0) {
        failures.push(`runtime pid ${String(runtimePid)} has listening TCP sockets: ${runtimeListeners.join(' | ')}`)
      }
      const shellListeners = listeningTcpPids(app.pid)
      note(`zero product TCP listeners (runtime pid ${String(runtimePid)}); shell pid ${String(app.pid)} carries ${shellListeners.length} smoke DevTools listener(s)`)
    }

    // ── the shipped renderer carries the CSP baseline ─────────────────────
    const rendererIndex = readFileSync(join(resources, 'renderer', 'index.html'), 'utf8')
    if (!rendererIndex.includes('http-equiv="Content-Security-Policy"')) {
      failures.push('the packaged renderer index.html has no Content-Security-Policy meta')
    }

    // ── a bounded real carrier round trip ─────────────────────────────────
    // Synthetic DOM input under CDP: the React-controlled textarea takes the
    // native value setter + input event, and Enter arrives as a keydown.
    await boundedEvaluate(page, `(() => {
      const el = document.querySelector('[data-composer-card] textarea')
      if (el === null) throw new Error('the composer textarea is gone')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, 'packaged carrier turn')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
      return true
    })()`)
    await waitForPage(
      page,
      `document.body.innerText.includes(${JSON.stringify(CARRIER_CANARY)})`,
      120_000,
      'the carrier canary to render',
    )
    note('carrier round trip: composer turn reached the scripted provider through the packaged runtime')

    // ── the Stage 9 crash/restart drill ───────────────────────────────────
    const before = await boundedEvaluate(page, 'globalThis.dshDesktop.getRuntimeState()', true) as { state: string }
    if (typeof report.childPid !== 'number' || report.childPid <= 0 || before.state !== 'ready') {
      throw new Error('the crash drill needs a ready runtime with a positive pid')
    }
    const deadPid = report.childPid
    drillDeadPid = deadPid
    if (platform === 'win32') {
      spawnSync('taskkill', ['/F', '/PID', String(deadPid)], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(deadPid, 'SIGKILL')
    }
    // The DOM projection is the synchronous source of truth for the state
    // waits (an IPC round trip would arrive as a promise this poll does not
    // await); the explicit getRuntimeState asserts below are the binding ones.
    await waitForPage(
      page,
      '(() => { const root = document.getElementById(\'root\'); return root !== null && root.dataset.state === \'failed\' })()',
      60_000,
      'the failure state after the crash',
    )
    const failedState = (await boundedEvaluate(page, 'globalThis.dshDesktop.getRuntimeState()', true)) as { state: string }
    if (failedState.state !== 'failed') {
      throw new Error(`after the abnormal root death the runtime state is ${failedState.state}, expected failed`)
    }
    note(`crash drill: runtime pid ${String(deadPid)} killed abnormally; the window survived; state failed`)
    await waitForPage(page, 'document.querySelector(\'button.shell-restart\') !== null', 30_000, 'the restart affordance')
    await boundedEvaluate(page, '(() => { const button = document.querySelector(\'button.shell-restart\'); if (button === null) throw new Error(\'the restart button is gone\'); button.click(); return true })()')
    await waitForPage(
      page,
      '(() => { const root = document.getElementById(\'root\'); return root !== null && root.dataset.state === \'ready\' })()',
      180_000,
      'the restarted generation to reach readiness',
    )
    const after = (await boundedEvaluate(page, 'globalThis.dshDesktop.getRuntimeState()', true)) as { state: string }
    if (after.state !== 'ready') throw new Error(`after Restart the runtime state is ${after.state}`)
    const afterReport = (await boundedEvaluate(page, 'globalThis.dshDesktop.smokeReport ? globalThis.dshDesktop.smokeReport() : null', true)) as DesktopSmokeReport | null
    if (afterReport?.childPid === undefined || afterReport.childPid === null || afterReport.childPid === deadPid) {
      throw new Error(`the restarted generation reused or lost the runtime pid (${String(afterReport?.childPid)}, dead pid ${String(deadPid)})`)
    }
    note(`crash drill: Restart brought a fresh generation to readiness (new runtime pid ${String(afterReport?.childPid)})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (drillDeadPid !== undefined && app !== undefined) {
      const diagnostics = await gatherCrashDrillDiagnostics(app, drillDeadPid, platform)
      failures.push(`${message}; crash-drill diagnostics ${JSON.stringify(diagnostics)}`)
    } else {
      failures.push(message)
    }
  } finally {
    if (app !== undefined) {
      stopApp(app, platform)
      app.page.close()
      // Give the child a moment to die before the workdir goes.
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
    await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
    rmSync(work, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    return { ok: false, detail: failures.join('; ') }
  }
  return { ok: true, detail: 'packaged Electron reached the real DSH UI with the security baseline, live native channel, zero listeners, and a healthy crash/restart cycle' }
}

async function main(): Promise<void> {
  const platform = process.platform
  if (!guiAvailable()) {
    process.stderr.write('smoke-packaged-app: no GUI session on this host; skipped (CI lanes run it per platform)\n')
    process.exit(3)
  }
  let artifact: string
  try {
    artifact = locateArtifact(process.argv[2], platform)
  } catch (error) {
    process.stderr.write(`smoke-packaged-app: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
  if (!existsSync(artifact)) {
    process.stderr.write(`smoke-packaged-app: artifact not found at ${artifact}; run the package pipeline first\n`)
    process.exit(2)
  }
  const result = await runPackagedAppSmoke(artifact, platform)
  console.log(`smoke-packaged-app: ${result.ok ? 'PASS' : 'FAIL'} — ${result.detail}`)
  process.exit(result.ok ? 0 : 1)
}

// Run only as the entry script; the vitest spec imports the smoke.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
