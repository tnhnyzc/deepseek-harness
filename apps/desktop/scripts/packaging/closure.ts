/**
 * Stage the runtime's production dependency closure into the artifact.
 *
 * The staged closure is byte-for-byte the lockfile's resolution: every
 * package is copied from the installed workspace store (the frozen-lockfile
 * install), never re-resolved. `pnpm deploy` was ruled out: its legacy
 * implementation re-resolves every range and has shipped drifted versions
 * (a major-version jump in the closure is a runtime behavior change, not a
 * packaging detail), and its modern implementation requires a
 * workspace-wide `inject-workspace-packages` switch this stage will not
 * make.
 *
 * The walk is over the on-disk graph, not the manifests: from the runtime
 * package's production dependencies, each package directory's own
 * `node_modules` links are followed (realpath deduplicated), which yields
 * exactly the hoisted production closure for the host platform.
 * Cross-platform staging from a single host is out of scope by design:
 * each CI runner packages its own platform, whose workspace install holds
 * that platform's prebuilds.
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/closure
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { realpathSync } from 'node:fs'

/** The staging result: what was copied and where. */
export interface ClosureStageResult {
  /** The number of distinct package directories copied. */
  packageCount: number
  /** The destination package root. */
  destDir: string
}

/**
 * Copy one package directory into the staging closure, dropping the
 * package's own `node_modules` (the walk handles it) and `.bin` shims.
 * @param source - the real (dereferenced) package directory.
 * @param destination - where the package lands in the staging closure.
 */
function copyPackage(source: string, destination: string): void {
  if (existsSync(destination)) return
  const selfModules = join(source, 'node_modules')
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== selfModules && !path.startsWith(selfModules + sep),
  })
}

/**
 * Stage the production closure of one workspace package.
 * @param sourceAppDir - the runtime package directory (apps/desktop-runtime).
 * @param destDir - the staging destination root (becomes `resources/runtime`).
 * @returns the staging result.
 */
export function stageRuntimeClosure(sourceAppDir: string, destDir: string): ClosureStageResult {
  rmSync(destDir, { recursive: true, force: true })
  // The runtime package's own files (entry, config, manifests) first, into a
  // fresh destination so the copy guard below never sees a pre-existing tree.
  copyPackage(sourceAppDir, destDir)
  const destNodeModules = join(destDir, 'node_modules')
  mkdirSync(destNodeModules, { recursive: true })

  const manifest = JSON.parse(readFileSync(join(sourceAppDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const productionDeps = Object.keys(manifest.dependencies ?? {}).sort()
  if (productionDeps.length === 0) {
    throw new Error(`closure: ${sourceAppDir} declares no production dependencies; nothing to stage`)
  }

  // Realpath-deduplicated package copy set: the frozen install resolves
  // every range to one store directory, so identity is the real path.
  const copied = new Set<string>()
  const queue: { real: string; name: string }[] = []

  const enqueue = (name: string, linkDir: string): void => {
    const link = join(linkDir, name)
    if (!existsSync(link)) {
      throw new Error(`closure: dependency ${name} is not installed in ${linkDir}; run pnpm install --frozen-lockfile first`)
    }
    const real = realpathSync(link)
    if (copied.has(real)) return
    copied.add(real)
    queue.push({ real, name })
  }

  for (const name of productionDeps) {
    enqueue(name, join(sourceAppDir, 'node_modules'))
  }

  // Where a package's dependencies live. A pnpm store package sits at
  // `.pnpm/<id>/node_modules/<pkg>` and its dependencies are its siblings in
  // that container — never in its own `node_modules`, which pnpm leaves with
  // only `.bin`. A workspace/source package keeps its dependency links in its
  // own `node_modules` (Node's nearest-wins resolution). The store case is
  // checked first so a store package's empty own `node_modules` is not taken
  // for its dependency set.
  const depContainer = (real: string): string | undefined => {
    const segments = real.split(sep)
    const pnpmIndex = segments.lastIndexOf('.pnpm')
    if (pnpmIndex !== -1 && segments[pnpmIndex + 2] === 'node_modules') {
      // A store package sits at .pnpm/<id>/node_modules/<pkg> (or
      // <scope>/<pkg>); its dependencies are the siblings in that
      // container, never in its own (mostly empty) node_modules. Locating
      // the container through the .pnpm segment handles both scoped and
      // unscoped names.
      return segments.slice(0, pnpmIndex + 3).join(sep)
    }
    const own = join(real, 'node_modules')
    if (existsSync(own)) return own
    return undefined
  }

  // Package entry names under a container directory. pnpm keeps dependency
  // links as symlinks, so directory entries and symlinks are both packages;
  // `.bin` shims are not.
  const packageNames = (dir: string): string[] => {
    const names: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.bin') continue
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

  let packageCount = 0
  while (queue.length > 0) {
    const { real, name } = queue.shift() as { real: string; name: string }
    const destination = join(destNodeModules, name)
    copyPackage(real, destination)
    packageCount += 1
    const container = depContainer(real)
    if (container === undefined) continue
    for (const depName of packageNames(container)) {
      enqueue(depName, container)
    }
  }

  if (!existsSync(join(destDir, 'package.json')) || !existsSync(join(destDir, 'dist', 'index.js'))) {
    throw new Error('closure: the staged runtime is missing package.json or dist/index.js; run the runtime build first')
  }
  return { packageCount, destDir }
}
