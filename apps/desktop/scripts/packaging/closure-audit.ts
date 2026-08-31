/**
 * Audit the runtime's production dependency closure: the graph the staged
 * artifact must reproduce, edge by edge.
 *
 * The walk is over the on-disk graph of the frozen-lockfile install:
 *
 * - the root is the runtime package's declared production dependencies;
 * - a pnpm store package's dependencies are the sibling links in its
 *   `.pnpm/<id>/node_modules` container (pnpm materializes exactly its
 *   production dependencies plus resolved peers there);
 * - a workspace/source package's dependencies are the names it declares in
 *   `dependencies` + `optionalDependencies` + `peerDependencies` (pnpm
 *   auto-installs peers by default), resolved through its own
 *   `node_modules` links. devDependencies are build-time and never ship,
 *   so they are never followed.
 *
 * Identity is the realpath (a frozen install resolves every range to one
 * store directory). The audit records every consumer→dependency edge with
 * both endpoints' versions, and reports every same-name/different-version
 * collision — the cases a flat `node_modules/<name>` staging would silently
 * collapse to "first version wins" and the nested staging must instead
 * resolve per consumer.
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/closure-audit
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

/** One resolved package instance (deduplicated by realpath). */
export interface ClosureAuditPackage {
  /** The real (dereferenced) package directory — the instance identity. */
  real: string
  name: string
  version: string
  /** `store` = a pnpm store package; `workspace` = a source/workspace package. */
  kind: 'store' | 'workspace'
  /** The BFS level from the runtime root (the root's direct deps are level 1). */
  level: number
}

/** One consumer→dependency resolution edge. */
export interface ClosureAuditEdge {
  consumerName: string
  consumerVersion: string
  consumerReal: string
  depName: string
  depReal: string
  depVersion: string
}

/** A same-name package resolved to more than one version in the reachable graph. */
export interface ClosureCollision {
  name: string
  versions: string[]
}

/** The full closure audit. */
export interface ClosureAudit {
  rootName: string
  rootVersion: string
  rootReal: string
  packages: ClosureAuditPackage[]
  edges: ClosureAuditEdge[]
  collisions: ClosureCollision[]
  /**
   * Dependency entries without a readable package.json manifest. A pnpm
   * store container invariant says this cannot happen; a hit means the
   * install is corrupt and the audit fails rather than ships a guess.
   */
  broken: string[]
}

/** The manifest fields the audit reads from every staged package. */
type DepManifest = {
  name: unknown
  version: unknown
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** Read one package manifest, failing loud when the install is broken. */
function readManifest(pkgReal: string, context: string): DepManifest {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(pkgReal, 'package.json'), 'utf8'))
  } catch {
    throw new Error(`closure-audit: ${context} has no readable package.json at ${pkgReal}; the install is broken`)
  }
  return parsed as DepManifest
}

/**
 * The pnpm store container of a package, when it is a store package:
 * `.pnpm/<id>/node_modules` holds the package plus its dependency links as
 * siblings. `undefined` for workspace/source packages.
 */
function storeContainer(real: string): string | undefined {
  const segments = real.split(sep)
  const pnpmIndex = segments.lastIndexOf('.pnpm')
  if (pnpmIndex !== -1 && segments[pnpmIndex + 1] !== undefined && segments[pnpmIndex + 2] === 'node_modules') {
    return segments.slice(0, pnpmIndex + 3).join(sep)
  }
  return undefined
}

/** The package entry names under a container directory (`.bin` and dot entries are not packages). */
function packageEntryNames(dir: string): string[] {
  const names: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (sub.isDirectory() || sub.isSymbolicLink()) names.push(`${entry.name}/${sub.name}`)
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      names.push(entry.name)
    }
  }
  return names
}

/**
 * Audit the production closure of one workspace package.
 * @param sourceAppDir - the runtime package directory (apps/desktop-runtime).
 * @returns the package set, the resolution edges, and the collision report.
 * @throws when a declared production dependency is not installed or a
 * store container entry has no manifest (a broken install ships nothing).
 */
export function auditRuntimeClosure(sourceAppDir: string): ClosureAudit {
  const rootManifest = readManifest(sourceAppDir, 'the runtime package')
  const rootName = typeof rootManifest.name === 'string' ? rootManifest.name : join(sourceAppDir, '<unnamed>')
  const rootVersion = typeof rootManifest.version === 'string' ? rootManifest.version : '0.0.0'
  const rootReal = realpathSync(sourceAppDir)

  const packages: ClosureAuditPackage[] = []
  const edges: ClosureAuditEdge[] = []
  const broken: string[] = []
  const byReal = new Map<string, ClosureAuditPackage>()
  const queue: ClosureAuditPackage[] = []

  /**
   * Record one consumer→dependency resolution. Every edge is recorded —
   * a diamond (the same instance under two consumers) is two edges — but
   * the walk queue only receives first discoveries, so each package's own
   * outgoing edges are processed once.
   */
  const recordEdge = (name: string, linkDir: string, consumer: { name: string; version: string; real: string }, level: number): void => {
    const link = join(linkDir, name)
    if (!existsSync(link)) {
      throw new Error(`closure-audit: dependency ${name} is not installed in ${linkDir}; run pnpm install --frozen-lockfile first`)
    }
    const real = realpathSync(link)
    if (real === consumer.real) return
    let pkg = byReal.get(real)
    if (pkg === undefined) {
      const manifest = readManifest(real, `store container entry ${name}`)
      pkg = {
        real,
        name: typeof manifest.name === 'string' ? manifest.name : name,
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        kind: storeContainer(real) !== undefined ? 'store' : 'workspace',
        level,
      }
      byReal.set(real, pkg)
      packages.push(pkg)
      queue.push(pkg)
    }
    edges.push({
      consumerName: consumer.name,
      consumerVersion: consumer.version,
      consumerReal: consumer.real,
      depName: name,
      depReal: real,
      depVersion: pkg.version,
    })
  }

  const root = { name: rootName, version: rootVersion, real: rootReal }
  for (const name of Object.keys(rootManifest.dependencies ?? {}).sort()) {
    recordEdge(name, join(sourceAppDir, 'node_modules'), root, 1)
  }

  while (queue.length > 0) {
    const pkg = queue.shift() as ClosureAuditPackage
    const manifest = readManifest(pkg.real, `package ${pkg.name}`)
    const consumer = { name: pkg.name, version: pkg.version, real: pkg.real }
    const container = storeContainer(pkg.real)
    if (container !== undefined) {
      // A store package's dependencies are its container's siblings (its
      // own directory is skipped by the consumer-real check in recordEdge).
      for (const depName of packageEntryNames(container)) {
        recordEdge(depName, container, consumer, pkg.level + 1)
      }
      continue
    }
    // A workspace package: follow exactly what it declares for production
    // (dependencies + optionalDependencies; peers, which pnpm
    // auto-installs by default, when the link is materialized).
    const declared = new Set<string>([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    const own = join(pkg.real, 'node_modules')
    for (const depName of [...declared].sort()) {
      if (!existsSync(join(own, depName))) continue
      recordEdge(depName, own, consumer, pkg.level + 1)
    }
  }

  // Collision report: every name resolved to more than one version.
  const byName = new Map<string, Set<string>>()
  for (const pkg of packages) {
    const versions = byName.get(pkg.name) ?? new Set<string>()
    versions.add(pkg.version)
    byName.set(pkg.name, versions)
  }
  const collisions: ClosureCollision[] = [...byName.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    rootName,
    rootVersion,
    rootReal,
    packages,
    edges,
    collisions,
    broken,
  }
}

/**
 * The deterministic closure graph identity: sha256 over the sorted
 * `consumer@version -> dep@version` edge lines. Two closures with the same
 * names but a different resolution (a swapped version on any edge) produce
 * different fingerprints; the flat name set cannot tell them apart.
 */
export function closureGraphFingerprint(audit: ClosureAudit): string {
  const lines = audit.edges.map(edge => `${edge.consumerName}@${edge.consumerVersion} -> ${edge.depName}@${edge.depVersion}`)
  lines.sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}
