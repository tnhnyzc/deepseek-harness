/**
 * D4 acceptance gate (Windows only): proves the job-object containment
 * end to end on a real Windows kernel. The contained root
 * (d4-acceptance-child.ts) installs the real job, spawns two long-lived
 * descendants, and is then killed with `taskkill /F` — the unexpected
 * root death stage 9 found `taskkill /T` could not answer. Acceptance:
 * the OS terminates both contained descendants when the root's job handle
 * closes (KILL_ON_JOB_CLOSE), and the control process the harness spawns
 * outside the job survives.
 *
 * Run from the repository root:
 *   node --import tsx/esm apps/desktop/scripts/d4-acceptance.ts
 * Exit codes: 0 pass, 1 acceptance failure, 2 not a Windows host.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  process.stderr.write('d4-acceptance: Windows-only gate; run it on a Windows host or CI runner\n')
  process.exit(2)
}

const REPORT_TIMEOUT_MS = 90_000
const DESCENDANT_GRACE_MS = 15_000
const SLEEP_MS = 120_000

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

// Control process, spawned by the harness: outside every job.
const control = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${SLEEP_MS})`], { stdio: 'ignore' })
if (control.pid === undefined) fail('control spawn returned no pid')

// Contained root: installs the real job, reports its descendants.
const root = spawn(process.execPath, ['--import', 'tsx/esm', join(import.meta.dirname, 'd4-acceptance-child.ts')], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
if (root.pid === undefined) fail('root spawn returned no pid')

let reported: { descendants: number[] } | undefined
let settled = false
root.stdout?.on('data', (chunk: Buffer) => {
  if (settled) return
  const line = chunk.toString().trim()
  if (!line.startsWith('{')) return
  try {
    const parsed = JSON.parse(line) as { descendants?: unknown }
    if (!Array.isArray(parsed.descendants) || parsed.descendants.some(pid => typeof pid !== 'number')) return
    settled = true
    reported = { descendants: parsed.descendants as number[] }
  } catch {
    // A partial or non-JSON line; keep waiting for the report.
  }
})
let rootExited = false
let rootExitCode = -1
root.on('exit', (code) => { rootExited = true; rootExitCode = code ?? -1 })

const start = Date.now()
while (reported === undefined && !rootExited && Date.now() - start < REPORT_TIMEOUT_MS) {
  await new Promise(resolve => setTimeout(resolve, 100))
}
if (reported === undefined || reported.descendants.length !== 2) {
  killTree(control.pid)
  fail(rootExited
    ? `root exited before reporting (code ${String(rootExitCode)}): the containment install or child boot failed`
    : `root did not report within ${String(REPORT_TIMEOUT_MS)} ms (tsx/koffi boot too slow)`)
}
const [descA, descB] = reported.descendants
if (descA === undefined || descB === undefined) fail('root reported a malformed descendant list')
if (!alive(descA) || !alive(descB)) {
  killTree(control.pid)
  fail('a reported descendant was not alive when the root was killed')
}

// The event under test: an unexpected root death — one that does NOT let
// taskkill's own tree walk answer for the job.
killProcess(root.pid)
while (!rootExited) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
process.stdout.write(`d4-acceptance: root ${String(root.pid)} killed; waiting for job-contained descendants ${String(descA)}, ${String(descB)}\n`)

const deadline = Date.now() + DESCENDANT_GRACE_MS
while (Date.now() < deadline) {
  if (!alive(descA) && !alive(descB)) break
  await new Promise(resolve => setTimeout(resolve, 250))
}
const survivors = [descA, descB].filter(alive)
if (survivors.length > 0) {
  survivors.forEach(killTree)
  killTree(control.pid)
  fail(`contained descendants ${survivors.join(', ')} outlived the root's job handle close`)
}
if (!alive(control.pid)) {
  fail('the control process outside the job was killed; containment captured an unrelated process')
}
killTree(control.pid)
process.stdout.write('d4-acceptance: PASS — job-contained descendants died with the root; the unrelated control survived\n')
process.exit(0)
