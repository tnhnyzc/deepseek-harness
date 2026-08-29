/**
 * Download and verify the pinned Node release the desktop runtime runs
 * under. The Node executable is a packaged resource: it is installed at
 * build time into `node/<target>/` and never fetched at application
 * launch. Checksums are the committed digests from nodejs.org's official
 * SHASUMS256.txt for the pinned release, verified before extraction.
 *
 * Usage: `pnpm --filter @deepseek-ai/dsh-desktop bundle:node`
 * (current platform target; `--target <t>` or `--all` for release builds).
 * @module @deepseek-ai/dsh-desktop/scripts/bundle-node
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Every target the desktop release ships; others require explicit support. */
const ALL_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const
const DIST_BASE = 'https://nodejs.org/dist'

export interface NodeTargetSpec {
  file: string
  sha256: string
}

/** The node-versions.json pin table. */
export interface NodeManifest {
  version: string
  targets: Record<string, NodeTargetSpec>
}

/**
 * Download, checksum-verify, and extract the pinned Node for one target.
 * Installs `node(.exe)` plus the distribution `LICENSE` into
 * `<destBaseDir>/<target>/`. The self-report probe runs only when the
 * installed binary can execute on this host.
 * @param manifest - the node-versions.json contents.
 * @param target - the node target name (`darwin-arm64`, ...).
 * @param destBaseDir - the directory that receives the `<target>/` subtree.
 */
export async function installNodeTarget(manifest: NodeManifest, target: string, destBaseDir: string): Promise<void> {
  const spec = manifest.targets[target]
  if (spec === undefined) {
    throw new Error(`bundle-node: target ${target} has no pinned digest in node-versions.json`)
  }
  const url = `${DIST_BASE}/${manifest.version}/${spec.file}`
  const workDir = join(tmpdir(), `dsh-bundle-node-${randomUUID()}`)
  try {
    const archive = join(workDir, spec.file)
    await download(url, archive)
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    if (digest !== spec.sha256) {
      throw new Error(`bundle-node: checksum mismatch for ${spec.file}: expected ${spec.sha256}, got ${digest}`)
    }
    const isWindows = target === 'win32-x64'
    const binary = extractNodeBinary(archive, `node-${manifest.version}-${target.replace('win32', 'win')}`, isWindows)
    const destDir = join(destBaseDir, target)
    mkdirSync(destDir, { recursive: true })
    const dest = join(destDir, isWindows ? 'node.exe' : 'node')
    cpSync(binary, dest)
    if (!isWindows) chmodSync(dest, 0o755)
    const license = join(workDir, 'extract', `node-${manifest.version}-${target.replace('win32', 'win')}`, 'LICENSE')
    if (existsSync(license)) cpSync(license, join(destDir, 'LICENSE'))
    // A foreign-architecture binary cannot be probed on this host; for
    // cross targets the checksum plus the target runner's boot are the
    // verification.
    if (target === `${process.platform}-${process.arch}`) {
      const probe = spawnSync(dest, ['--version'], { encoding: 'utf8' })
      if (probe.status !== 0 || probe.stdout.trim() !== manifest.version) {
        throw new Error(`bundle-node: installed binary self-report failed (wanted ${manifest.version}, got ${JSON.stringify(probe.stdout?.trim())})`)
      }
    }
    console.log(`bundle-node: ${target} -> ${dest} (${manifest.version}, sha256 verified)`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** Parse `--target <t>` (repeatable) and `--all`; default is this platform. */
function parseTargets(argv: string[]): string[] {
  const targets: string[] = []
  let all = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--all') {
      all = true
    } else if (arg === '--target') {
      i += 1
      const target = argv[i]
      if (target === undefined || !(ALL_TARGETS as readonly string[]).includes(target)) {
        throw new Error(`bundle-node: unsupported --target ${String(target)}; supported: ${ALL_TARGETS.join(', ')}`)
      }
      targets.push(target)
    } else {
      throw new Error(`bundle-node: unknown argument ${JSON.stringify(arg)}`)
    }
  }
  if (all) return [...ALL_TARGETS]
  if (targets.length > 0) return targets
  return [`${process.platform}-${process.arch}`]
}

/** Download one file, failing loud on any non-2xx response. */
async function download(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const response = await fetch(url)
  if (!response.ok) throw new Error(`bundle-node: download failed: HTTP ${String(response.status)} for ${url}`)
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()))
}

/** Extract the archive with the platform tar (xz and zip) and locate the binary. */
function extractNodeBinary(archive: string, archiveBase: string, isWindows: boolean): string {
  const workDir = join(dirname(archive), 'extract')
  mkdirSync(workDir, { recursive: true })
  const tar = spawnSync('tar', ['-xf', archive, '-C', workDir], { stdio: 'inherit' })
  if (tar.status !== 0) throw new Error('bundle-node: archive extraction failed')
  const binary = join(workDir, `${archiveBase}`, isWindows ? 'node.exe' : 'bin/node')
  if (!existsSync(binary)) throw new Error(`bundle-node: extracted archive missing the Node binary at ${binary}`)
  return binary
}

async function main(): Promise<void> {
  const appDir = join(import.meta.dirname, '..')
  const manifest = JSON.parse(readFileSync(join(appDir, 'node-versions.json'), 'utf8')) as NodeManifest
  const targets = parseTargets(process.argv.slice(2))
  for (const target of targets) {
    await installNodeTarget(manifest, target, join(appDir, 'node'))
  }
}

// Run only as the entry script; `installNodeTarget` is also imported by the
// packaging pipeline, where this CLI must stay inert.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
