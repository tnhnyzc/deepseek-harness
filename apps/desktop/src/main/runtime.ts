/**
 * The desktop runtime supervisor: Electron main owns the standalone Harness
 * runtime process — spawn, readiness, failure, restart, and shutdown — over
 * a fork IPC channel. The protocol is one typed message each way
 * (`runtime.ready` up, `runtime.shutdown` down); logs ride the piped stdio,
 * never the channel, and readiness is never inferred from a port. An
 * unexpected root death also ends the dead generation's surviving
 * descendants (its own process group on POSIX; its parentage tree
 * best-effort on Windows) before any replacement generation may spawn.
 * @module @deepseek-ai/dsh-desktop/src/main/runtime
 */

import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { isNativeAbortMessage, isNativeRequestMessage } from '@deepseek-ai/dsh-desktop-runtime/native'
import { fromOpaqueTransportWire, isTransportMessage, toOpaqueTransportWire } from '@deepseek-ai/dsh-desktop-runtime/transport'
import type {
  DshBootPayload,
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

/**
 * The supervisor's half of the transport channel. Node `child_process`
 * cannot transfer a `MessagePort`, so the runtime child receives transport
 * messages over the existing structured-clone IPC channel; this surface
 * relays them. Handlers registered with `onMessage`/`onClose` stay installed
 * until the current child exits (the broker's channel is per-generation: a
 * restart ends it, and the renderer re-opens the transport).
 */
export interface RuntimeTransport {
  /** Send one transport message to the live child; a no-op when not connected. */
  send(value: object): void
  /** Relay inbound transport messages (control messages are not included). */
  onMessage(handler: (value: object) => void): void
  /** Fired once when the current child exits, tearing the channel down. */
  onClose(handler: () => void): void
  /** Ask the runtime to end its transport operations (renderer side went away). */
  closeChannel(): void
}

/**
 * The supervisor's half of the native capability channel: the child issues
 * `native.request` and `native.abort` messages over the same fork IPC
 * channel, and responses and cancels ride back through `send`. Like the
 * transport relay, the close handler stays installed across generations;
 * child exit fires `onClose`, ending the generation's channel.
 */
interface RuntimeNative {
  /** Send one native response or cancel to the live child; a no-op when not connected. */
  send(value: object): void
  /** Relay inbound native requests and aborts (transport and control messages are not included). */
  onMessage(handler: (value: object) => void): void
  /** Fired once when the current child exits, tearing the generation's channel down. */
  onClose(handler: () => void): void
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
  /**
   * The current generation's client-boot payload (boot graph, loader
   * facade, preload bundle urls), published by the runtime before it
   * reports ready; `undefined` while none is cached for the live child.
   */
  bootPayload(): DshBootPayload | undefined
  /** The transport channel relay surface for the dumb broker. */
  transport: RuntimeTransport
  /** The native capability channel relay surface. */
  native: RuntimeNative
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

/**
 * The boot-graph wire bounds. The child's publication crosses a wire
 * boundary into the supervisor's cache (and then to the renderer), so its
 * fields are bound-checked like any other inbound message: an over-bound
 * payload is dropped whole, and the generation simply reports no boot
 * artifacts instead of forcing an allocation on the main process.
 */
const BOOT_GRAPH_MAX_SCRIPT_CHARS = 1024 * 1024
const BOOT_GRAPH_MAX_LIST_ITEMS = 256
const BOOT_GRAPH_MAX_URL_CHARS = 8192
const BOOT_GRAPH_MAX_REVISION_CHARS = 128

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
  let bootPayload: DshBootPayload | undefined
  let reason: string | undefined
  let autoRetried = false
  let spawnError = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  let stopResolve: (() => void) | undefined
  let stopPromise: Promise<void> | undefined
  let transportMessageHandler: ((value: object) => void) | undefined
  let transportCloseHandler: (() => void) | undefined
  let nativeMessageHandler: ((value: object) => void) | undefined
  let nativeCloseHandler: (() => void) | undefined

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

  /**
   * End the dead generation's surviving descendants. Only an unexpected
   * root death calls this, synchronously in the exit handler and before any
   * replacement generation may spawn: on POSIX the dead root led its own
   * process group, so the group signal is addressed to exactly the dead
   * generation (no live process can share or re-acquire that group id
   * before this call returns), and ESRCH means nothing survived; on
   * Windows the dead root's parentage tree is walked best-effort, because
   * taskkill /T resolves its root as a live process and cannot walk a dead
   * one. DSH's own detached command trees — each its own group by the
   * pinned subprocess design — are outside the dead root's group by design
   * and outlive the crash as self-contained orphans, the same exposure the
   * CLI has when it is killed mid-command.
   * @param deadPid - the dead root's pid, captured before the child pointer moved.
   * @param exitEpochMs - the death instant; Windows descendants created after it belong to a newer generation.
   */
  const killDeadGenerationTree = (deadPid: number, exitEpochMs: number): void => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-deadPid, 'SIGKILL')
      } catch {
        // ESRCH: no member of the dead generation's group outlived the root.
      }
      return
    }
    // The parentage edges of a dead root survive in the process table
    // (Windows does not re-parent orphans), so walk them: every live
    // descendant created before the root's exit is force-stopped. The
    // creation-time cut structurally excludes a replacement generation.
    const script = [
      `$root = ${deadPid}`,
      `$exitUtc = [datetime]::new(1970, 1, 1, 0, 0, 0, [datetimekind]::Utc).AddMilliseconds(${exitEpochMs})`,
      '$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue',
      '$kids = @{}',
      'foreach ($p in $procs) {',
      '  if ($null -eq $p.ParentProcessId) { continue }',
      '  if ($kids.ContainsKey($p.ParentProcessId)) { $kids[$p.ParentProcessId] = $kids[$p.ParentProcessId] + $p.ProcessId }',
      '  else { $kids[$p.ParentProcessId] = ,@($p.ProcessId) }',
      '}',
      '$descendants = [System.Collections.Generic.HashSet[int32]]::new()',
      '$queue = [System.Collections.Generic.Queue[int32]]::new()',
      '$queue.Enqueue($root)',
      'while ($queue.Count -gt 0) {',
      '  $current = $queue.Dequeue()',
      '  if (-not $descendants.Add($current)) { continue }',
      '  $children = $kids[$current]',
      '  if ($null -ne $children) {',
      '    foreach ($child in $children) { if (-not $descendants.Contains($child)) { $queue.Enqueue($child) } }',
      '  }',
      '}',
      '$descendants.Remove($root) | Out-Null',
      'foreach ($descendant in $descendants) {',
      '  try {',
      '    $process = Get-Process -Id $descendant -ErrorAction Stop',
      '    if ($process.StartTime.ToUniversalTime() -lt $exitUtc) { Stop-Process -Id $descendant -Force -ErrorAction SilentlyContinue }',
      '  } catch {',
      '  }',
      '}',
    ].join('\n')
    try {
      const worker = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore', windowsHide: true })
      worker.unref()
    } catch {
      // No PowerShell: cleanup stays best-effort; the orphans remain and
      // the failure state is already reported.
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
    // The dead generation's process identity, captured before any handler
    // clearing or replacement spawn can move the child pointer: its
    // descendant cleanup must stay bound to this dead root, never to a
    // generation that replaces it.
    const deadPid = child?.pid
    // The channel is per-generation: any exit ends it, whatever the state.
    const close = transportCloseHandler
    const nativeClose = nativeCloseHandler
    transportMessageHandler = undefined
    transportCloseHandler = undefined
    nativeMessageHandler = undefined
    nativeCloseHandler = undefined
    bootPayload = undefined
    close?.()
    nativeClose?.()
    if (state === 'stopping') {
      finishStop()
      return
    }
    if (state !== 'starting' && state !== 'ready') return
    reason = `runtime exited unexpectedly (${signal === null ? `code ${String(code)}` : `signal ${signal}`})`
    transition('failed')
    // The dead root's surviving descendants are supervisor-owned cleanup:
    // run synchronously here so the dead group id cannot be recycled under
    // the replacement child the pre-ready retry is about to spawn.
    if (deadPid !== undefined) killDeadGenerationTree(deadPid, Date.now())
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
    wired.on('message', (message: {
      type?: unknown
      runtimeVersion?: unknown
      dshVersion?: unknown
      capabilities?: unknown
    } | null) => {
      if (message !== null && typeof message === 'object' && isTransportMessage(message)) {
        // The child edge encodes byte fields; restore them for the broker.
        const decoded = fromOpaqueTransportWire(message)
        if (decoded !== null) transportMessageHandler?.(decoded)
        return
      }
      if (message !== null && typeof message === 'object' && (isNativeRequestMessage(message) || isNativeAbortMessage(message))) {
        // The native capability channel: OS capability requests and caller aborts only.
        nativeMessageHandler?.(message)
        return
      }
      if (message === null || typeof message !== 'object') return
      // The boot artifacts precede readiness on the ordered channel; cache
      // them for the pull before the generation may report ready.
      if (message.type === 'runtime.boot-graph') {
        if (state === 'starting') bootPayload = parseBootGraphMessage(message)
        return
      }
      if (message.type !== 'runtime.ready' || state !== 'starting') return
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
    bootPayload = undefined
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

  const sendToChild = (value: object): void => {
    const wired = child
    if (wired === undefined || !wired.connected || wired.exitCode !== null) return
    // The child edge drops typed arrays; encode byte fields before send.
    wired.send(toOpaqueTransportWire(value))
  }

  const transport: RuntimeTransport = {
    send: sendToChild,
    onMessage: (handler) => { transportMessageHandler = handler },
    onClose: (handler) => { transportCloseHandler = handler },
    closeChannel: () => { sendToChild({ type: 'runtime.transport-closed' }) },
  }

  const native: RuntimeNative = {
    send: sendToChild,
    onMessage: (handler) => { nativeMessageHandler = handler },
    onClose: (handler) => { nativeCloseHandler = handler },
  }

  return {
    view,
    start,
    stop,
    requestRestart,
    bootPayload: () => bootPayload,
    transport,
    native,
  }
}

/** The bounded-string check: a string at or under the bound, nothing else. */
function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Wire validation for the child's boot-artifact publication: the renderer
 * re-parses the graph through the pinned manifest parser, so the supervisor
 * only checks the shape it caches and serves — plus the protocol's field
 * bounds, so an over-bound publication is dropped at the wire.
 * @param message - the raw `runtime.boot-graph` child message.
 * @returns the validated payload, or `undefined` when the shape or a field
 * bound is not the boot-artifact message (dropped silently; a generation
 * without it simply reports none).
 */
export function parseBootGraphMessage(message: unknown): DshBootPayload | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const candidate = message as Record<string, unknown>
  const graph = candidate.graph
  if (typeof graph !== 'object' || graph === null) return undefined
  const graphValue = graph as Record<string, unknown>
  if (!boundedString(graphValue.rev, BOOT_GRAPH_MAX_REVISION_CHARS) || !Array.isArray(graphValue.entries)) return undefined
  if (graphValue.entries.length > BOOT_GRAPH_MAX_LIST_ITEMS) return undefined
  for (const row of graphValue.entries) {
    if (typeof row !== 'object' || row === null) return undefined
    const entry = row as Record<string, unknown>
    if (!boundedString(entry.id, BOOT_GRAPH_MAX_URL_CHARS) || !boundedString(entry.url, BOOT_GRAPH_MAX_URL_CHARS)
      || !boundedString(entry.rev, BOOT_GRAPH_MAX_REVISION_CHARS)) return undefined
    if (entry.external !== undefined
      && (!Array.isArray(entry.external) || entry.external.length > BOOT_GRAPH_MAX_LIST_ITEMS
        || entry.external.some(name => !boundedString(name, BOOT_GRAPH_MAX_URL_CHARS)))) return undefined
  }
  if (!boundedString(candidate.moduleLoaderScript, BOOT_GRAPH_MAX_SCRIPT_CHARS)) return undefined
  if (!Array.isArray(candidate.preloadBundles) || candidate.preloadBundles.length > BOOT_GRAPH_MAX_LIST_ITEMS
    || candidate.preloadBundles.some(url => !boundedString(url, BOOT_GRAPH_MAX_URL_CHARS))) return undefined
  return {
    graph: graph as DshBootPayload['graph'],
    moduleLoaderScript: candidate.moduleLoaderScript,
    preloadBundles: candidate.preloadBundles as string[],
  }
}
