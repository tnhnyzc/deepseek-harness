/**
 * Supervisor test fixture: a fake runtime process over the same fork IPC
 * protocol. Modes (env FIXTURE_MODE):
 *  ok             ready after a short delay; shutdown message exits 0
 *  crash          ready, then exits 3 on its own (a runtime death)
 *  crash-once     first launch (no flag file) exits 3 after ready; the flag
 *                 file it creates makes the next launch behave like ok
 *  kill           ready, then SIGKILLs itself (a signal death)
 *  fail-early     first launch (no flag file) exits 1 before ready; the flag
 *                 file it creates makes the next launch behave like ok
 *  spawn-clean    ready after spawning a grandchild; shutdown kills it
 *  spawn-leaky    ready after spawning a grandchild; shutdown ignores it
 *  hang-shutdown  ready, then ignores the shutdown message
 * The grandchild pid is written to `${FIXTURE_FLAG_FILE}.child` for tree
 * assertions. Plain ESM so any Node can run it.
 */

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const mode = process.env.FIXTURE_MODE ?? 'ok'
const flagFile = process.env.FIXTURE_FLAG_FILE ?? ''
const grandchildPidFile = flagFile === '' ? '' : `${flagFile}.child`

let grandchild

function sendReady() {
  if (process.connected) {
    process.send({
      type: 'runtime.ready',
      runtimeVersion: 'fixture',
      dshVersion: 'fixture',
      capabilities: { apiProxy: true, httpServer: false },
    })
  }
}

function spawnGrandchild() {
  grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore' })
  grandchild.on('spawn', () => {
    if (grandchildPidFile !== '' && grandchild.pid !== undefined) {
      writeFileSync(grandchildPidFile, String(grandchild.pid))
    }
  })
}

function handleShutdown() {
  if (mode === 'spawn-clean' && grandchild !== undefined) {
    grandchild.kill('SIGKILL')
  }
  process.exit(0)
}

process.on('message', (message) => {
  // spawn-leaky exits via the supervisor's forced tree kill, like
  // hang-shutdown: both refuse the graceful stop request.
  if (message !== null && typeof message === 'object' && message.type === 'runtime.shutdown'
    && mode !== 'hang-shutdown' && mode !== 'spawn-leaky') {
    handleShutdown()
  }
})

if (mode === 'fail-early' && flagFile !== '' && !existsSync(flagFile)) {
  writeFileSync(flagFile, '1')
  process.stderr.write('fixture: simulated boot failure\n')
  process.exit(1)
}

switch (mode) {
  case 'ok':
  case 'fail-early':
  case 'hang-shutdown':
    process.stderr.write(`fixture: boot ok (${mode})\n`)
    setTimeout(sendReady, 50)
    break
  case 'spawn-clean':
  case 'spawn-leaky':
    setTimeout(() => {
      spawnGrandchild()
      sendReady()
    }, 50)
    break
  case 'crash':
    process.stderr.write(`fixture: boot ok (${mode})\n`)
    setTimeout(() => {
      sendReady()
      setTimeout(() => { process.exit(3) }, 400)
    }, 50)
    break
  case 'crash-once':
    if (flagFile !== '' && !existsSync(flagFile)) {
      writeFileSync(flagFile, '1')
      process.stderr.write('fixture: boot ok (crash-once, first launch)\n')
      setTimeout(() => {
        sendReady()
        setTimeout(() => { process.exit(3) }, 400)
      }, 50)
    } else {
      process.stderr.write('fixture: boot ok (crash-once, retry)\n')
      setTimeout(sendReady, 50)
    }
    break
  case 'kill':
    process.stderr.write(`fixture: boot ok (${mode})\n`)
    setTimeout(() => {
      sendReady()
      setTimeout(() => { process.kill(process.pid, 'SIGKILL') }, 400)
    }, 50)
    break
  default:
    process.stderr.write(`fixture: unknown mode ${String(mode)}\n`)
    process.exit(2)
}
