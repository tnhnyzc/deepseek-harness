/**
 * Resolution smoke for a packaged artifact: the staged closure must resolve
 * exactly the graph the lockfile resolved. The artifact ships its
 * resolution report (`resources/closure-audit.json`); this smoke picks the
 * probe set — every edge whose dependency is a same-name/different-version
 * collision (the cases a flat staging would get wrong) plus a deterministic
 * sample of the rest — and verifies, under the artifact's own bundled Node,
 * that each consumer resolves its dependency to the graph's version. This
 * is the packaged counterpart of the staging unit tests: they prove the
 * plan, this proves the shipped bytes.
 *
 * Usage (from the repository root):
 *   node --import tsx/esm apps/desktop/scripts/packaging/smoke-resolution.ts [artifact]
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/smoke-resolution
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readBuildManifest } from './build-manifest.ts'

const appDir = resolve(import.meta.dirname, '..', '..')
const outDir = join(appDir, 'out')

interface SmokeResult {
  ok: boolean
  detail: string
}

/** One probe: a consumer must resolve a dependency to one exact version. */
interface ResolutionProbe {
  consumer: string
  consumerDir: string
  dep: string
  expectedVersion: string
}

interface ResolutionReportEdge {
  consumer: string
  dep: string
}

interface ResolutionReport {
  schemaVersion: number
  root: string
  packageCount: number
  edgeCount: number
  collisions: { name: string; versions: string[] }[]
  edges: ResolutionReportEdge[]
}

/** Split `name@version` into name and version (scoped names keep their @). */
function splitNameVersion(label: string): { name: string; version: string } {
  const at = label.lastIndexOf('@')
  if (at <= 0) throw new Error(`smoke-resolution: cannot split ${label} into name and version`)
  return { name: label.slice(0, at), version: label.slice(at + 1) }
}

/** The artifact's paths, per platform. */
function artifactPaths(artifact: string, platform: NodeJS.Platform): { runtimeDir: string; node: string; audit: string; manifest: string } {
  const resources = platform === 'darwin'
    ? join(artifact, 'Contents', 'Resources')
    : join(artifact, 'resources')
  const nodeTarget = `${platform}-${process.arch}`
  return {
    runtimeDir: join(resources, 'runtime'),
    node: join(resources, 'node', nodeTarget, platform === 'win32' ? 'node.exe' : 'node'),
    audit: join(resources, 'closure-audit.json'),
    manifest: join(resources, 'build-manifest.json'),
  }
}

/** Locate the packaged artifact: an explicit argument, else the single platform directory under `out/`. */
function locateArtifact(explicit: string | undefined, platform: NodeJS.Platform): string {
  if (explicit !== undefined) return resolve(explicit)
  // Directories only: the distributable archive and its .sha256 sidecar sit
  // beside the artifact directory under `out/`.
  const candidates = readdirSync(outDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.includes(`-${platform}-`))
    .map(entry => entry.name)
  if (candidates.length !== 1) {
    throw new Error(`smoke-resolution: expected exactly one ${platform} artifact under ${outDir}, found ${candidates.length}: ${candidates.join(', ')}`)
  }
  const candidate = candidates[0]
  if (candidate === undefined) throw new Error(`smoke-resolution: no ${platform} artifact under ${outDir}`)
  const base = join(outDir, candidate)
  return platform === 'darwin' ? join(base, 'DeepSeek Harness Desktop.app') : base
}

/** Find the staged copies of one package by name anywhere under the runtime root. */
function findStagedPackageDirs(root: string, name: string): string[] {
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
      const entryPath = join(dir, entry.name)
      const parent = dirname(entryPath)
      const matches = scope === undefined
        ? entry.name === bare && basename(parent) === 'node_modules'
        : entry.name === bare && basename(parent) === scope && basename(dirname(parent)) === 'node_modules'
      if (matches) results.push(entryPath)
      if (!entry.name.startsWith('.')) walk(entryPath)
    }
  }
  walk(root)
  return results
}

/**
 * Build the probe set: every collision edge plus a deterministic sample of
 * the remaining edges (sorted, capped) — the collisions are the load-bearing
 * cases, the sample keeps ordinary edges covered.
 * @param report - the shipped resolution report.
 * @param runtimeDir - the staged runtime root (the root consumer's directory).
 * @returns the probes, or an error detail when a consumer cannot be located.
 */
function buildProbes(report: ResolutionReport, runtimeDir: string): { probes: ResolutionProbe[]; error?: string } {
  const collisionNames = new Set(report.collisions.map(c => c.name))
  const sorted = [...report.edges].sort((a, b) => (a.consumer + a.dep).localeCompare(b.consumer + b.dep))
  const collisionEdges = sorted.filter(edge => collisionNames.has(splitNameVersion(edge.dep).name))
  const ordinaryEdges = sorted.filter(edge => !collisionNames.has(splitNameVersion(edge.dep).name)).slice(0, 20)
  const probes: ResolutionProbe[] = []
  const seen = new Set<string>()
  const rootName = splitNameVersion(report.root).name
  // A consumer's resolution is the same from every one of its staged copies
  // (one instance, one manifest), so each consumer is located once and any
  // of its copies serves as the probe anchor.
  const consumerDirs = new Map<string, string[]>()
  for (const edge of [...collisionEdges, ...ordinaryEdges]) {
    const consumer = splitNameVersion(edge.consumer)
    const dep = splitNameVersion(edge.dep)
    const key = `${consumer.name} -> ${dep.name}`
    if (seen.has(key)) continue
    seen.add(key)
    let dirs = consumerDirs.get(consumer.name)
    if (dirs === undefined) {
      dirs = consumer.name === rootName
        ? [runtimeDir]
        : findStagedPackageDirs(runtimeDir, consumer.name)
      consumerDirs.set(consumer.name, dirs)
    }
    const consumerDir = dirs[0]
    if (consumerDir === undefined) {
      return { probes, error: `consumer ${consumer.name} is not staged in the artifact` }
    }
    probes.push({ consumer: edge.consumer, consumerDir, dep: dep.name, expectedVersion: dep.version })
  }
  return { probes }
}

/**
 * Run the resolution smoke against one packaged artifact.
 * @param artifact - the `.app` bundle, Windows, or Linux app directory.
 * @param platform - the artifact's platform.
 * @returns the smoke outcome.
 */
export async function runResolutionSmoke(artifact: string, platform: NodeJS.Platform): Promise<SmokeResult> {
  const paths = artifactPaths(artifact, platform)
  for (const [label, path] of Object.entries(paths)) {
    if (!existsSync(path)) return { ok: false, detail: `missing ${label} at ${path}` }
  }
  const manifest = readBuildManifest(paths.manifest)
  const report = JSON.parse(readFileSync(paths.audit, 'utf8')) as ResolutionReport
  if (report.schemaVersion !== 1) {
    return { ok: false, detail: `unsupported closure-audit schemaVersion ${String(report.schemaVersion)}` }
  }
  const { probes, error } = buildProbes(report, paths.runtimeDir)
  if (error !== undefined) return { ok: false, detail: error }
  if (probes.length === 0) return { ok: false, detail: 'the resolution report defines no edges; nothing to verify' }

  // The verification runs under the artifact's own bundled Node: the staged
  // tree is walked by the same runtime it ships with. The probe performs
  // Node's nearest-wins node_modules directory walk explicitly (bounded at
  // the runtime root), because require.resolve additionally enforces each
  // package's entry resolution, which types-only and exports-only packages
  // do not expose under a bare specifier — identically in the workspace and
  // in the artifact.
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-resolve-'))
  try {
    const probeScript = join(workDir, 'probe.cjs')
    const probeList = join(workDir, 'probes.json')
    writeFileSync(probeList, `${JSON.stringify(probes, null, 2)}\n`)
    writeFileSync(probeScript, `
const fs = require('node:fs')
const path = require('node:path')
const runtimeRoot = process.argv[3]
const probes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
// Node's nearest-wins walk, bounded: the closure must be self-contained,
// so a dependency that resolves only above the runtime root is a failure.
function nearestPackageDir(startDir, name) {
  const parts = name.split('/')
  let dir = startDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...parts)
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {}
    const parent = path.dirname(dir)
    if (parent === dir || parent === path.dirname(runtimeRoot)) return null
    dir = parent
  }
}
const failures = []
for (const probe of probes) {
  const dir = nearestPackageDir(probe.consumerDir, probe.dep)
  if (dir === null) {
    failures.push(probe.consumer + ' -> ' + probe.dep + ': not staged inside the runtime tree')
    continue
  }
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    failures.push(probe.consumer + ' -> ' + probe.dep + ': staged without a package.json')
    continue
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== probe.dep || manifest.version !== probe.expectedVersion) {
    failures.push(probe.consumer + ' -> ' + probe.dep + ': staged ' + String(manifest.name) + '@' + String(manifest.version) + ', the lockfile graph resolves ' + probe.expectedVersion)
  }
}
if (failures.length > 0) {
  console.error(failures.join('\\n'))
  process.exit(1)
}
console.log('resolution: ' + String(probes.length) + ' edges verified')
`)
    const result = execFileSync(paths.node, [probeScript, probeList, paths.runtimeDir], {
      cwd: paths.runtimeDir,
      encoding: 'utf8',
      // The bundled Node is the only Node involved; a minimal PATH keeps any
      // system install out of reach.
      env: { PATH: platform === 'win32' ? 'C:\\Windows\\system32;C:\\Windows' : '/usr/bin:/bin:/usr/sbin:/sbin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      ok: true,
      detail: `${probes.length} edges verified under the bundled Node ${manifest.nodeVersion} (${result.trim()})`,
    }
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}\n${'stdout' in error ? String((error as { stdout?: string }).stdout ?? '') : ''}${'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : ''}` : String(error)
    return { ok: false, detail: `resolution failed: ${detail.slice(0, 2000)}` }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const explicit = process.argv[2]
  const platform = process.platform
  const artifact = locateArtifact(explicit, platform)
  if (!existsSync(artifact)) {
    console.error(`smoke-resolution: artifact not found at ${artifact}`)
    process.exit(2)
  }
  const result = await runResolutionSmoke(artifact, platform)
  console.log(`smoke-resolution: ${result.ok ? 'PASS' : 'FAIL'} — ${result.detail}`)
  process.exit(result.ok ? 0 : 1)
}

// Run only as the entry script; the packaging pipeline imports the smoke.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
