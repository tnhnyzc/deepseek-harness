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
  capabilities: { connection: boolean; httpServer: boolean }
}

interface BootGraphPayload {
  type: 'runtime.boot-graph'
  graph: { rev: string; entries: Array<{ id: string; url: string; rev: string }> }
  moduleLoaderScript: string
  preloadBundles: string[]
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

function waitForReady(child: ChildProcess, messages: unknown[]): Promise<ReadyPayload> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`runtime did not report ready within ${String(READY_TIMEOUT_MS)} ms`))
    }, READY_TIMEOUT_MS)
    child.on('message', (message: ReadyPayload) => {
      if (message === null || typeof message !== 'object') return
      messages.push(message)
      if (message.type === 'runtime.ready') {
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
  const messages: unknown[] = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
    child = forkRuntime(home)
    ready = await waitForReady(child, messages)
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
    expect(ready.capabilities).toEqual({ connection: true, httpServer: false })
  })

  it('mounts no localhost web server', async () => {
    await expect(portIsListening(WEB_FALLBACK_PORT)).resolves.toBe(false)
  })

  it('publishes the client boot graph before the readiness fact', () => {
    // The renderer pulls the cached payload only after ready, so the
    // artifacts must arrive first on the ordered channel.
    const graphIndex = messages.findIndex(m => (m as { type?: unknown }).type === 'runtime.boot-graph')
    const readyIndex = messages.findIndex(m => (m as { type?: unknown }).type === 'runtime.ready')
    expect(graphIndex).toBeGreaterThanOrEqual(0)
    expect(readyIndex).toBeGreaterThan(graphIndex)
    const payload = messages[graphIndex] as BootGraphPayload
    expect(payload.graph.rev).toEqual(expect.any(String))
    expect(payload.graph.entries.length).toBeGreaterThan(0)
    for (const entry of payload.graph.entries) {
      expect(entry.id).toEqual(expect.any(String))
      expect(entry.url).toEqual(expect.any(String))
      expect(entry.rev).toEqual(expect.any(String))
    }
    // The facade script is the queue-mode module-loader global.
    expect(payload.moduleLoaderScript).toContain('__ModuleLoader__')
    // The parser preload is exactly the modules bundle: it owns the
    // module-system bootstrap face (createClientModuleSystem/apply) that the
    // deleted client-runtime package used to provide, so the shell boot can
    // create the system from this one bundle.
    expect(payload.preloadBundles).toHaveLength(1)
    expect(payload.preloadBundles[0]).toContain('@deepseek-ai/dsh-client-modules')
    // The graph must name the same bootstrap entry the preload serves.
    expect(payload.graph.entries.some(entry => entry.id === '@deepseek-ai/dsh-client-modules')).toBe(true)
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
