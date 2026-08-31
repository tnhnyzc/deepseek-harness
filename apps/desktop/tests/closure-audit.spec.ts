/**
 * Closure audit and nested staging: the production-only walk must record
 * every consumer→dependency resolution edge (diamonds included), report
 * every same-name/different-version collision, and refuse a broken install;
 * the staged layout must place each dependency under each of its consumer's
 * locations, so Node's nearest-wins resolution gives every consumer exactly
 * the version its pnpm install resolved; and the graph fingerprint must be
 * deterministic and edge-sensitive (a version swap on any edge changes it).
 *
 * The fixture is a miniature pnpm install: real store containers under a
 * `.pnpm` directory with dependency links (symlinks; junctions on Windows,
 * the same mechanism pnpm itself uses there), and workspace-style packages
 * with their own `node_modules` links.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditRuntimeClosure,
  closureGraphFingerprint,
  type ClosureAudit,
  type ClosureAuditEdge,
  type ClosureAuditPackage,
} from '../scripts/packaging/closure-audit.ts'
import { stageRuntimeClosure } from '../scripts/packaging/closure.ts'

const APP_DIR = join(import.meta.dirname, '..')
const RUNTIME_DIR = join(APP_DIR, '..', 'desktop-runtime')

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dsh-closure-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

/** Write one package directory (a real directory, never a link). */
function writePkg(dir: string, name: string, version: string, deps: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version, dependencies: deps }, null, 2)}\n`)
}

/** Link (junction on Windows) one dependency into a container directory. */
function linkDep(container: string, name: string, target: string): void {
  let link: string
  if (name.startsWith('@')) {
    const [scope, bare] = name.split('/')
    if (scope === undefined || bare === undefined) throw new Error(`fixture: not a scoped package name: ${name}`)
    mkdirSync(join(container, scope), { recursive: true })
    link = join(container, scope, bare)
  } else {
    link = join(container, name)
  }
  mkdirSync(container, { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined)
}

/**
 * Build the miniature pnpm install:
 *
 *   runtime (deps a, b, c)
 *   a (workspace, deps x@1, b)    b (workspace, deps x@2, a)   ← a cycle
 *   c (store, dep d)              x@1, x@2 (store, the collision)
 *   d (store, leaf)
 *
 * The a↔b cycle mirrors the production closure, whose dependency cycles
 * (monorepo packages that load each other) must not break staging: the
 * layout flattens non-colliding packages to root copies that Node's
 * ordinary require-cycle handling loads.
 */
function buildFixture(): { runtime: string } {
  const store = join(work, 'store', 'node_modules', '.pnpm')
  const x1 = join(store, 'x@1.0.0', 'node_modules', 'x')
  const x2 = join(store, 'x@2.0.0', 'node_modules', 'x')
  const cDir = join(store, 'c@1.0.0', 'node_modules', 'c')
  const dDir = join(store, 'd@1.0.0', 'node_modules', 'd')
  writePkg(x1, 'x', '1.0.0')
  writePkg(x2, 'x', '2.0.0')
  writePkg(cDir, 'c', '1.0.0', { d: '1.0.0' })
  writePkg(dDir, 'd', '1.0.0')
  linkDep(join(store, 'c@1.0.0', 'node_modules'), 'd', dDir)

  const runtime = join(work, 'runtime')
  writePkg(runtime, 'root-runtime', '1.0.0', { a: '1.0.0', b: '1.0.0', c: '1.0.0' })
  mkdirSync(join(runtime, 'dist'), { recursive: true })
  writeFileSync(join(runtime, 'dist', 'index.js'), 'export {}\n')
  const aDir = join(runtime, 'node_modules', 'a')
  const bDir = join(runtime, 'node_modules', 'b')
  writePkg(aDir, 'a', '1.0.0', { x: '1.0.0', b: '1.0.0' })
  writePkg(bDir, 'b', '1.0.0', { x: '2.0.0', a: '1.0.0' })
  linkDep(join(runtime, 'node_modules'), 'c', cDir)
  linkDep(join(aDir, 'node_modules'), 'x', x1)
  linkDep(join(aDir, 'node_modules'), 'b', bDir)
  linkDep(join(bDir, 'node_modules'), 'x', x2)
  linkDep(join(bDir, 'node_modules'), 'a', aDir)
  return { runtime }
}

describe('auditRuntimeClosure (fixture)', () => {
  it('records every resolution edge, diamonds included, and reports the collision', () => {
    const { runtime } = buildFixture()
    const audit = auditRuntimeClosure(runtime)
    expect(audit.rootName).toBe('root-runtime')
    expect(audit.packages.map(p => `${p.name}@${p.version}`).sort())
      .toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0', 'd@1.0.0', 'x@1.0.0', 'x@2.0.0'])
    const edges = audit.edges.map(e => `${e.consumerName} -> ${e.depName}@${e.depVersion}`).sort()
    expect(edges).toEqual([
      'a -> b@1.0.0',
      'a -> x@1.0.0',
      'b -> a@1.0.0',
      'b -> x@2.0.0',
      'c -> d@1.0.0',
      'root-runtime -> a@1.0.0',
      'root-runtime -> b@1.0.0',
      'root-runtime -> c@1.0.0',
    ])
    expect(audit.collisions).toEqual([{ name: 'x', versions: ['1.0.0', '2.0.0'] }])
    // The collision is real: two distinct consumers resolve it to distinct versions.
    const xEdges = audit.edges.filter(e => e.depName === 'x')
    expect(new Set(xEdges.map(e => e.depVersion)).size).toBe(2)
    expect(new Set(xEdges.map(e => e.consumerReal)).size).toBe(2)
    // The record shapes are the wire contract (staged audit, manifest).
    const xPackage: ClosureAuditPackage | undefined = audit.packages.find(p => p.name === 'x')
    expect(xPackage).toMatchObject({ name: 'x', version: '1.0.0', kind: 'store' })
    const xEdge: ClosureAuditEdge | undefined = audit.edges.find(e => e.consumerName === 'a' && e.depName === 'x')
    expect(xEdge).toMatchObject({ consumerName: 'a', depName: 'x', depVersion: '1.0.0' })
  })

  it('classifies store and workspace packages', () => {
    const { runtime } = buildFixture()
    const audit = auditRuntimeClosure(runtime)
    const byName = new Map(audit.packages.map(p => [p.name, p.kind]))
    expect(byName.get('c')).toBe('store')
    expect(byName.get('x')).toBe('store')
    expect(byName.get('a')).toBe('workspace')
  })

  it('fails loud when the runtime declares a production dependency that is not installed', () => {
    const { runtime } = buildFixture()
    writeFileSync(join(runtime, 'package.json'),
      `${JSON.stringify({ name: 'root-runtime', version: '1.0.0', dependencies: { a: '1.0.0', b: '1.0.0', c: '1.0.0', missing: '9.9.9' } })}\n`)
    expect(() => auditRuntimeClosure(runtime)).toThrow(/missing is not installed/)
  })
})

describe('stageRuntimeClosure (fixture)', () => {
  it('stages non-colliding packages once at the root and colliding ones per consumer', () => {
    const { runtime } = buildFixture()
    const dest = join(work, 'staged')
    const result = stageRuntimeClosure(runtime, dest)
    expect(result.packageCount).toBe(6)
    expect(result.edgeCount).toBe(8)
    expect(result.collisions).toEqual([{ name: 'x', versions: ['1.0.0', '2.0.0'] }])
    const version = (rel: string): string =>
      (JSON.parse(readFileSync(join(dest, rel, 'package.json'), 'utf8')) as { version: string }).version
    // Non-colliding packages: one root copy each, reachable by every
    // consumer's upward walk — including through the a↔b cycle.
    expect(version('node_modules/a')).toBe('1.0.0')
    expect(version('node_modules/b')).toBe('1.0.0')
    expect(version('node_modules/c')).toBe('1.0.0')
    expect(version('node_modules/d')).toBe('1.0.0')
    // The collision shadowed per consumer: this is the case a flat staging
    // gets wrong (first version wins).
    expect(version('node_modules/a/node_modules/x')).toBe('1.0.0')
    expect(version('node_modules/b/node_modules/x')).toBe('2.0.0')
    // The staged runtime keeps its own files.
    expect(existsSync(join(dest, 'package.json'))).toBe(true)
    expect(existsSync(join(dest, 'dist', 'index.js'))).toBe(true)
    // No colliding name at the root, no leaked consumer dependencies.
    expect(existsSync(join(dest, 'node_modules', 'x'))).toBe(false)
    expect(existsSync(join(dest, 'node_modules', 'c', 'node_modules'))).toBe(false)
  })

  it('reports the copy count: root copies plus one shadow per consumer location', () => {
    const { runtime } = buildFixture()
    const dest = join(work, 'staged')
    const result = stageRuntimeClosure(runtime, dest)
    // 4 non-colliding root copies (a, b, c, d) + 2 collision shadows
    // (x under a, x under b) = 6 copies for 6 distinct instances.
    expect(result.destCount).toBe(6)
    expect(result.bytesCopied).toBeGreaterThan(0)
  })
})

describe('closureGraphFingerprint', () => {
  it('is deterministic and changes when a resolution edge changes', () => {
    const { runtime } = buildFixture()
    const audit = auditRuntimeClosure(runtime)
    expect(closureGraphFingerprint(audit)).toBe(closureGraphFingerprint(auditRuntimeClosure(runtime)))
    const swapped: ClosureAudit = {
      ...audit,
      edges: audit.edges.map(e => e.depName === 'x' && e.consumerName === 'a'
        ? { ...e, depVersion: '9.9.9' }
        : e),
    }
    expect(closureGraphFingerprint(swapped)).not.toBe(closureGraphFingerprint(audit))
  })

  it('differs between the fixture graph and the real repository graph', () => {
    const fixture = closureGraphFingerprint(auditRuntimeClosure(buildFixture().runtime))
    const real = closureGraphFingerprint(auditRuntimeClosure(RUNTIME_DIR))
    expect(real).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture).not.toBe(real)
  }, 30_000)
})

describe('auditRuntimeClosure (real repository closure)', () => {
  it('finds the production graph with its same-name/different-version collisions resolved per consumer', () => {
    const audit = auditRuntimeClosure(RUNTIME_DIR)
    expect(audit.packages.length).toBeGreaterThan(100)
    expect(audit.edges.length).toBeGreaterThan(200)
    expect(audit.collisions.length).toBeGreaterThan(0)
    for (const collision of audit.collisions) {
      expect(collision.versions.length).toBeGreaterThan(1)
      // Each colliding version is resolved by at least one distinct consumer.
      const consumers = new Map(collision.versions.map(v => [v, new Set<string>()]))
      for (const edge of audit.edges) {
        if (edge.depName !== collision.name) continue
        const set = consumers.get(edge.depVersion)
        if (set !== undefined) set.add(edge.consumerReal)
      }
      expect([...consumers.values()].every(set => set.size > 0)).toBe(true)
    }
  }, 30_000)
})
