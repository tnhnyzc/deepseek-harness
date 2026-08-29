/**
 * The packaged desktop's Electron fuse configuration. Fuses are package-time
 * bits in the Electron binary; the OS code-signing validation then makes
 * them tamper-evident, so they are flipped before any signing and never
 * touched at runtime.
 *
 * Every fuse Electron 43 supports is declared explicitly
 * (`strictlyRequireAllFuses`): a future Electron adding a fuse must force a
 * decision here instead of silently inheriting a default.
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/fuses
 */

import { getCurrentFuseWire, flipFuses, FuseVersion, FuseV1Options, type FuseV1Config } from '@electron/fuses'
import { join } from 'node:path'

/**
 * The desktop's fuse decisions, one per fuse Electron 43 supports:
 *
 * - RunAsNode (off): the Electron process never runs as Node. The Harness
 *   runtime is a standalone Node binary the supervisor forks with an
 *   explicit `execPath` — the ELECTRON_RUN_AS_NODE dependency only applies
 *   when forking the Electron binary itself, which this app never does.
 * - EnableCookieEncryption (default, off): the app stores no cookies it
 *   depends on (the API channel is an in-process fetch, not an HTTP cookie
 *   jar). The flip is one-way and needs the macOS keychain, so it is taken
 *   when signed distribution turns on, not before.
 * - EnableNodeOptionsEnvironmentVariable (off): NODE_OPTIONS and
 *   NODE_EXTRA_CA_CERTS are not honored in the Electron process; the
 *   runtime child's environment is curated by the supervisor, and a
 *   tampered environment must not reach the shell's V8/Node.
 * - EnableNodeCliInspectArguments (off): --inspect / SIGUSR1 have no
 *   production use in a shipped app; they are a live-code path into the
 *   main process.
 * - EnableEmbeddedAsarIntegrityValidation (on): the packager writes the
 *   asar integrity entries; with the fuse, a tampered app.asar or its
 *   integrity metadata refuses to launch (macOS/Windows; a no-op on Linux,
 *   which the artifact matrix says so).
 * - OnlyLoadAppFromAsar (on): the app code (main + preload) loads only from
 *   app.asar, so the integrity validation cannot be bypassed through the
 *   app search path; the unpacked resources are data, not app code.
 * - LoadBrowserProcessSpecificV8Snapshot (default, off): the renderer has
 *   no nodeIntegration, so there is no renderer/main snapshot separation to
 *   buy; the fuse only costs main-process startup time.
 * - GrantFileProtocolExtraPrivileges (off): content is served from the
 *   private dsh-app:// scheme; file:// pages must keep no extra privileges
 *   (fetch, service workers, child-frame access).
 * - WasmTrapHandlers (default, on): not an attack surface — disabling it
 *   trades signal-trapped WebAssembly bounds checks for slower explicit
 *   checks with no security gain.
 */
export const DESKTOP_FUSES: Record<FuseV1Options, boolean> = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
}

/**
 * The numeric fuse indices Electron 43 supports, in wire order. A compiled
 * numeric enum's `Object.values` yields both directions (name and index), so
 * the indices are derived from the numeric keys only.
 */
export const DESKTOP_FUSE_INDICES = Object.keys(FuseV1Options)
  .filter(key => Number.isInteger(Number(key)))
  .map(key => Number(key) as FuseV1Options)

/** The flip request; all nine fuses are set, so no default can drift. */
export const DESKTOP_FUSE_CONFIG: FuseV1Config = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  ...Object.fromEntries(Object.entries(DESKTOP_FUSES).map(([key, value]) => [Number(key), value])),
} as unknown as FuseV1Config

/** The product name the artifact is built under. */
export const APP_PRODUCT_NAME = 'DeepSeek Harness Desktop'

/**
 * The main Electron binary inside a packaged artifact. The packager derives
 * every name from the product name with `filenamify`, which replaces only
 * filename-reserved characters — spaces survive — so the executable keeps
 * the product name verbatim on all platforms.
 * @param artifact - the `.app` bundle, Windows `.exe` directory, or Linux app directory.
 * @param platform - the packaged target platform.
 * @returns the absolute binary path to flip or inspect.
 */
export function electronBinaryPath(artifact: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return join(artifact, 'Contents', 'MacOS', APP_PRODUCT_NAME)
  if (platform === 'win32') return join(artifact, `${APP_PRODUCT_NAME}.exe`)
  return join(artifact, APP_PRODUCT_NAME)
}

/**
 * Flip the desktop fuses in a packaged binary. Must run before any
 * signature is applied: flipping invalidates the binary's signature.
 * @param binary - the packaged Electron binary path.
 * @returns the number of fuses flipped.
 */
export async function flipDesktopFuses(binary: string): Promise<number> {
  return flipFuses(binary, DESKTOP_FUSE_CONFIG)
}

/**
 * Read the fuse states actually present in a packaged binary — the packaged
 * test asserts these against {@link DESKTOP_FUSES}, not against the config
 * that was asked for.
 * @param binary - the packaged Electron binary path.
 * @returns the per-fuse states (48/49 byte values as booleans: 49 enabled).
 */
export async function readDesktopFuses(binary: string): Promise<Record<FuseV1Options, boolean>> {
  const wire = await getCurrentFuseWire(binary)
  // The wire is `{ version, [index]: 48|49|... }`; read the numeric index
  // entries as a plain record.
  const states = wire as unknown as Record<string, number | undefined>
  const result = {} as Record<FuseV1Options, boolean>
  for (const index of DESKTOP_FUSE_INDICES) {
    const value = states[String(index)]
    result[index] = value === 49
  }
  return result
}
