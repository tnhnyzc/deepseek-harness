/**
 * Stage 11 packaging pins: the release fuses are declared exhaustively (no
 * Electron default can drift), the build-manifest reader bound-checks the
 * shipped artifact, and — when a packaged artifact is present — its layout
 * verifies against the release contract. The closure fingerprint is
 * graph-identity based (edge-sensitive, deterministic) and is covered by
 * closure-audit.spec.ts. The layout block self-skips without a built
 * artifact so a clean checkout stays green; the `package` pipeline runs it
 * (and the execution smokes) as its own gates.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBuildManifest, type BuildManifest } from '../scripts/packaging/build-manifest.ts'
import { DESKTOP_FUSES, DESKTOP_FUSE_CONFIG, DESKTOP_FUSE_INDICES, electronBinaryPath } from '../scripts/packaging/fuses.ts'
import { layoutVerdict, verifyArtifactLayout } from '../scripts/packaging/verify-layout.ts'
import { releaseArchiveFormat } from '../scripts/packaging/release-format.ts'

const APP_ROOT = join(import.meta.dirname, '..')
const OUT_DIR = join(APP_ROOT, 'out')

/** The single packaged artifact for this platform, or undefined when absent. */
function locateArtifact(): { artifact: string; platform: NodeJS.Platform; arch: string; target: string } | undefined {
  if (!existsSync(OUT_DIR)) return undefined
  const platform = process.platform
  const arch = process.arch
  const base = join(OUT_DIR, `DeepSeek Harness Desktop-${platform}-${arch}`)
  const artifact = platform === 'darwin' ? join(base, 'DeepSeek Harness Desktop.app') : base
  if (!existsSync(artifact)) return undefined
  return { artifact, platform, arch, target: `${platform}-${arch}` }
}

/** A well-formed build manifest for reader tests. */
function manifestFixture(): BuildManifest {
  return {
    schemaVersion: 2,
    desktopVersion: '0.0.0',
    deepseekHarnessCommit: 'a'.repeat(40),
    deepseekHarnessVersion: '0.0.0',
    nodeVersion: 'v0.0.0',
    nodeSha256: 'b'.repeat(64),
    electronVersion: '0.0.0',
    desktopProtocolVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    closureFingerprint: 'c'.repeat(64),
  }
}

// ---- fuses: exhaustive, explicit, no default drift ----

describe('release fuses', () => {
  it('declares exactly the nine fuses Electron 43 supports, indexed 0..8', () => {
    expect(DESKTOP_FUSE_INDICES).toHaveLength(9)
    expect([...DESKTOP_FUSE_INDICES].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('sets every fuse explicitly (no key left to a default)', () => {
    for (const index of DESKTOP_FUSE_INDICES) {
      expect(typeof DESKTOP_FUSES[index]).toBe('boolean')
      expect(typeof DESKTOP_FUSE_CONFIG[index]).toBe('boolean')
    }
  })

  it('pins the security-critical fuses to their release values', () => {
    // Indices: 0 RunAsNode, 4 AsarIntegrity, 5 OnlyLoadAppFromAsar, 7 FilePrivileges.
    expect(DESKTOP_FUSES[0]).toBe(false)
    expect(DESKTOP_FUSES[4]).toBe(true)
    expect(DESKTOP_FUSES[5]).toBe(true)
    expect(DESKTOP_FUSES[7]).toBe(false)
    expect(DESKTOP_FUSE_CONFIG.strictlyRequireAllFuses).toBe(true)
  })

  it('resolves the main binary path per platform', () => {
    expect(electronBinaryPath('/x/DeepSeek Harness Desktop.app', 'darwin'))
      .toBe('/x/DeepSeek Harness Desktop.app/Contents/MacOS/DeepSeek Harness Desktop')
    expect(electronBinaryPath('/x/app', 'win32')).toBe(join('/x', 'app', 'DeepSeek Harness Desktop.exe'))
    expect(electronBinaryPath('/x/app', 'linux')).toBe(join('/x', 'app', 'DeepSeek Harness Desktop'))
  })
})

// ---- build manifest: deterministic fingerprint, bound-checked reader ----

describe('release archive format', () => {
  it('pins the per-platform distributable format', () => {
    expect(releaseArchiveFormat('darwin')).toBe('zip')
    expect(releaseArchiveFormat('win32')).toBe('zip')
    expect(releaseArchiveFormat('linux')).toBe('tar.gz')
  })
})

describe('build manifest', () => {
  let scratch: string

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('reader accepts a well-formed manifest', () => {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-manifest-'))
    const manifest = manifestFixture()
    const path = join(scratch, 'build-manifest.json')
    writeFileSync(path, JSON.stringify(manifest))
    expect(readBuildManifest(path)).toEqual(manifest)
  })

  it('reader rejects an unsupported schema version', () => {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-manifest-'))
    const path = join(scratch, 'build-manifest.json')
    // Every field present so the only fault is the schema version.
    writeFileSync(path, `${JSON.stringify({
      ...manifestFixture(),
      schemaVersion: 999,
    })}\n`)
    expect(() => readBuildManifest(path)).toThrow(/schemaVersion/)
  })

  it('reader rejects a manifest missing a field', () => {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-manifest-'))
    const path = join(scratch, 'build-manifest.json')
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 2 })}\n`)
    expect(() => readBuildManifest(path)).toThrow(/missing/)
  })
})

// ---- packaged artifact layout (self-skips without a built artifact) ----

const located = locateArtifact()

describe.skipIf(!located)('packaged artifact layout', () => {
  it('verifies the release contract against the built artifact', async () => {
    if (!located) throw new Error('artifact not located (describe.skipIf guard)')
    const { artifact, platform, arch, target } = located
    expect(artifact).toBeDefined()
    const report = await verifyArtifactLayout(artifact, platform, arch, target)
    if (!report.checks.every(c => c.ok)) {
      throw new Error(layoutVerdict(report))
    }
    // The shipped manifest round-trips: the artifact carries its identity.
    const resources = platform === 'darwin' ? join(artifact, 'Contents', 'Resources') : join(artifact, 'resources')
    const shipped = readBuildManifest(join(resources, 'build-manifest.json'))
    expect(shipped.platform).toBe(platform)
    expect(shipped.arch).toBe(arch)
    expect(shipped.closureFingerprint).toMatch(/^[0-9a-f]{64}$/)
    // The manifest is readable plain text (not just parseable by us).
    expect(readFileSync(join(resources, 'build-manifest.json'), 'utf8').trim().length).toBeGreaterThan(0)
  }, 120_000)
})
