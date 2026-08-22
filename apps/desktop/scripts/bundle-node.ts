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

/** Every target the desktop release ships; others require explicit support. */
const ALL_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const
const DIST_BASE = 'https://nodejs.org/dist'

interface NodeTargetSpec {
  file: string
  sha256: string
}

interface NodeManifest {
  version: string
  targets: Record<string, NodeTargetSpec>
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
      if (target === undefined || !ALL_TARGETS.includes(target)) {
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

/** Install one verified Node binary into the app's node/<target> resource. */
async function installTarget(manifest: NodeManifest, target: string, appDir: string): Promise<void> {
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
    const destDir = join(appDir, 'node', target)
    mkdirSync(destDir, { recursive: true })
    const dest = join(destDir, isWindows ? 'node.exe' : 'node')
    cpSync(binary, dest)
    if (!isWindows) chmodSync(dest, 0o755)
    const probe = spawnSync(dest, ['--version'], { encoding: 'utf8' })
    if (probe.status !== 0 || probe.stdout.trim() !== manifest.version) {
      throw new Error(`bundle-node: installed binary self-report failed (wanted ${manifest.version}, got ${JSON.stringify(probe.stdout?.trim())})`)
    }
    console.log(`bundle-node: ${target} -> ${dest} (${manifest.version}, sha256 verified)`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const appDir = join(import.meta.dirname, '..')
  const manifest = JSON.parse(readFileSync(join(appDir, 'node-versions.json'), 'utf8')) as NodeManifest
  const targets = parseTargets(process.argv.slice(2))
  for (const target of targets) {
    await installTarget(manifest, target, appDir)
  }
}

void main()
