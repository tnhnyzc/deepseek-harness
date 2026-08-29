/**
 * The release build manifest: the deterministic identity of one packaged
 * artifact. Every field is fixed by build inputs (the git commit pins the
 * DSH source, the lockfile, and every version; the target pins the
 * platform) — no timestamps, no host metadata — so the same inputs
 * produce the same bytes. The manifest ships inside the artifact
 * (`resources/build-manifest.json`) and is the authoritative source the
 * packaged tests read: they verify the installed artifact against these
 * values instead of the source constants.
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/build-manifest
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DESKTOP_RUNTIME_PROTOCOL_VERSION } from '../../src/shared/runtime-protocol.ts'

/** The manifest schema version; bump only for structural changes. */
const BUILD_MANIFEST_SCHEMA_VERSION = 1

/** The identity of one packaged desktop release. */
export interface BuildManifest {
  schemaVersion: number
  /** The desktop app version (apps/desktop package.json). */
  desktopVersion: string
  /** The repository commit this release was built from; the DSH pin. */
  deepseekHarnessCommit: string
  /** The Harness version the runtime reports (`dsh-base` manifest). */
  deepseekHarnessVersion: string
  /** The pinned standalone Node version the runtime runs under. */
  nodeVersion: string
  /** The nodejs.org official sha256 of the pinned Node archive. */
  nodeSha256: string
  /** The Electron version the shell runs on. */
  electronVersion: string
  /** The desktop runtime IPC/boot protocol version. */
  desktopProtocolVersion: number
  /** The packaged target platform (node platform name). */
  platform: string
  /** The packaged target architecture. */
  arch: string
  /** sha256 over the staged runtime closure's sorted `name@version` lines. */
  closureFingerprint: string
}

/** The manifest inputs; everything is read from the repository at build time. */
export interface BuildManifestInput {
  /** The repository root (git work tree). */
  repoRoot: string
  /** The desktop app package directory (apps/desktop). */
  appDir: string
  /** The runtime package directory (apps/desktop-runtime); `dsh-base` is its dependency. */
  runtimeSourceDir: string
  /** The staged runtime closure root (for the fingerprint). */
  runtimeDir: string
  /** The packaged target, node naming (`darwin-arm64`, `win32-x64`, ...). */
  target: string
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function requireString(manifest: Record<string, unknown>, field: string, where: string): string {
  const value = manifest[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`build-manifest: ${where} has no string ${field}`)
  }
  return value
}

/**
 * Compute the closure fingerprint: sha256 over the staged closure's sorted
 * `name@version` lines (one per package directory, hoisted or nested).
 * @param runtimeDir - the staged runtime root.
 * @returns the hex digest.
 */
export function closureFingerprint(runtimeDir: string): string {
  const lines: string[] = []
  const record = (pkgDir: string): void => {
    try {
      const parsed = readJson(join(pkgDir, 'package.json'))
      const name = parsed.name
      const version = parsed.version
      if (typeof name === 'string' && typeof version === 'string') {
        lines.push(`${name}@${version}`)
      }
    } catch {
      // A directory without a readable manifest is not a package.
    }
  }
  const nested = (pkgDir: string): void => {
    const nodeModules = join(pkgDir, 'node_modules')
    if (!existsSync(nodeModules)) return
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('@')) {
        for (const sub of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
          if (sub.isDirectory()) record(join(nodeModules, entry.name, sub.name))
        }
      } else {
        record(join(nodeModules, entry.name))
      }
    }
  }
  const nodeModules = join(runtimeDir, 'node_modules')
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        record(join(nodeModules, entry.name, sub.name))
        nested(join(nodeModules, entry.name, sub.name))
      }
    } else {
      record(join(nodeModules, entry.name))
      nested(join(nodeModules, entry.name))
    }
  }
  lines.sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/**
 * Build the release manifest from the repository state.
 * @param input - repo root, app dir, staged runtime, and target.
 * @returns the manifest ready to ship with the artifact.
 */
export function createBuildManifest(input: BuildManifestInput): BuildManifest {
  const commit = execFileSync('git', ['-C', input.repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`build-manifest: unexpected git commit ${JSON.stringify(commit)}`)
  }
  const appManifest = readJson(join(input.appDir, 'package.json'))
  const nodePin = readJson(join(input.appDir, 'node-versions.json'))
  const [platform, arch] = input.target.split('-') as [string, string]
  const targetSpec = (nodePin.targets as Record<string, { sha256?: unknown }> | undefined)?.[input.target]
  if (targetSpec === undefined || typeof targetSpec.sha256 !== 'string') {
    throw new Error(`build-manifest: node-versions.json has no pinned digest for ${input.target}`)
  }
  const baseManifest = readJson(join(input.runtimeSourceDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'))
  return {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    desktopVersion: requireString(appManifest, 'version', 'apps/desktop package.json'),
    deepseekHarnessCommit: commit,
    deepseekHarnessVersion: requireString(baseManifest, 'version', 'dsh-base package.json'),
    nodeVersion: requireString(nodePin, 'version', 'node-versions.json'),
    nodeSha256: targetSpec.sha256,
    electronVersion: requireString(
      appManifest.devDependencies as Record<string, unknown> ?? {},
      'electron',
      'apps/desktop devDependencies',
    ).replace(/^[^0-9]*/, ''),
    desktopProtocolVersion: DESKTOP_RUNTIME_PROTOCOL_VERSION,
    platform,
    arch,
    closureFingerprint: closureFingerprint(input.runtimeDir),
  }
}

/**
 * Read and bound-check a shipped manifest from the artifact.
 * @param path - the `build-manifest.json` path inside the artifact.
 * @returns the validated manifest.
 */
export function readBuildManifest(path: string): BuildManifest {
  const value = readJson(path)
  for (const field of [
    'schemaVersion', 'desktopVersion', 'deepseekHarnessCommit', 'deepseekHarnessVersion',
    'nodeVersion', 'nodeSha256', 'electronVersion', 'desktopProtocolVersion', 'platform', 'arch',
    'closureFingerprint',
  ] as const) {
    if (value[field] === undefined) throw new Error(`build-manifest: ${relative(process.cwd(), path)} missing ${field}`)
  }
  if (value.schemaVersion !== BUILD_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`build-manifest: unsupported schemaVersion ${String(value.schemaVersion)}`)
  }
  return value as unknown as BuildManifest
}
