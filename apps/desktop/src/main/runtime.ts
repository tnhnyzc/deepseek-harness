/**
 * The desktop runtime supervisor: Electron main owns the standalone Harness
 * runtime process — spawn, readiness, failure, restart, and shutdown — over
 * a fork IPC channel. The protocol is one typed message each way
 * (`runtime.ready` up, `runtime.shutdown` down); logs ride the piped stdio,
 * never the channel, and readiness is never inferred from a port.
 * @module @deepseek-ai/dsh-desktop/src/main/runtime
 */

import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import type {
  RuntimeCapabilities,
  RuntimeReadyPayload,
  RuntimeState,
  RuntimeStateView,
} from '../shared/runtime-state.ts'

export type { RuntimeStateView } from '../shared/runtime-state.ts'

/** Injection points for the supervisor. */
export interface RuntimeSupervisorOptions {
  /** The runtime entry script (forked, not spawned). */
  entry: string
  /** The bundled Node executable that runs the entry. */
  nodeExecutable: string
  /** The desktop-managed Harness home, passed to the child as DSH_HOME. */
  home: string
  /** The child's working directory; defaults to the entry's directory. */
  cwd?: string
  /** Extra environment variables merged over the curated child environment. */
  extraEnv?: Record<string, string>
  /** Parent-side grace before the forced kill; the child self-forces earlier. */
  gracefulTimeoutMs?: number
  /** Observes every state transition with the full view. */
  onStateChange?: (view: RuntimeStateView) => void
}

export interface RuntimeSupervisor {
  /** The current observable fact. */
  view(): RuntimeStateView
  /** Launch (or relaunch after failure) the runtime. */
  start(): void
  /** Gracefully stop the runtime; resolves at child exit. */
  stop(): Promise<void>
  /** User-triggered relaunch from a failed state. */
  requestRestart(): void
}

/** The legal state transitions; anything else throws (fail loud). */
const LEGAL_TRANSITIONS: Record<RuntimeState, readonly RuntimeState[]> = {
  stopped: ['starting'],
  starting: ['ready', 'stopping', 'failed'],
  ready: ['stopping', 'failed'],
  stopping: ['stopped'],
  failed: ['starting', 'stopped'],
}

/** The child self-forces at 5 s; the parent force-kills after this grace. */
const DEFAULT_GRACEFUL_TIMEOUT_MS = 7_500

/** Bounded retention of the runtime's output for failure diagnostics. */
const DIAGNOSTIC_BYTES = 64 * 1024
const DIAGNOSTIC_TAIL_LINES = 80

/** Bounded retention of the runtime's stdout/stderr. */
class DiagnosticRing {
  private chunks: string[] = []
  private size = 0

  push(chunk: string): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > DIAGNOSTIC_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      if (dropped !== undefined) this.size -= dropped.length
    }
  }

  tail(): string {
    return this.chunks.join('').split('\n').slice(-DIAGNOSTIC_TAIL_LINES).join('\n')
  }
}

/** Ambient names the runtime may inherit; everything else is withheld. */
const AMBIENT_ENV_NAMES = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SHELL',
] as const

/** Model credentials supplied by the user's environment; never argv. */
const CREDENTIAL_ENV_NAMES = [
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL',
] as const

/**
 * Build the child environment: a curated ambient slice, ambient model
 * credentials, and the desktop contract variables. Secrets never cross the
 * command line.
 * @param home - the desktop-managed Harness home.
 * @param ambient - the parent process environment to curate from.
 * @returns the complete child environment.
 */
function runtimeEnvironment(
  home: string,
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...AMBIENT_ENV_NAMES, ...CREDENTIAL_ENV_NAMES]) {
    const value = ambient[name]
    if (value !== undefined) env[name] = value
  }
  env.DSH_DESKTOP = '1'
  env.DSH_HOME = home
  return env
}

/**
 * Create the runtime supervisor.
 * @param options - entry, node executable, home, and injection points.
 * @returns the supervisor controller.
 */
export function createRuntimeSupervisor(options: RuntimeSupervisorOptions): RuntimeSupervisor {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS
  const diagnostics = new DiagnosticRing()
  let state: RuntimeState = 'stopped'
  let child: ChildProcess | undefined
  let ready: RuntimeReadyPayload | undefined
  let reason: string | undefined
  let autoRetried = false
  let spawnError = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  let stopResolve: (() => void) | undefined
  let stopPromise: Promise<void> | undefined

  const view = (): RuntimeStateView => ({
    state,
    ...(ready === undefined ? {} : { ready }),
    ...(reason === undefined ? {} : { reason }),
    ...(autoRetried ? { autoRetried: true } : {}),
    diagnostics: diagnostics.tail(),
  })

  const emit = (): void => {
    options.onStateChange?.(view())
  }

  const transition = (to: RuntimeState): void => {
    if (!LEGAL_TRANSITIONS[state].includes(to)) {
      throw new Error(`runtime: illegal state transition ${state} -> ${to}`)
    }
    state = to
    emit()
  }

  /**
   * Kill the runtime's whole process tree. On POSIX the child leads its own
   * process group (fork `detached`), so the negative-pid kill reaches the
   * runtime's descendants — subagent processes, shell tools — not only the
   * root; on Windows the task tree kill covers them.
   */
  const killTree = (): void => {
    const pid = child?.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // The process group already exited between the timer and the kill.
    }
  }

  const clearForceTimer = (): void => {
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer)
      forceTimer = undefined
    }
  }

  const finishStop = (): void => {
    clearForceTimer()
    if (state !== 'stopped') transition('stopped')
    child = undefined
    stopResolve?.()
    stopResolve = undefined
  }

  const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (state === 'stopping') {
      finishStop()
      return
    }
    if (state !== 'starting' && state !== 'ready') return
    reason = `runtime exited unexpectedly (${signal === null ? `code ${String(code)}` : `signal ${signal}`})`
    transition('failed')
    // One automatic retry is acceptable only when the runtime failed before
    // reaching ready, and only when the launch itself succeeded: a spawn
    // error (missing executable) will not repair itself by retrying.
    if (spawnError) return
    if (ready === undefined && !autoRetried) {
      autoRetried = true
      transition('starting')
      spawnChild()
    }
  }

  const spawnChild = (): void => {
    spawnError = false
    child = fork(options.entry, [], {
      execPath: options.nodeExecutable,
      execArgv: [],
      cwd: options.cwd ?? dirname(options.entry),
      env: { ...runtimeEnvironment(options.home), ...options.extraEnv },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Own process group on POSIX so the forced kill reaches descendants.
      detached: process.platform !== 'win32',
    })
    const wired = child
    wired.stdout?.on('data', (chunk: Buffer) => { diagnostics.push(chunk.toString()) })
    wired.stderr?.on('data', (chunk: Buffer) => { diagnostics.push(chunk.toString()) })
    wired.on('message', (message: { type?: unknown; runtimeVersion?: unknown; dshVersion?: unknown; capabilities?: unknown } | null) => {
      if (message === null || typeof message !== 'object' || message.type !== 'runtime.ready' || state !== 'starting') return
      ready = {
        runtimeVersion: String(message.runtimeVersion),
        dshVersion: String(message.dshVersion),
        capabilities: message.capabilities as RuntimeCapabilities,
      }
      reason = undefined
      transition('ready')
    })
    wired.on('error', (error) => {
      if (state !== 'starting') return
      spawnError = true
      reason = `failed to launch runtime: ${error.message}`
      transition('failed')
    })
    wired.on('exit', (code, signal) => { handleExit(code, signal) })
  }

  const start = (): void => {
    if (state !== 'stopped' && state !== 'failed') {
      throw new Error(`runtime: start requested from state ${state}`)
    }
    // A user- or app-initiated launch gets a fresh retry budget.
    autoRetried = false
    transition('starting')
    ready = undefined
    reason = undefined
    spawnChild()
  }

  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise
    if (state !== 'ready' && state !== 'starting') return Promise.resolve()
    transition('stopping')
    stopPromise = new Promise<void>((resolve) => {
      stopResolve = resolve
    })
    if (child !== undefined && child.exitCode === null) {
      if (child.connected) child.send({ type: 'runtime.shutdown' })
      forceTimer = setTimeout(() => {
        if (state === 'stopping') killTree()
      }, gracefulTimeoutMs)
    } else {
      finishStop()
    }
    return stopPromise
  }

  const requestRestart = (): void => {
    if (state !== 'failed') throw new Error(`runtime: restart requested from state ${state}`)
    start()
  }

  return { view, start, stop, requestRestart }
}
