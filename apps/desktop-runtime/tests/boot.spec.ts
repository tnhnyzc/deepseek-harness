/**
 * Real-boot acceptance for the desktop runtime: forks the built entry under
 * a temporary desktop-managed home, asserts the readiness fact, the absent
 * web server, the home isolation, and the bounded graceful shutdown.
 * Self-skips when the entry has not been built (`pnpm run build`).
 */

import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ENTRY = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const RUNTIME_CWD = resolve(import.meta.dirname, '..')
const READY_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 30_000

/** The web fallback port the disabled webserver row would bind. */
const WEB_FALLBACK_PORT = 3080

interface ReadyPayload {
  type: 'runtime.ready'
  runtimeVersion: string
  dshVersion: string
  capabilities: { apiProxy: boolean; httpServer: boolean }
}

function forkRuntime(home: string): ChildProcess {
  return fork(ENTRY, [], {
    execPath: process.execPath,
    execArgv: [],
    cwd: RUNTIME_CWD,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DSH_DESKTOP: '1',
      DSH_HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
}

function waitForReady(child: ChildProcess): Promise<ReadyPayload> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`runtime did not report ready within ${String(READY_TIMEOUT_MS)} ms`))
    }, READY_TIMEOUT_MS)
    child.on('message', (message: ReadyPayload) => {
      if (message !== null && typeof message === 'object' && message.type === 'runtime.ready') {
        clearTimeout(timer)
        resolveReady(message)
      }
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`runtime exited before ready (code ${String(code)}, signal ${String(signal)})`))
    })
  })
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit) => {
    child.on('exit', (code) => { resolveExit(code) })
  })
}

/** Whether anything listens on the loopback port (the no-web-server proof). */
function portIsListening(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    createConnection(port, '127.0.0.1')
      .on('connect', () => {
        resolveProbe(true)
      })
      .on('error', () => {
        resolveProbe(false)
      })
  })
}

describe.skipIf(!existsSync(ENTRY))('desktop runtime boot', () => {
  let home: string
  let child: ChildProcess
  let ready: ReadyPayload

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
    child = forkRuntime(home)
    ready = await waitForReady(child)
  }, READY_TIMEOUT_MS + 10_000)

  afterAll(async () => {
    if (child.exitCode === null && child.kill()) {
      await waitForExit(child)
    }
  }, SHUTDOWN_TIMEOUT_MS)

  it('reports the readiness fact over IPC with the pinned versions', () => {
    expect(ready.type).toBe('runtime.ready')
    expect(ready.runtimeVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(ready.dshVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(ready.capabilities).toEqual({ apiProxy: true, httpServer: false })
  })

  it('mounts no localhost web server', async () => {
    await expect(portIsListening(WEB_FALLBACK_PORT)).resolves.toBe(false)
  })

  it('confines all runtime state to the desktop-managed home', () => {
    const profileDir = join(home, 'profiles', 'web')
    for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      expect(readFileSync(join(profileDir, file), 'utf8')).toBeTruthy()
    }
    expect(readdirSync(join(home, 'profiles')).filter(name => name !== 'node_modules')).toEqual(['web'])
  })

  it('disposes the whole tree on runtime.shutdown and exits 0', async () => {
    const exitCode = waitForExit(child)
    child.send({ type: 'runtime.shutdown' })
    await expect(exitCode).resolves.toBe(0)
  }, SHUTDOWN_TIMEOUT_MS)
})
