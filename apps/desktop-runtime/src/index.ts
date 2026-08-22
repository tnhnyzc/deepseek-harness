/**
 * Standalone DeepSeek Harness runtime entry for the desktop supervisor.
 * Boots the web profile composition without the HTTP serving rows, reports
 * readiness over the fork IPC channel, and disposes the whole Cordis tree on
 * a `runtime.shutdown` message, SIGTERM, or supervisor death. Readiness is
 * the settled boot itself — no port probe, no stdout parsing.
 * @module @deepseek-ai/dsh-desktop-runtime
 */

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
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { composeDesktopPatches, prepareDesktopProfile, PROFILE_ROOT_FILENAME } from './composition.ts'
import { createProcessShutdown } from './shutdown.ts'

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
  process.on('SIGTERM', () => { stop(0) })
  process.on('SIGINT', () => { stop(130) })
  process.on('message', (message: { type?: unknown } | null) => {
    if (message !== null && typeof message === 'object' && message.type === 'runtime.shutdown') stop(0)
  })
  // The supervisor died: dispose the tree and exit cleanly instead of
  // orphaning the work, without the stop decision's forced exit.
  process.on('disconnect', () => { void shutdown.shutdown(0) })
  const environment = loadLayeredEnv(BIN_NAME)
  const uninstall = installFailLoud(BIN_NAME, process, () => dispose())
  try {
    const home = resolveDshHome()
    const profile = prepareDesktopProfile(INSTALL_ANCHOR, home)
    const homePatches = loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []
    const { patches } = composeDesktopPatches(profile, homePatches, SHIPPED_PRESET_ROOT)
    const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME)
    const ctx = await boot(BIN_NAME, rootConfig, structuredClone(patches), (hostCtx) => {
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      provideCmdline(hostCtx, { args: [], exit: (code) => { void shutdown.shutdown(code) } })
    })
    dispose = () => ctx.fiber.dispose()
    // The entry refuses to run without an IPC channel (above), so the
    // readiness fact goes over it unconditionally.
    process.send(readyMessage(ctx))
  } catch (error) {
    uninstall()
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${BIN_NAME}: boot failed: ${detail}\n`)
    process.exit(1)
  }
}

void main()
