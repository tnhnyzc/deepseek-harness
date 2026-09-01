/**
 * D4 acceptance gate (Windows only): proves the job-object containment
 * end to end on a real Windows kernel. The contained root installs the real
 * job (KILL_ON_JOB_CLOSE), spawns two long-lived descendants, and is then
 * killed with `taskkill /F /PID` — a single-process force kill that does
 * NOT let taskkill's own tree walk answer for the job. Acceptance: the OS
 * terminates both contained descendants when the root's job handle closes,
 * the control process the harness spawns outside the job survives, and a
 * replacement generation boots healthy (a new process, a new job, no
 * capture by the dead one).
 *
 * Two roots, one contract:
 *   --packaged <appDir>  the packaged runtime entry under the artifact's
 *                        own bundled Node (the shipped surface; the Windows
 *                        CI lane runs this mode)
 *   (no flag)            the source tree under the harness's Node with the
 *                        real windows-job module (developer iteration)
 *
 * Outer-job hosts (hosted CI runners, service hosts) already place the
 * process tree in an externally owned Job Object: the product job cannot
 * be installed, the runtime boots in its `externally-contained` fallback,
 * and this gate must NOT count the run as a D4 validation. It then exits 0
 * with a loud `SKIP (externally contained)` marker so the CI lane can
 * run; a real D4 validation comes from an unjobbed launch context where
 * the product Job Object assignment succeeds.
 *
 * Run from the repository root:
 *   node --import tsx/esm apps/desktop/scripts/d4-acceptance.ts --packaged "apps/desktop/out/DeepSeek Harness Desktop-win32-x64"
 *   node --import tsx/esm apps/desktop/scripts/d4-acceptance.ts
 * Exit codes: 0 pass or loud external-containment skip, 1 acceptance
 * failure, 2 not a Windows host or bad usage.
 */

import { execFileSync, fork, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  process.stderr.write('d4-acceptance: Windows-only gate; run it on a Windows host or CI runner\n')
  process.exit(2)
}

const READY_TIMEOUT_MS = 120_000
const DESCENDANT_GRACE_MS = 15_000
const SLEEP_MS = 120_000
const SHUTDOWN_GRACE_MS = 15_000

/** Whether a pid is still in the task list. */
function alive(pid: number): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/NH'], { encoding: 'utf8', windowsHide: true })
    return !out.includes('INFO:')
  } catch {
    return false
  }
}

/** Force-kill one process only — the root-death event must not let taskkill's own tree walk answer for the job. */
function killProcess(pid: number): void {
  spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

/** Cleanup helper for harness-owned processes after the test settles. */
function killTree(pid: number): void {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

function fail(message: string): never {
  process.stderr.write(`d4-acceptance: FAIL: ${message}\n`)
  process.exit(1)
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Control process, spawned by the harness: outside every job. */
const control = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${SLEEP_MS})`], { stdio: 'ignore' })
if (control.pid === undefined) fail('control spawn returned no pid')

async function waitExit(child: ChildProcess, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (child.exitCode === null && child.connected && Date.now() - start < timeoutMs) {
    await sleep(50)
  }
  if (child.exitCode === null && child.connected) {
    if (child.pid !== undefined) killTree(child.pid)
    throw new Error(`${label} did not exit within ${String(timeoutMs)} ms`)
  }
}

/** The shared verdict after the root death: descendants dead, control alive. */
async function verifyContainment(descendants: number[]): Promise<void> {
  process.stdout.write(`d4-acceptance: root killed; waiting for job-contained descendants ${descendants.join(', ')}\n`)
  const deadline = Date.now() + DESCENDANT_GRACE_MS
  while (Date.now() < deadline) {
    if (descendants.every(pid => !alive(pid))) break
    await sleep(250)
  }
  const survivors = descendants.filter(alive)
  if (survivors.length > 0) {
    survivors.forEach(killTree)
    fail(`contained descendants ${survivors.join(', ')} outlived the root's job handle close`)
  }
  if (!alive(control.pid)) {
    fail('the control process outside the job was killed; containment captured an unrelated process')
  }
  process.stdout.write('d4-acceptance: contained descendants died with the root; the unrelated control survived\n')
}

function parseArgs(argv: string[]): { packagedArtifact?: string } {
  const options: { packagedArtifact?: string } = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--packaged') {
      i += 1
      options.packagedArtifact = argv[i]
      if (options.packagedArtifact === undefined) fail('--packaged requires an artifact directory argument')
    } else if (arg === '--') {
      continue
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

if (options.packagedArtifact !== undefined) {
  // ---- packaged mode: the shipped runtime entry under the bundled Node ----
  const artifact = resolve(options.packagedArtifact)
  const resources = join(artifact, 'resources')
  const node = join(resources, 'node', 'win32-x64', 'node.exe')
  const entry = join(resources, 'runtime', 'dist', 'index.js')
  const runtimeDir = join(resources, 'runtime')
  const manifestPath = join(resources, 'build-manifest.json')
  for (const [label, path] of [['artifact', artifact], ['bundled node', node], ['runtime entry', entry], ['manifest', manifestPath]] as const) {
    if (!existsSync(path)) fail(`${label} missing at ${path}; run the Windows package step first`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { deepseekHarnessVersion?: unknown }
  if (typeof manifest.deepseekHarnessVersion !== 'string') fail('the artifact manifest has no deepseekHarnessVersion')

  const childEnv = (): Record<string, string> => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-d4-'))
    return {
      // A minimal PATH without any Node/pnpm install location: the runtime
      // runs under the explicitly-forked bundled Node.
      PATH: 'C:\\Windows\\system32;C:\\Windows',
      ...(process.env.USERPROFILE !== undefined ? { USERPROFILE: process.env.USERPROFILE } : {}),
      DSH_DESKTOP: '1',
      DSH_HOME: home,
    }
  }
  const forkRuntime = (acceptance: boolean): ChildProcess => {
    const env = childEnv()
    if (acceptance) env.DSH_D4_ACCEPTANCE = '1'
    const child = fork(entry, [], {
      execPath: node,
      execArgv: [],
      cwd: runtimeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    return child
  }

  let report: { mode: 'product-job'; descendants: number[] } | { mode: 'externally-contained' } | undefined
  let readyVersion: string | undefined
  root = forkRuntime(true)
  root.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(`[d4-root] ${String(chunk)}`) })
  root.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(`[d4-root] ${String(chunk)}`) })
  root.on('message', (message: { type?: unknown; mode?: unknown; descendants?: unknown; dshVersion?: unknown } | null) => {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'd4.acceptance-report' && message.mode === 'externally-contained') {
      report = { mode: 'externally-contained' }
    } else if (message.type === 'd4.acceptance-report' && message.mode === 'product-job'
      && Array.isArray(message.descendants) && message.descendants.length === 2
      && message.descendants.every(pid => typeof pid === 'number')) {
      report = { mode: 'product-job', descendants: message.descendants as number[] }
    }
    if (message.type === 'runtime.ready' && typeof message.dshVersion === 'string') {
      readyVersion = message.dshVersion
    }
  })

  const waitReady = async (): Promise<void> => {
    const start = Date.now()
    while (readyVersion === undefined && root.exitCode === null && Date.now() - start < READY_TIMEOUT_MS) {
      await sleep(100)
    }
  }
  await waitReady()
  if (root.exitCode !== null) {
    killTree(control.pid)
    fail(`packaged root exited before readiness (code ${String(root.exitCode)}): containment install or packaged boot failed`)
  }
  if (report === undefined) {
    killTree(control.pid)
    fail('the packaged runtime never reported its D4 containment mode')
  }
  if (readyVersion !== manifest.deepseekHarnessVersion) {
    killTree(control.pid)
    fail(`packaged runtime reports dshVersion ${String(readyVersion)}, the artifact pins ${String(manifest.deepseekHarnessVersion)}`)
  }
  if (report.mode === 'externally-contained') {
    killTree(control.pid)
    process.stdout.write(
      'd4-acceptance: SKIP (externally contained) — the packaged runtime booted healthy in the fallback under the bundled Node; '
      + 'the product Job Object was not installed and D4 is NOT validated on this host\n',
    )
    process.exit(0)
  }
  process.stdout.write(`d4-acceptance: packaged runtime ready (dshVersion ${String(readyVersion)}) under the bundled Node with the job installed\n`)
  const [descA, descB] = report.descendants
  if (descA === undefined || descB === undefined) {
    killTree(control.pid)
    fail('the packaged runtime reported a malformed descendant list')
  }
  if (!alive(descA) || !alive(descB)) {
    killTree(control.pid)
    fail('a reported descendant was not alive when the root was killed')
  }

  // The event under test: an unexpected root death — one that does NOT let
  // taskkill's own tree walk answer for the job.
  if (root.pid === undefined) fail('the packaged root spawn returned no pid')
  killProcess(root.pid)
  await waitExit(root, READY_TIMEOUT_MS, 'packaged root').catch(error => fail(String(error)))
  await verifyContainment([descA, descB])

  // Replacement generation: a fresh process under the bundled Node must
  // boot healthy — its own job, no capture by the dead generation's.
  const restart = forkRuntime(false)
  let restartReady = false
  restart.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(`[d4-restart] ${String(chunk)}`) })
  restart.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(`[d4-restart] ${String(chunk)}`) })
  restart.on('message', (message: { type?: unknown; dshVersion?: unknown } | null) => {
    if (message !== null && typeof message === 'object' && message.type === 'runtime.ready') restartReady = true
  })
  await waitReady()
  if (!restartReady) {
    restart.send?.({ type: 'runtime.shutdown' })
    await waitExit(restart, SHUTDOWN_GRACE_MS, 'restart generation').catch(() => undefined)
    killTree(control.pid)
    fail('the replacement generation did not reach readiness: the dead job captured it or the packaged boot regressed')
  }
  process.stdout.write('d4-acceptance: replacement generation reached readiness under the bundled Node\n')
  restart.send?.({ type: 'runtime.shutdown' })
  await waitExit(restart, SHUTDOWN_GRACE_MS, 'restart generation')
  killTree(control.pid)
  process.stdout.write('d4-acceptance: PASS (packaged) — job-contained descendants died with the root, the control survived, and a fresh generation is healthy\n')
  process.exit(0)
}

// ---- source mode: the source tree under the harness's Node ----
const root = spawn(process.execPath, ['--import', 'tsx/esm', join(import.meta.dirname, 'd4-acceptance-child.ts')], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
if (root.pid === undefined) fail('root spawn returned no pid')

let reported: { mode: 'product-job'; descendants: number[] } | { mode: 'externally-contained' } | undefined
let settled = false
root.stdout?.on('data', (chunk: Buffer) => {
  if (settled) return
  const line = chunk.toString().trim()
  if (!line.startsWith('{')) return
  try {
    const parsed = JSON.parse(line) as { mode?: unknown; descendants?: unknown }
    if (parsed.mode === 'externally-contained') {
      settled = true
      reported = { mode: 'externally-contained' }
      return
    }
    if (parsed.mode !== 'product-job' || !Array.isArray(parsed.descendants) || parsed.descendants.some(pid => typeof pid !== 'number')) return
    settled = true
    reported = { mode: 'product-job', descendants: parsed.descendants as number[] }
  } catch {
    // A partial or non-JSON line; keep waiting for the report.
  }
})
let rootExited = false
let rootExitCode = -1
root.on('exit', (code) => { rootExited = true; rootExitCode = code ?? -1 })

const start = Date.now()
while (reported === undefined && !rootExited && Date.now() - start < READY_TIMEOUT_MS) {
  await sleep(100)
}
if (reported === undefined) {
  killTree(control.pid)
  fail(rootExited
    ? `root exited before reporting (code ${String(rootExitCode)}): the containment install or child boot failed`
    : `root did not report within ${String(READY_TIMEOUT_MS)} ms (tsx/koffi boot too slow)`)
}
if (reported.mode === 'externally-contained') {
  killTree(control.pid)
  process.stdout.write(
    'd4-acceptance: SKIP (externally contained) — the source-mode root installed in the fallback; '
    + 'the product Job Object was not installed and D4 is NOT validated on this host\n',
  )
  process.exit(0)
}
if (reported.descendants.length !== 2) {
  killTree(control.pid)
  fail('root reported a malformed descendant list')
}
const [descA, descB] = reported.descendants
if (descA === undefined || descB === undefined) fail('root reported a malformed descendant list')
if (!alive(descA) || !alive(descB)) {
  killTree(control.pid)
  fail('a reported descendant was not alive when the root was killed')
}

killProcess(root.pid)
while (!rootExited) {
  await sleep(50)
}
await verifyContainment([descA, descB])
killTree(control.pid)
process.stdout.write('d4-acceptance: PASS (source) — job-contained descendants died with the root; the unrelated control survived\n')
process.exit(0)
