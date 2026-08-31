/**
 * Native-module execution smoke for a packaged artifact: the production-
 * critical native modules must execute real native code under the
 * artifact's own bundled Node, not merely exist on disk.
 *
 * - sharp: create a 1x1 image in memory, read its metadata, and resize it
 *   — the libvips native library (the staged `@img/sharp-*` /
 *   `@img/sharp-libvips-*` prebuilds, nested under the sharp consumer by
 *   the resolution-faithful layout) must load and run.
 * - koffi: load a platform library and make one real FFI call
 *   (GetCurrentProcessId on Windows — the same surface D4 containment
 *   drives; getpid elsewhere).
 *
 * Usage (from the repository root):
 *   node --import tsx/esm apps/desktop/scripts/packaging/smoke-native-modules.ts [artifact]
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/smoke-native-modules
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

/** The artifact's paths, per platform. */
function artifactPaths(artifact: string, platform: NodeJS.Platform): { runtimeDir: string; node: string; manifest: string } {
  const resources = platform === 'darwin'
    ? join(artifact, 'Contents', 'Resources')
    : join(artifact, 'resources')
  const nodeTarget = `${platform}-${process.arch}`
  return {
    runtimeDir: join(resources, 'runtime'),
    node: join(resources, 'node', nodeTarget, platform === 'win32' ? 'node.exe' : 'node'),
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
    throw new Error(`smoke-native-modules: expected exactly one ${platform} artifact under ${outDir}, found ${candidates.length}: ${candidates.join(', ')}`)
  }
  const candidate = candidates[0]
  if (candidate === undefined) throw new Error(`smoke-native-modules: no ${platform} artifact under ${outDir}`)
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
 * Run the native-module execution smoke against one packaged artifact.
 * @param artifact - the `.app` bundle, Windows, or Linux app directory.
 * @param platform - the artifact's platform.
 * @returns the smoke outcome.
 */
export async function runNativeModuleSmoke(artifact: string, platform: NodeJS.Platform): Promise<SmokeResult> {
  const paths = artifactPaths(artifact, platform)
  for (const [label, path] of Object.entries(paths)) {
    if (!existsSync(path)) return { ok: false, detail: `missing ${label} at ${path}` }
  }
  const manifest = readBuildManifest(paths.manifest)
  const sharpDirs = findStagedPackageDirs(paths.runtimeDir, 'sharp')
  const koffiDirs = findStagedPackageDirs(paths.runtimeDir, 'koffi')
  if (sharpDirs.length === 0) return { ok: false, detail: 'sharp is not staged in the artifact' }
  if (koffiDirs.length === 0) return { ok: false, detail: 'koffi is not staged in the artifact' }
  const sharpDir = sharpDirs[0]
  const koffiDir = koffiDirs[0]
  if (sharpDir === undefined || koffiDir === undefined) {
    return { ok: false, detail: 'the staged package search returned no directory' }
  }

  const workDir = mkdtempSync(join(tmpdir(), 'dsh-native-'))
  try {
    const probeScript = join(workDir, 'probe.cjs')
    const probeList = join(workDir, 'targets.json')
    writeFileSync(probeList, `${JSON.stringify({ sharpDir, koffiDir, platform }, null, 2)}\n`)
    writeFileSync(probeScript, `
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { sharpDir, koffiDir, platform } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const failures = []
async function main() {
  // sharp: real libvips work — create, metadata, resize.
  try {
    const requireFromSharpDir = Module.createRequire(path.join(sharpDir, 'anchor.js'))
    const sharp = requireFromSharpDir('sharp')
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer()
    const meta = await sharp(image).metadata()
    if (meta.width !== 1 || meta.height !== 1) failures.push('sharp: 1x1 metadata mismatch (' + meta.width + 'x' + meta.height + ')')
    const resized = await sharp(image).resize(2, 2).png().toBuffer()
    const meta2 = await sharp(resized).metadata()
    if (meta2.width !== 2 || meta2.height !== 2) failures.push('sharp: resize metadata mismatch (' + meta2.width + 'x' + meta2.height + ')')
    console.log('sharp: 1x1 create/metadata/resize executed (libvips loaded)')
  } catch (error) {
    failures.push('sharp: ' + error.message)
  }
  // koffi: one real FFI call into the platform library.
  try {
    const requireFromKoffiDir = Module.createRequire(path.join(koffiDir, 'anchor.js'))
    const koffi = requireFromKoffiDir('koffi')
    let pid
    if (platform === 'win32') {
      const kernel32 = koffi.load('kernel32.dll')
      pid = kernel32.func('uint32 __stdcall GetCurrentProcessId()')()
    } else if (platform === 'darwin') {
      const libSystem = koffi.load('/usr/lib/libSystem.B.dylib')
      pid = libSystem.func('int getpid()')()
    } else {
      const libc = koffi.load('libc.so.6')
      pid = libc.func('int getpid()')()
    }
    if (!Number.isInteger(pid) || pid <= 0) failures.push('koffi: FFI call returned an invalid pid ' + String(pid))
    else console.log('koffi: FFI call executed (pid ' + String(pid) + ')')
  } catch (error) {
    failures.push('koffi: ' + error.message)
  }
  if (failures.length > 0) {
    console.error(failures.join('\\n'))
    process.exit(1)
  }
}
void main()
`)
    execFileSync(paths.node, [probeScript, probeList], {
      cwd: paths.runtimeDir,
      encoding: 'utf8',
      env: { PATH: platform === 'win32' ? 'C:\\Windows\\system32;C:\\Windows' : '/usr/bin:/bin:/usr/sbin:/sbin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, detail: `sharp (libvips) and koffi (FFI) executed under the bundled Node ${manifest.nodeVersion}` }
  } catch (error) {
    const detail = error instanceof Error
      ? `${error.message}\n${'stdout' in error ? String((error as { stdout?: string }).stdout ?? '') : ''}${'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : ''}`
      : String(error)
    return { ok: false, detail: `native-module smoke failed: ${detail.slice(0, 2000)}` }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const explicit = process.argv[2]
  const platform = process.platform
  const artifact = locateArtifact(explicit, platform)
  if (!existsSync(artifact)) {
    console.error(`smoke-native-modules: artifact not found at ${artifact}`)
    process.exit(2)
  }
  const result = await runNativeModuleSmoke(artifact, platform)
  console.log(`smoke-native-modules: ${result.ok ? 'PASS' : 'FAIL'} — ${result.detail}`)
  process.exit(result.ok ? 0 : 1)
}

// Run only as the entry script; the packaging pipeline imports the smoke.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
