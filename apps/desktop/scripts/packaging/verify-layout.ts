/**
 * Verify a packaged artifact against its release contract: the expected
 * tree, the shipped build manifest, the bundled Node's identity, the asar
 * integrity entries (macOS), and the fuses actually present in the binary.
 * The packaged tests run this same surface, so a pipeline green and a test
 * green are the same fact.
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/verify-layout
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as asar from '@electron/asar'
import { FuseV1Options } from '@electron/fuses'
import { readBuildManifest } from './build-manifest.ts'
import { DESKTOP_FUSES, DESKTOP_FUSE_INDICES, electronBinaryPath, readDesktopFuses } from './fuses.ts'

/** One layout check's outcome. */
interface LayoutCheck {
  name: string
  ok: boolean
  detail?: string
}

/** The report for one artifact. */
export interface LayoutReport {
  artifact: string
  checks: LayoutCheck[]
}

function check(checks: LayoutCheck[], name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) })
}

/** List the packaged asar's file paths. */
function asarEntryNames(asarPath: string): string[] {
  return asar.listPackage(asarPath, { isPack: false })
}

/**
 * Locate every staged copy of one package by name, layout-agnostic: the
 * nested staging places a diamond under each consumer, so the prebuild
 * anchors search instead of assuming a flat root.
 * @param root - the staged runtime root.
 * @param name - the package name (`@scope/name` for scoped packages).
 * @returns the directories matching `node_modules/<name>`.
 */
function findPackageDirs(root: string, name: string): string[] {
  const results: string[] = []
  const [scope, bare] = name.startsWith('@') ? name.split('/') : [undefined, name]
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      const parent = dirname(path)
      const matches = scope === undefined
        ? entry.name === bare && basename(parent) === 'node_modules'
        : entry.name === bare && basename(parent) === scope && basename(dirname(parent)) === 'node_modules'
      if (matches) results.push(path)
      if (!entry.name.startsWith('.')) walk(path)
    }
  }
  walk(root)
  return results
}

/**
 * Whether one staged package copy is resolvable from one consumer through
 * Node's upward `node_modules` walk: the copy's containing `node_modules`
 * directory is the consumer's own, or an ancestor's up to the closure root.
 * @param pkgDir - the staged package directory.
 * @param consumer - the consumer package name (`@scope/name` aware).
 * @param closureRoot - the staged runtime root.
 */
function resolvableFromConsumer(pkgDir: string, consumer: string, closureRoot: string): boolean {
  let containingNM: string
  if (basename(dirname(pkgDir)) === 'node_modules') {
    containingNM = dirname(pkgDir)
  } else {
    // A scoped package: <…>/node_modules/@scope/<name>.
    containingNM = dirname(dirname(pkgDir))
  }
  const consumerDir = join(closureRoot, 'node_modules', ...consumer.split('/'))
  let current = consumerDir
  for (;;) {
    if (join(current, 'node_modules') === containingNM) return true
    const parent = dirname(current)
    if (parent === closureRoot) return join(closureRoot, 'node_modules') === containingNM
    current = parent
  }
}

/**
 * Verify one packaged artifact.
 * @param artifact - the `.app` bundle, Windows, or Linux app directory.
 * @param platform - the packaged target platform.
 * @param arch - the packaged target architecture.
 * @param target - the node target name (`darwin-arm64`, ...).
 * @returns the check report; `checks.every(ok)` is the verdict.
 */
export async function verifyArtifactLayout(
  artifact: string,
  platform: NodeJS.Platform,
  arch: string,
  target: string,
): Promise<LayoutReport> {
  const checks: LayoutCheck[] = []
  const resources = platform === 'darwin' ? join(artifact, 'Contents', 'Resources') : join(artifact, 'resources')
  const binary = electronBinaryPath(artifact, platform)
  const asar = join(resources, 'app.asar')

  check(checks, 'electron binary', existsSync(binary))
  check(checks, 'app.asar', existsSync(asar))

  if (existsSync(asar)) {
    let entries: string[] = []
    try {
      entries = asarEntryNames(asar)
    } catch (error) {
      check(checks, 'asar header parse', false, String(error))
    }
    for (const entry of ['/dist/main/index.js', '/src/preload/index.cjs', '/package.json']) {
      check(checks, `asar contains ${entry}`, entries.includes(entry))
    }
  }

  const expectedResources = [
    join(resources, 'renderer', 'index.html'),
    join(resources, 'node', target, platform === 'win32' ? 'node.exe' : 'node'),
    join(resources, 'runtime', 'package.json'),
    join(resources, 'runtime', 'dist', 'index.js'),
    join(resources, 'build-manifest.json'),
    join(resources, 'licenses', 'LICENSE'),
    join(resources, 'licenses', 'THIRD_PARTY_NOTICES.md'),
    join(resources, 'licenses', 'ELECTRON_LICENSE.txt'),
    join(resources, 'licenses', 'NODE_LICENSE.txt'),
  ]
  for (const path of expectedResources) {
    check(checks, join(artifact, path).replace(artifact, ''), existsSync(path), path)
  }

  // The closure anchors: the runtime's direct dependencies sit at the
  // closure root; the native prebuilds (non-colliding names) are staged
  // once, at the root, and must be resolvable from their consumer through
  // Node's upward `node_modules` walk — either there or as a per-consumer
  // collision shadow. The staging closure only carries this host's platform
  // prebuilds, named `<lib>-<platform>-<arch>`.
  const closureRoot = join(resources, 'runtime')
  const directAnchors = [
    join(closureRoot, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    join(closureRoot, 'node_modules', 'koffi', 'package.json'),
  ]
  for (const path of directAnchors) {
    check(checks, path.replace(artifact, ''), existsSync(path), path)
  }
  const prebuildAnchors: [string, string][] = [
    [`@koromix/koffi-${target}`, 'koffi'],
    [`@img/sharp-${target}`, 'sharp'],
    [`@img/sharp-libvips-${target}`, 'sharp'],
  ]
  for (const [prebuild, consumer] of prebuildAnchors) {
    const found = findPackageDirs(closureRoot, prebuild)
    const first = found[0]
    const ok = found.length === 1 && first !== undefined && resolvableFromConsumer(first, consumer, closureRoot)
    check(checks, `prebuild ${prebuild} staged once, resolvable from ${consumer}`, ok, found.length === 0 ? 'not found' : found.join(' | '))
  }

  // The shipped manifest is the artifact's identity: read it from the
  // artifact, not the source constants.
  const manifestPath = join(resources, 'build-manifest.json')
  let manifest: ReturnType<typeof readBuildManifest> | undefined
  if (existsSync(manifestPath)) {
    try {
      manifest = readBuildManifest(manifestPath)
    } catch (error) {
      check(checks, 'build manifest readable', false, String(error))
    }
  }
  if (manifest !== undefined) {
    check(checks, 'manifest platform', manifest.platform === platform, manifest.platform)
    check(checks, 'manifest arch', manifest.arch === arch, manifest.arch)
    check(checks, 'manifest closure fingerprint', /^[0-9a-f]{64}$/.test(manifest.closureFingerprint))
  }

  // The bundled Node self-reports the pinned version when it can run here.
  const nodeBinary = join(resources, 'node', target, platform === 'win32' ? 'node.exe' : 'node')
  if (existsSync(nodeBinary) && target === `${process.platform}-${process.arch}`) {
    const probe = spawnSync(nodeBinary, ['--version'], { encoding: 'utf8' })
    check(checks, 'bundled node self-report', probe.status === 0 && manifest !== undefined && probe.stdout.trim() === manifest.nodeVersion,
      `${probe.stdout?.trim()} (want ${manifest?.nodeVersion})`)
  }

  // The fuses actually present in the binary, against the configured set.
  if (existsSync(binary)) {
    let fused: Record<FuseV1Options, boolean> | undefined
    try {
      fused = await readDesktopFuses(binary)
    } catch (error) {
      check(checks, 'fuse read', false, String(error))
    }
    if (fused !== undefined) {
      for (const index of DESKTOP_FUSE_INDICES) {
        const label = FuseV1Options[index]
        check(checks, `fuse ${label}=${String(DESKTOP_FUSES[index])}`, fused[index] === DESKTOP_FUSES[index], `actual ${String(fused[index])}`)
      }
    }
  }

  // The macOS asar-integrity entry: the packager writes it into Info.plist.
  if (platform === 'darwin') {
    const plist = join(artifact, 'Contents', 'Info.plist')
    if (existsSync(plist)) {
      const text = readFileSync(plist, 'utf8')
      check(checks, 'ElectronAsarIntegrity in Info.plist', text.includes('ElectronAsarIntegrity'))
    } else {
      check(checks, 'Info.plist', false)
    }
  }

  return { artifact, checks }
}

/**
 * The one-line verdict helper used by the pipeline and the specs.
 * @param report - the layout report.
 * @returns a human summary, naming every failed check.
 */
export function layoutVerdict(report: LayoutReport): string {
  const failed = report.checks.filter(c => !c.ok)
  if (failed.length > 0) {
    return `layout FAIL: ${failed.map(c => `${c.name}${c.detail !== undefined ? ` (${c.detail})` : ''}`).join('; ')}`
  }
  return `layout OK: ${String(report.checks.length)} checks passed`
}
