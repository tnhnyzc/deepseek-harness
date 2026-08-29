/**
 * D4 acceptance child: runs as the contained tree root. Installs the real
 * Windows job containment (real koffi, real kernel32 — including the
 * limit-layout size check), spawns two long-lived descendant processes,
 * reports their pids, and stays alive until the harness kills this root
 * with `taskkill /F` — the unexpected-root-death scenario.
 *
 * Launched by d4-acceptance.ts with `node --import tsx/esm` from the
 * repository root.
 */

import { spawn } from 'node:child_process'
import { installWindowsProcessContainment } from '../../desktop-runtime/src/windows-job.ts'

if (process.platform !== 'win32') {
  process.stderr.write('d4-acceptance-child: Windows-only gate\n')
  process.exit(2)
}

const containment = await installWindowsProcessContainment()
// The controller must stay referenced: release is what closes the job
// handle on a graceful end, and process exit is the backstop kill.
void containment

const descendants = [0, 1].map(() => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], { stdio: 'ignore' })
  if (child.pid === undefined) throw new Error('d4-acceptance-child: descendant spawn returned no pid')
  return child.pid
})
process.stdout.write(`${JSON.stringify({ descendants })}\n`)
// Stay alive: the harness's forced root kill is the event under test.
setInterval(() => {}, 120_000)
