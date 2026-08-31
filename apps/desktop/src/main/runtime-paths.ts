/**
 * Resolution of the packaged runtime pieces: the bundled Node executable,
 * the runtime entry, and the desktop-managed Harness home. Development
 * reads the workspace build outputs; packaged builds read the resources
 * directory (stage 11 owns the runtime resource staging).
 * @module @deepseek-ai/dsh-desktop/src/main/runtime-paths
 */

import { join } from 'node:path'

/** The Node build target name for this platform/architecture pair. */
function nodeTargetName(): string {
  return `${process.platform}-${process.arch}`
}

/**
 * The bundled Node executable for this target.
 * @param packaged - whether the app runs from its packaged bundle.
 * @param resourcesPath - Electron's resources directory.
 * @param desktopDir - this app's package directory (development).
 * @returns the absolute executable path.
 */
export function bundledNodeExecutable(packaged: boolean, resourcesPath: string, desktopDir: string): string {
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  const base = packaged ? join(resourcesPath, 'node') : join(desktopDir, 'node')
  return join(base, nodeTargetName(), name)
}

/**
 * The desktop-managed Harness home: an application-owned directory under the
 * user-data path. The CLI's `~/.dsh` is never reused automatically.
 * @param userDataPath - Electron's per-app user-data directory.
 * @returns the absolute DSH_HOME path.
 */
export function dshHomeDirectory(userDataPath: string): string {
  return join(userDataPath, 'harness')
}

/**
 * The desktop-runtime entry the supervisor forks.
 * @param packaged - whether the app runs from its packaged bundle.
 * @param resourcesPath - Electron's resources directory.
 * @param desktopDir - this app's package directory (development).
 * @returns the absolute entry path.
 */
export function runtimeEntryPath(packaged: boolean, resourcesPath: string, desktopDir: string): string {
  return packaged
    ? join(resourcesPath, 'runtime', 'dist', 'index.js')
    : join(desktopDir, '..', 'desktop-runtime', 'dist', 'index.js')
}

/**
 * The runtime child's working directory: the runtime package root, so its
 * `.env` layering reads the app-owned home, not the developer's checkout.
 * @param packaged - whether the app runs from its packaged bundle.
 * @param resourcesPath - Electron's resources directory.
 * @param desktopDir - this app's package directory (development).
 * @returns the absolute cwd.
 */
export function runtimeCwd(packaged: boolean, resourcesPath: string, desktopDir: string): string {
  return packaged ? join(resourcesPath, 'runtime') : join(desktopDir, '..', 'desktop-runtime')
}
