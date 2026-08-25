/**
 * Desktop runtime patch stack: the web profile's bundle layers and user
 * layers, plus the desktop overlay set. The overlays remove the HTTP
 * serving rows and wire the shipped agent presets; every other row stays
 * exactly as the `web` profile composes it, so the desktop hosts the same
 * Harness the browser surface runs.
 * @module @deepseek-ai/dsh-desktop-runtime/composition
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  composeEntries,
  healProfilesModuleFallback,
  loadProfile,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'

/** The profile the desktop runtime boots (the full Harness web composition). */
const DESKTOP_PROFILE_NAME = 'web'

/**
 * Rows the desktop overlay disables. `webserver` is the HTTP listener and
 * `web-runtime` serves the frontend dist and provides `webRuntime`; both stay
 * off — the desktop carrier never listens. `client-hmr` stays off as well:
 * its browser half opens `EventSource('/plugins/events')` outside the
 * transport hook, which is a browser-only dev channel production desktop has
 * no use for.
 */
const DESKTOP_DISABLED_ROWS = [
  'webserver',
  'web-runtime',
  'client-hmr',
] as const

/**
 * The `connection` row's web-profile wiring is HTTP-shaped: its entry inject
 * waits on `webRuntime` and its config reads `ctx.webRuntime.trustedHosts`.
 * Desktop replaces both — no `webRuntime` exists, and a local process has no
 * non-loopback serving authorities. The node half still activates: without a
 * web server it registers no route and no WebSocket downlink, but it provides
 * the `connection` service whose in-process RPC interceptor dispatch (the
 * Typert gateway) the transport's fetch channel consumes.
 */
const CONNECTION_ROW_ID = 'connection'

/**
 * The directory-picker replacement: the web composition mounts the `auto`
 * variant, which resolves the web bind host and therefore injects
 * `webServer`. The desktop runtime is a local process, so the overlay
 * disables that row and inserts the desktop provider instead: the same
 * native seat (`kind: 'native'`), but its chooser is Electron's OS dialog in
 * the main process, reached over the native capability channel — a forked
 * child must not spawn osascript/Zenity/KDialog/COM choosers of its own.
 * The API gateway's `directoryPicker` requirement then resolves without a
 * web server.
 */
const DESKTOP_PICKER_ROW_ID = 'directory-picker'
const DESKTOP_PICKER_INSERT_ID = 'directory-picker-desktop'
const DESKTOP_PICKER_SURFACE_ID = 'directory-picker-desktop-surface'
/**
 * The native surface's package name: the `auto` row the overlay disables
 * mounts both faces of the resolved interaction (host backend AND client
 * surface), so the desktop replacement must mount the native surface too —
 * without it the `sidebar.workspaces.directoryFlow` hole stays empty and
 * the workspace-adding UI has no entry point. The surface's browser half
 * drives `host.pickDirectory`, which the desktop provider above serves.
 */
const DESKTOP_PICKER_SURFACE_NAME = '@deepseek-ai/dsh-client-ui-directory-picker-native'
/**
 * The desktop picker plugin's built module, beside this runtime's entry in
 * both the development and the packaged layouts. The Loader imports module
 * specifiers, so the file path crosses as a file URL (platform-correct on
 * POSIX and Windows alike).
 */
const DESKTOP_PICKER_MODULE_NAME = pathToFileURL(
  fileURLToPath(new URL('./directory-picker.js', import.meta.url)),
).href

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over (identical to the CLI's). */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Load the desktop profile and (re)write its empty root config. The root is
 * always rewritten: the whole composition is patch layers, and the vendored
 * Loader's tree write-back (a plugin self-disposing persists the current
 * tree) can bake composed rows into this file, which would duplicate every
 * bundle insert on the next boot.
 * @param installAnchor - absolute path of this runtime's package.json.
 * @param home - the desktop-managed Harness home (`$DSH_HOME`).
 * @returns the loaded profile.
 */
export function prepareDesktopProfile(installAnchor: string, home: string): Profile {
  healProfilesModuleFallback(installAnchor, home)
  const profile = loadProfile('dsh-desktop-runtime', DESKTOP_PROFILE_NAME, installAnchor, home)
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** The composed desktop patch stack in application order. */
export interface DesktopComposition {
  /** Bundle, profile, home, and overlay patches flattened in application order. */
  patches: PatchOptions[]
  /** id → row of the pre-overlay composition, for overlay derivation. */
  rows: ReadonlyMap<string, EntryOptions>
}

/**
 * Compose the desktop patch stack: bundle layers in `dsh.profile.bundles`
 * order, the profile's user layer, the home-level user layer, then the
 * desktop overlays. Overlays are derived from the pre-overlay row index so a
 * profile that already lacks a row gets no stale disable, and the telemetry
 * switch keeps its any-non-empty-value privacy semantics.
 * @param profile - the loaded profile.
 * @param homePatches - the home-level user layer patches.
 * @param presetRoot - the shipped agent-preset root beside this runtime's config.
 * @returns the flattened patch list and the pre-overlay row index.
 */
export function composeDesktopPatches(
  profile: Profile,
  homePatches: PatchOptions[],
  presetRoot: string,
): DesktopComposition {
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const overlays: PatchOptions[] = []
  for (const id of DESKTOP_DISABLED_ROWS) {
    if (rows.has(id)) overlays.push({ id, disabled: true })
  }
  if (rows.has(CONNECTION_ROW_ID)) {
    overlays.push({
      id: CONNECTION_ROW_ID,
      inject: [],
      config: { trustedHosts: [] },
    })
  }
  if (rows.has(DESKTOP_PICKER_ROW_ID)) {
    overlays.push({ id: DESKTOP_PICKER_ROW_ID, disabled: true })
    overlays.push({
      insert: [
        { id: DESKTOP_PICKER_INSERT_ID, name: DESKTOP_PICKER_MODULE_NAME },
        { id: DESKTOP_PICKER_SURFACE_ID, name: DESKTOP_PICKER_SURFACE_NAME },
      ],
    })
  }
  // The preset row ships its default config from the bundle; the desktop
  // adds its own shipped roots, the same treatment the CLI gives its config.
  if (rows.has('agent-presets')) {
    overlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: presetRoot, trust: 'system' }],
      },
    })
  }
  if ((process.env.DSH_TELEMETRY_DISABLED ?? '') !== '' && rows.has(TELEMETRY_ROW_ID)) {
    overlays.push({ id: TELEMETRY_ROW_ID, disabled: true })
  }
  return {
    patches: [...bundlePatches, ...profile.patches, ...homePatches, ...overlays],
    rows,
  }
}
