/**
 * Supervisor behavior over the real fork IPC channel, driven by the
 * runtime fixture: the state machine, readiness, death, the single
 * automatic pre-ready retry, spawn errors, graceful shutdown, the forced
 * process-tree kill for a runtime that refuses to stop, and the
 * dead-generation descendant cleanup for an unexpected root death.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRuntimeSupervisor, type RuntimeSupervisor, type RuntimeStateView } from '../src/main/runtime.ts'

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'runtime-fixture.mjs')

let workDir: string

function nextFlagFile(): string {
  return join(workDir, `flag-${String(Date.now())}-${String(Math.random()).slice(2)}`)
}

function createSupervisor(
  mode: string,
  overrides: { nodeExecutable?: string; gracefulTimeoutMs?: number; flagFile?: string } = {},
): { supervisor: RuntimeSupervisor; events: RuntimeStateView[] } {
  const events: RuntimeStateView[] = []
  const home = join(workDir, `home-${String(Date.now())}-${Math.random().toString(16).slice(2)}`)
  const supervisor = createRuntimeSupervisor({
    entry: FIXTURE,
    nodeExecutable: overrides.nodeExecutable ?? process.execPath,
    cwd: workDir,
    home,
    extraEnv: {
      FIXTURE_MODE: mode,
      ...(overrides.flagFile === undefined ? {} : { FIXTURE_FLAG_FILE: overrides.flagFile }),
    },
    gracefulTimeoutMs: overrides.gracefulTimeoutMs ?? 15_000,
    onStateChange: (view) => { events.push(view) },
  })
  return { supervisor, events }
}

function statesOf(events: RuntimeStateView[]): string[] {
  return events.map(view => view.state)
}

function waitForState(
  supervisor: RuntimeSupervisor,
  check: (view: RuntimeStateView) => boolean,
  timeoutMs = 15_000,
): Promise<RuntimeStateView> {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for state; last view: ${JSON.stringify(supervisor.view())}`))
    }, timeoutMs)
    const interval = setInterval(() => {
      const view = supervisor.view()
      if (check(view)) {
        clearTimeout(timer)
        clearInterval(interval)
        resolveWait(view)
      }
    }, 20)
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readGrandchildPid(flagFile: string): Promise<number> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      return Number(readFileSync(`${flagFile}.child`, 'utf8').trim())
    } catch {
      if (Date.now() > deadline) throw new Error('fixture never wrote its grandchild pid')
      await new Promise((resolveSleep) => { setTimeout(resolveSleep, 25) })
    }
  }
}

/** Poll until the pid is gone; the deadline names what the survival means. */
async function waitForGone(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (processAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${String(pid)} survived where it must have been cleaned up`)
    await new Promise((resolveSleep) => { setTimeout(resolveSleep, 25) })
  }
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-runtime-supervisor-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('runtime supervisor', () => {
  it('transitions stopped -> starting -> ready on the runtime.ready fact', async () => {
    const { supervisor, events } = createSupervisor('ok')
    supervisor.start()
    const view = await waitForState(supervisor, v => v.state === 'ready')
    expect(statesOf(events)).toEqual(['starting', 'ready'])
    expect(view.ready?.runtimeVersion).toBe('fixture')
    expect(view.ready?.capabilities).toEqual({ apiProxy: true, httpServer: false })
    await expect(supervisor.stop()).resolves.toBeUndefined()
    expect(supervisor.view().state).toBe('stopped')
  })

  it('marks failed with retained diagnostics when the runtime dies after ready', async () => {
    const { supervisor, events } = createSupervisor('crash')
    supervisor.start()
    const failed = await waitForState(supervisor, v => v.state === 'failed')
    expect(statesOf(events)).toEqual(['starting', 'ready', 'failed'])
    expect(failed.reason).toContain('code 3')
    expect(failed.diagnostics ?? '').toContain('fixture: boot ok (crash)')
    // No automatic retry after the runtime reached ready.
    await new Promise((resolveSleep) => { setTimeout(resolveSleep, 100) })
    expect(statesOf(events)).toEqual(['starting', 'ready', 'failed'])
  })

  it('recovers through a requested restart after an unexpected death', async () => {
    const flagFile = nextFlagFile()
    const { supervisor, events } = createSupervisor('crash-once', { flagFile })
    supervisor.start()
    await waitForState(supervisor, v => v.state === 'ready')
    const failed = await waitForState(supervisor, v => v.state === 'failed')
    expect(failed.reason).toContain('code 3')
    expect(statesOf(events)).toEqual(['starting', 'ready', 'failed'])
    supervisor.requestRestart()
    const revived = await waitForState(supervisor, v => v.state === 'ready')
    expect(statesOf(events)).toEqual(['starting', 'ready', 'failed', 'starting', 'ready'])
    expect(revived.reason).toBeUndefined()
    await expect(supervisor.stop()).resolves.toBeUndefined()
    expect(supervisor.view().state).toBe('stopped')
  })

  it('reports a signal death and retains the killed generation diagnostics across a restart', async () => {
    const { supervisor, events } = createSupervisor('kill')
    supervisor.start()
    await waitForState(supervisor, v => v.state === 'ready')
    const failed = await waitForState(supervisor, v => v.state === 'failed')
    expect(failed.reason).toContain('signal SIGKILL')
    expect(failed.diagnostics ?? '').toContain('fixture: boot ok (kill)')
    // No automatic retry after the runtime reached ready.
    expect(statesOf(events)).toEqual(['starting', 'ready', 'failed'])
    supervisor.requestRestart()
    const failedAgain = await waitForState(supervisor, v => v.state === 'failed')
    expect(statesOf(events)).toEqual(['starting', 'ready', 'failed', 'starting', 'ready', 'failed'])
    expect(failedAgain.reason).toContain('signal SIGKILL')
    // The ring spans generations: both deaths' output is retained in the
    // failed view, not wiped by the restart.
    const ring = failedAgain.diagnostics ?? ''
    const first = ring.indexOf('fixture: boot ok (kill)')
    expect(first).not.toBe(-1)
    expect(ring.indexOf('fixture: boot ok (kill)', first + 1)).not.toBe(-1)
  })

  it('consumes exactly one automatic retry when the runtime fails before ready', async () => {
    const flagFile = nextFlagFile()
    const { supervisor, events } = createSupervisor('fail-early', { flagFile })
    supervisor.start()
    const view = await waitForState(supervisor, v => v.state === 'ready')
    expect(statesOf(events)).toEqual(['starting', 'failed', 'starting', 'ready'])
    expect(view.autoRetried).toBe(true)
    await expect(supervisor.stop()).resolves.toBeUndefined()
  })

  it('does not auto-retry a spawn error and reports the launch failure', async () => {
    const { supervisor } = createSupervisor('ok', { nodeExecutable: join(workDir, 'missing-node') })
    supervisor.start()
    const failed = await waitForState(supervisor, v => v.state === 'failed')
    expect(failed.reason).toContain('failed to launch runtime')
    await new Promise((resolveSleep) => { setTimeout(resolveSleep, 100) })
    expect(supervisor.view().state).toBe('failed')
  })

  it('restarts a failed runtime on request', async () => {
    const flagFile = nextFlagFile()
    const { supervisor } = createSupervisor('fail-early', { flagFile })
    supervisor.start()
    await waitForState(supervisor, v => v.state === 'ready')
    await expect(supervisor.stop()).resolves.toBeUndefined()
    // A second lifecycle: the flag file now makes boot succeed.
    supervisor.start()
    await waitForState(supervisor, v => v.state === 'ready')
    await expect(supervisor.stop()).resolves.toBeUndefined()
  })

  it('requests from other states throw', async () => {
    const { supervisor } = createSupervisor('ok')
    expect(() => { supervisor.requestRestart() }).toThrow(/restart requested from state stopped/)
    supervisor.start()
    expect(() => { supervisor.requestRestart() }).toThrow(/restart requested from state starting/)
    expect(() => { supervisor.start() }).toThrow(/start requested from state starting/)
    await expect(supervisor.stop()).resolves.toBeUndefined()
    expect(supervisor.view().state).toBe('stopped')
  })

  it('graceful shutdown kills the runtime and its well-disposed descendants', async () => {
    const flagFile = nextFlagFile()
    const { supervisor } = createSupervisor('spawn-clean', { flagFile })
    supervisor.start()
    await waitForState(supervisor, v => v.state === 'ready')
    const grandchildPid = await readGrandchildPid(flagFile)
    expect(processAlive(grandchildPid)).toBe(true)
    await expect(supervisor.stop()).resolves.toBeUndefined()
    await new Promise((resolveSleep) => { setTimeout(resolveSleep, 100) })
    expect(processAlive(grandchildPid)).toBe(false)
    expect(supervisor.view().state).toBe('stopped')
  })

  it('force-kills the whole process tree when the runtime refuses graceful shutdown', async () => {
    const flagFile = nextFlagFile()
    const { supervisor } = createSupervisor('spawn-leaky', { flagFile, gracefulTimeoutMs: 750 })
    supervisor.start()
    await waitForState(supervisor, v => v.state === 'ready')
    const grandchildPid = await readGrandchildPid(flagFile)
    expect(processAlive(grandchildPid)).toBe(true)
    await expect(supervisor.stop()).resolves.toBeUndefined()
    await new Promise((resolveSleep) => { setTimeout(resolveSleep, 100) })
    expect(processAlive(grandchildPid)).toBe(false)
    expect(supervisor.view().state).toBe('stopped')
  })

  it('cleans the dead generation descendants when the root dies unexpectedly after ready', async () => {
    const flagFile = nextFlagFile()
    const { supervisor, events } = createSupervisor('crash-orphans', { flagFile })
    supervisor.start()
    await waitForState(supervisor, v => v.state === 'ready')
    const grandchildPid = await readGrandchildPid(flagFile)
    expect(processAlive(grandchildPid)).toBe(true)
    // Only the root exits: the fixture kills nothing, so the descendant
    // outlives the root and only supervisor-owned cleanup may end it.
    const failed = await waitForState(supervisor, v => v.state === 'failed')
    expect(statesOf(events)).toEqual(['starting', 'ready', 'failed'])
    expect(failed.reason).toContain('code 4')
    await waitForGone(grandchildPid)
    // No automatic retry after ready, and the user restart still boots a
    // healthy fresh generation.
    supervisor.requestRestart()
    await waitForState(supervisor, v => v.state === 'ready')
    expect(statesOf(events)).toEqual(['starting', 'ready', 'failed', 'starting', 'ready'])
    await expect(supervisor.stop()).resolves.toBeUndefined()
    expect(supervisor.view().state).toBe('stopped')
  })
})
