/**
 * Standalone DeepSeek Harness runtime entry for the desktop supervisor.
 * Boots the web profile composition without the HTTP serving rows, reports
 * readiness over the fork IPC channel, and disposes the whole Cordis tree on
 * a `runtime.shutdown` message, SIGTERM, or supervisor death. Readiness is
 * the settled boot itself — no port probe, no stdout parsing.
 * @module @deepseek-ai/dsh-desktop-runtime
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { bootGraphMessage, createClientBundleFetch } from './boot-graph.ts'
import { composeDesktopPatches, prepareDesktopProfile, PROFILE_ROOT_FILENAME } from './composition.ts'
import { createNativeBridge, NativeError } from './native-bridge.ts'
import { createProcessShutdown } from './shutdown.ts'
import { CONTAINMENT_MODES, installWindowsProcessContainment, type WindowsProcessContainment } from './windows-job.ts'
import { attachTransportRuntime, type FetchDispatch } from './transport-runtime.ts'
import { createProcessTransportPort } from './transport-process.ts'

const BIN_NAME = 'dsh-desktop-runtime'

/** Absolute path of this runtime's package.json (both anchors: src/ and dist/ sit one level under apps/desktop-runtime). */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

/** The `dsh-base` bundle pins the Harness release this composition boots. */
const DSH_BASE_MANIFEST = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-base/package.json', import.meta.url))

/** The one readiness fact the supervisor consumes; it never parses stdout. */
export interface RuntimeReadyMessage {
  type: 'runtime.ready'
  runtimeVersion: string
  dshVersion: string
  capabilities: { apiProxy: boolean; httpServer: boolean }
}

/**
 * D4 acceptance report (Windows only, `DSH_D4_ACCEPTANCE=1`): published
 * after the job containment installed and before the composition boots.
 * `product-job` mode names the two long-lived descendants the contained
 * root spawned — by birth they are members of the root's job — and the
 * acceptance harness waits for readiness, force-kills the root with a
 * single-process kill, and the OS must end both descendants when the last
 * job handle closes. `externally-contained` mode reports the fallback: no
 * product job exists, there are no contained descendants to drill, and the
 * harness must not count the run as a D4 validation.
 */
export interface RuntimeD4ReportMessage {
  type: 'd4.acceptance-report'
  mode: 'product-job' | 'externally-contained'
  /** Present in `product-job` mode only: the two long-lived descendants. */
  descendants?: number[]
}

/**
 * Packaged-app smoke facts (test-only, `DSH_DESKTOP_SMOKE=1`): two bounded
 * probes over the production native channel. `channelRoundTrip` is a
 * structurally invalid path the shell's strict parser must return as
 * `malformed-request` — a full request→response cycle with no OS
 * involvement, identical on every platform. `nativeOpenPath` is the
 * product operation on a path guaranteed not to exist: it must settle as
 * the channel's `open-failed` failure where the OS settles at all; a host
 * that cannot settle `openPath` (headless, no file handler) records
 * `probe-aborted` when the bound fires, and a success means the probe path
 * materialized and the smoke must fail.
 */
export interface RuntimeSmokeReportMessage {
  type: 'runtime.smoke-report'
  channelRoundTrip: { code: string }
  nativeOpenPath: { ok: boolean; code?: string; message?: string }
}

/** The D4 descendants stay alive this long; the harness kills the root first. */
const D4_SLEEP_MS = 120_000

/** Read a checked-in manifest's version, failing loud when absent. */
function readVersion(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') {
    throw new Error(`${BIN_NAME}: missing package.json version at ${manifestPath}`)
  }
  return manifest.version
}

/** Derive the readiness payload from the settled boot context. */
function readyMessage(ctx: Context): RuntimeReadyMessage {
  return {
    type: 'runtime.ready',
    runtimeVersion: readVersion(INSTALL_ANCHOR),
    dshVersion: readVersion(DSH_BASE_MANIFEST),
    capabilities: {
      apiProxy: ctx.get('apiProxy') !== undefined,
      httpServer: ctx.get('webServer') !== undefined,
    },
  }
}

async function main(): Promise<void> {
  if (process.send === undefined) {
    process.stderr.write(`${BIN_NAME}: must be started through the desktop supervisor with an IPC channel\n`)
    process.exit(1)
  }
  let dispose: () => Promise<void> = () => Promise.resolve()
  const shutdown = createProcessShutdown(() => dispose())
  const stop = (code: number): void => { shutdown.interrupt(code) }
  const transportPort = createProcessTransportPort()
  const nativeBridge = createNativeBridge()
  let transportDispose: (() => void) | undefined
  process.on('SIGTERM', () => { stop(0) })
  process.on('SIGINT', () => { stop(130) })
  process.on('message', (message: { type?: unknown } | null) => {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'runtime.shutdown') stop(0)
    if (message.type === 'runtime.transport-closed') transportPort.close()
  })
  // The supervisor died: dispose the tree and exit cleanly instead of
  // orphaning the work, without the stop decision's forced exit.
  process.on('disconnect', () => { void shutdown.shutdown(0) })
  const environment = loadLayeredEnv(BIN_NAME)
  const uninstall = installFailLoud(BIN_NAME, process, () => dispose())
  let containment: WindowsProcessContainment | undefined
  try {
    // D4 containment installs before the composition boots, so before any
    // descendant process can exist: on Windows the whole descendant tree
    // dies with this process (job object, KILL_ON_JOB_CLOSE); elsewhere the
    // controller is a no-op (the supervisor owns process-group cleanup).
    // A failure here fails the boot loud: a contained runtime is a desktop
    // invariant, not a best effort.
    containment = await installWindowsProcessContainment()
    if (containment.mode === CONTAINMENT_MODES.externallyContained) {
      // Loud and structured: the boot continues (the OS keeps the tree
      // contained in the outer job) but D4 must never be read as validated
      // in this mode — an externally owned job does not carry the
      // product's generation-scoped KILL_ON_JOB_CLOSE semantics.
      const flags = containment.outerJobLimitFlags
      process.stderr.write(
        `${BIN_NAME}: d4 fallback: this process tree is already a member of an externally owned Job Object `
        + `(outer job limit flags: ${flags !== undefined ? `0x${flags.toString(16)}` : 'not queryable from here'}). `
        + 'The product Job Object is NOT installed and D4 is NOT validated in this mode; the outer job owns tree containment.\n',
      )
    }
    // D4 acceptance (Windows only): with the job already installed, the
    // contained root proves the kernel contract — two long-lived
    // descendants join the job by birth, their pids are reported, and the
    // harness force-kills this root with a single-process kill; the OS must
    // end both descendants when the last job handle closes. In fallback
    // mode there is no product job to drill: the report says so and the
    // harness must not count the run as a D4 validation.
    if (process.platform === 'win32' && process.env.DSH_D4_ACCEPTANCE === '1') {
      if (containment.mode === CONTAINMENT_MODES.externallyContained) {
        process.send({ type: 'd4.acceptance-report', mode: 'externally-contained' } satisfies RuntimeD4ReportMessage)
      } else {
        const descendants = [0, 1].map(() => {
          const sleeper = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${String(D4_SLEEP_MS)})`], { stdio: 'ignore' })
          if (sleeper.pid === undefined) throw new Error(`${BIN_NAME}: D4 descendant spawn returned no pid`)
          return sleeper.pid
        })
        process.send({ type: 'd4.acceptance-report', mode: 'product-job', descendants } satisfies RuntimeD4ReportMessage)
      }
    }
    const home = resolveDshHome()
    const profile = prepareDesktopProfile(INSTALL_ANCHOR, home)
    const homePatches = loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []
    const { patches } = composeDesktopPatches(profile, homePatches, SHIPPED_PRESET_ROOT)
    const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME)
    const ctx = await boot(BIN_NAME, rootConfig, structuredClone(patches), (hostCtx) => {
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      provideCmdline(hostCtx, { args: [], exit: (code) => { void shutdown.shutdown(code) } })
      // The desktop native seats: the directory-picker native capability and
      // the gateway's default-application opener both cross to Electron main
      // over the native channel. Text-file opening keeps the DSH native
      // opener: the pinned Electron shell API has no text-editor intent.
      hostCtx.provide('desktopDirectoryPick', (signal: AbortSignal) => nativeBridge.pickDirectory(signal))
      hostCtx.provide('nativeOpeners', {
        openPath: (path: string, signal: AbortSignal) => nativeBridge.openPath(path, signal),
      })
    })
    const apiProxy = ctx.get('apiProxy')
    if (apiProxy === undefined) throw new Error('boot settled without the apiProxy service; the desktop runtime cannot serve transport')
    // The client boot table composes the __DSH_BOOT__ graph and owns the
    // bundle paths; without it the renderer cannot boot the DSH client tree.
    const clientModules = ctx.get('clientModules')
    if (clientModules === undefined) {
      throw new Error('boot settled without the clientModules service; the desktop runtime cannot serve the client boot graph')
    }
    // The host Connection service contributes the in-process RPC interceptor
    // dispatch (the Typert gateway) ahead of the API proxy fallback; without
    // it the fetch channel is the bare carrier.
    const connection = ctx.get('connection') as HostConnectionService | undefined
    const apiHandler = toFetchHandler(apiProxy)
    const bundleFetch = createClientBundleFetch(clientModules)
    const unaryHandler = connection !== undefined
      ? connection.createSharedFetchHandler('/api', apiHandler)
      : apiHandler
    const fetchDispatch: FetchDispatch = (request) => {
      const pathname = new URL(request.url).pathname
      return request.method === 'GET' && pathname.startsWith('/plugins/')
        ? bundleFetch(request)
        : unaryHandler.fetch(request)
    }
    transportDispose = attachTransportRuntime(transportPort, apiProxy, { fetchDispatch })
    dispose = () => {
      // Containment releases with the tree: any member that outlived the
      // dispose dies when the job handle closes.
      containment?.release()
      nativeBridge.dispose()
      transportDispose?.()
      return ctx.fiber.dispose()
    }
    // The entry refuses to run without an IPC channel (above), so the
    // readiness fact goes over it unconditionally. The boot artifacts precede
    // the readiness fact on the same ordered channel: the supervisor caches
    // them before it may report the runtime ready.
    process.send(bootGraphMessage(clientModules))
    process.send(readyMessage(ctx))
    // Packaged-app smoke (test-only): one real native round trip over the
    // production channel, reported to the supervisor beside readiness.
    if (process.env.DSH_DESKTOP_SMOKE === '1') {
      // Probe 1: the deterministic channel round trip. A structurally
      // invalid path (NUL byte) is rejected by the shell's strict parser
      // and returned as `malformed-request` over the channel — a full
      // request→response cycle with no OS involvement. A channel that
      // cannot round trip never answers, and the bound records `unknown`.
      const channelProbe = new AbortController()
      const abortChannelProbe = setTimeout(() => channelProbe.abort(), 10_000)
      let channelRoundTrip: { code: string }
      try {
        await nativeBridge.openPath('dsh-smoke\u0000probe', channelProbe.signal)
        channelRoundTrip = { code: 'unexpected-success' }
      } catch (error) {
        channelRoundTrip = { code: error instanceof NativeError ? String(error.code) : 'unknown' }
      } finally {
        clearTimeout(abortChannelProbe)
      }
      // Probe 2: the product's own operation on a path guaranteed not to
      // exist, bound so a host where the OS cannot settle openPath records
      // `probe-aborted` instead of the OS verdict.
      const probePath = join(home, `dsh-smoke-absent-${String(process.pid)}-${String(Date.now())}`)
      const probe = new AbortController()
      const abortProbe = setTimeout(() => probe.abort(), 15_000)
      let nativeOpenPath: { ok: boolean; code?: string; message?: string }
      try {
        await nativeBridge.openPath(probePath, probe.signal)
        nativeOpenPath = { ok: true }
      } catch (error) {
        nativeOpenPath = {
          ok: false,
          code: probe.signal.aborted ? 'probe-aborted' : error instanceof NativeError ? String(error.code) : 'unknown',
          message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
        }
      } finally {
        clearTimeout(abortProbe)
      }
      process.send({ type: 'runtime.smoke-report', channelRoundTrip, nativeOpenPath } satisfies RuntimeSmokeReportMessage)
    }
  } catch (error) {
    uninstall()
    containment?.release()
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${BIN_NAME}: boot failed: ${detail}\n`)
    process.exit(1)
  }
}

void main()
