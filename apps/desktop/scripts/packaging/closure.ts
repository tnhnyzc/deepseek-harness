/**
 * Stage the runtime's production dependency closure into the artifact —
 * resolution-faithful, without symlinks or a package manager inside the
 * artifact.
 *
 * `pnpm deploy` was ruled out: its legacy implementation re-resolves every
 * range and has shipped drifted versions (a major-version jump in the
 * closure is a runtime behavior change, not a packaging detail), and its
 * modern implementation requires a workspace-wide
 * `inject-workspace-packages` switch this stage will not make.
 *
 * The layout exploits how Node actually resolves: from a file inside a
 * package, `require`/`import` walk `node_modules` upward (nearest wins).
 * So a package that sits at the closure root is reachable from every
 * package below it, and only a name that resolves to MORE THAN ONE version
 * in the reachable graph (a collision, as the audit reports) must be
 * shadowed per consumer:
 *
 * - every non-colliding instance is copied ONCE, to the closure root's
 *   `node_modules/<name>`; every consumer's upward walk reaches it, and
 *   there is nothing to get wrong (one version, one copy);
 * - every colliding instance is copied under each of its consumers' staged
 *   locations (`<consumer>/node_modules/<name>`), so each consumer's
 *   nearest-wins lookup finds exactly the version its pnpm install
 *   resolved; a consumer that is itself a colliding package contributes
 *   each of its own copies as a location, which bounds the recursion to
 *   the (small) collision subgraph.
 *
 * This split is what keeps the layout finite: the production closure
 * contains dependency cycles (monorepo packages that load and are loaded
 * by each other), and a scheme that nests every dependency under every
 * consumer location never terminates on a cycle — it keeps nesting deeper
 * copies of the cycle on every pass. Non-colliding packages never nest, so
 * cycles among them (all three production cycles are) flatten to root
 * copies that Node's ordinary require-cycle handling loads; only colliding
 * placements recurse, and the collision subgraph is acyclic and small
 * (bounded pass limit; fails loud instead of looping).
 *
 * Cross-platform staging from a single host is out of scope by design:
 * each CI runner packages its own platform, whose workspace install holds
 * that platform's prebuilds.
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/closure
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { auditRuntimeClosure, type ClosureAudit, type ClosureCollision } from './closure-audit.ts'

/** The staging result: what was copied, where, and what the graph contained. */
export interface ClosureStageResult {
  /** The number of distinct package instances in the closure. */
  packageCount: number
  /** The number of staged package copies (colliding packages copy once per consumer location). */
  destCount: number
  /** The number of consumer→dependency edges the layout reproduces. */
  edgeCount: number
  /** The same-name/different-version collisions the per-consumer shadowing resolves. */
  collisions: ClosureCollision[]
  /** Bytes under the staged `node_modules` (the duplication included). */
  bytesCopied: number
  /** The destination package root. */
  destDir: string
  /** The audit the layout was built from. */
  audit: ClosureAudit
}

/**
 * Copy one package directory into a staging destination, dropping the
 * package's own `node_modules` (its dependencies resolve upward to the
 * closure root's copies, or through the per-consumer collision shadows)
 * and refusing a pre-existing destination (a plan bug, never an overwrite).
 * @param source - the real (dereferenced) package directory.
 * @param destination - where this copy lands in the staged closure.
 */
function copyPackage(source: string, destination: string): void {
  if (existsSync(destination)) {
    throw new Error(`closure: destination ${destination} already exists; the staging plan is malformed`)
  }
  const selfModules = join(source, 'node_modules')
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== selfModules && !path.startsWith(selfModules + sep),
  })
}

/** The total file bytes under a directory (the staged duplication included). */
function directoryBytes(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += directoryBytes(path)
    } else if (entry.isFile()) {
      total += statSync(path).size
    }
  }
  return total
}

/**
 * Stage the production closure of one workspace package with the
 * flat-root + per-consumer-collision-shadow layout.
 * @param sourceAppDir - the runtime package directory (apps/desktop-runtime).
 * @param destDir - the staging destination root (becomes `resources/runtime`).
 * @returns the staging result.
 */
export function stageRuntimeClosure(sourceAppDir: string, destDir: string): ClosureStageResult {
  const audit = auditRuntimeClosure(sourceAppDir)
  rmSync(destDir, { recursive: true, force: true })
  // The runtime package's own files (entry, config, manifests) first, into a
  // fresh destination so the copy guard below never sees a pre-existing tree.
  copyPackage(sourceAppDir, destDir)
  const rootNodeModules = join(destDir, 'node_modules')
  mkdirSync(rootNodeModules, { recursive: true })

  const colliding = new Set(audit.collisions.map(collision => collision.name))

  // 1) Non-colliding instances: exactly one root copy each. Every consumer's
  // upward walk reaches the root, and one name with one version has nothing
  // to shadow. Dependency cycles among these (a monorepo pattern) load under
  // Node's ordinary require-cycle semantics, exactly as in the workspace.
  for (const pkg of audit.packages) {
    if (colliding.has(pkg.name)) continue
    copyPackage(pkg.real, join(rootNodeModules, ...pkg.name.split('/')))
  }

  // 2) Colliding instances: a copy under each consumer's staged location.
  // Locations grow monotonically (a colliding package's locations are the
  // destinations the collision edges pointing at it claim), so the
  // fixed-point loop converges over the small, acyclic collision subgraph;
  // the pass bound is a canary — an unbounded growth means the collision
  // subgraph has a cycle, which the audit graph cannot have.
  const locations = new Map<string, string[]>()
  locations.set(audit.rootReal, [destDir])
  for (const pkg of audit.packages) {
    if (!colliding.has(pkg.name)) locations.set(pkg.real, [join(rootNodeModules, ...pkg.name.split('/'))])
  }
  const claimed = new Map<string, string>() // destination path -> source real
  for (let pass = 0; ; pass += 1) {
    let changed = false
    for (const edge of audit.edges) {
      if (!colliding.has(edge.depName)) continue
      const consumerLocations = locations.get(edge.consumerReal)
      if (consumerLocations === undefined) {
        throw new Error(`closure: no staged location for ${edge.consumerName}@${edge.consumerVersion}; the resolution graph is malformed`)
      }
      for (const location of consumerLocations) {
        const destination = join(location, 'node_modules', ...edge.depName.split('/'))
        const existing = claimed.get(destination)
        if (existing !== undefined) {
          if (existing !== edge.depReal) {
            throw new Error(
              `closure: destination ${destination} is claimed by two different package instances for ${edge.depName}; `
              + 'the resolution graph is malformed',
            )
          }
          continue
        }
        claimed.set(destination, edge.depReal)
        changed = true
        const depLocations = locations.get(edge.depReal) ?? []
        if (!depLocations.includes(destination)) {
          depLocations.push(destination)
          locations.set(edge.depReal, depLocations)
        }
      }
    }
    if (!changed) break
    if (pass > 32) {
      throw new Error('closure: the collision placement did not converge; the collision subgraph is malformed')
    }
  }
  for (const [destination, source] of claimed) {
    copyPackage(source, destination)
  }

  if (!existsSync(join(destDir, 'package.json')) || !existsSync(join(destDir, 'dist', 'index.js'))) {
    throw new Error('closure: the staged runtime is missing package.json or dist/index.js; run the runtime build first')
  }
  return {
    packageCount: audit.packages.length,
    destCount: audit.packages.filter(pkg => !colliding.has(pkg.name)).length + claimed.size,
    edgeCount: audit.edges.length,
    collisions: audit.collisions,
    bytesCopied: directoryBytes(rootNodeModules),
    destDir,
    audit,
  }
}
