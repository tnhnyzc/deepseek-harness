/**
 * Clean-copy boot smoke for a packaged artifact: fork the packaged runtime
 * entry with the artifact's own bundled Node — not the system node — from the
 * artifact's resources, into a fresh throwaway DSH home, and assert the
 * runtime settles to `runtime.ready` (with the manifest's DSH version) and
 * shuts down cleanly. This is the Stage 11 guarantee that the standalone
 * runtime boots from the packaged closure under the packaged Node, with no
 * repository checkout, no first-launch download, and no system Node.
 *
 * Usage (from the repository root):
 *   node --import tsx/esm apps/desktop/scripts/packaging/smoke-runtime.ts [artifact]
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/smoke-runtime
 */

import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readBuildManifest } from './build-manifest.ts'

const appDir = resolve(import.meta.dirname, '..', '..')
const outDir = join(appDir, 'out')

interface SmokeResult {
  ok: boolean
  detail: string
}

/** The artifact's main binary and resources paths, per platform. */
function artifactPaths(artifact: string, platform: NodeJS.Platform): { runtimeDir: string; node: string; entry: string; manifest: string } {
  const resources = platform === 'darwin'
    ? join(artifact, 'Contents', 'Resources')
    : join(artifact, 'resources')
  const nodeTarget = `${platform}-${process.arch}`
  return {
    runtimeDir: join(resources, 'runtime'),
    node: join(resources, 'node', nodeTarget, platform === 'win32' ? 'node.exe' : 'node'),
    entry: join(resources, 'runtime', 'dist', 'index.js'),
    manifest: join(resources, 'build-manifest.json'),
  }
}

/**
 * Locate the packaged artifact: an explicit argument, else the single
 * platform directory the packager produced under `out/`.
 * @param explicit - an artifact path from the CLI.
 * @returns the resolved artifact path.
 */
function locateArtifact(explicit: string | undefined, platform: NodeJS.Platform): string {
  if (explicit !== undefined) return resolve(explicit)
  const candidates = readdirSync(outDir).filter(name => name.includes(`-${platform}-`))
  if (candidates.length !== 1) {
    throw new Error(`smoke-runtime: expected exactly one ${platform} artifact under ${outDir}, found ${candidates.length}: ${candidates.join(', ')}`)
  }
  const candidate = candidates[0]
  if (candidate === undefined) throw new Error(`smoke-runtime: no ${platform} artifact under ${outDir}`)
  const base = join(outDir, candidate)
  return platform === 'darwin' ? join(base, 'DeepSeek Harness Desktop.app') : base
}

/** The throwaway, curated child environment: no repository, no system Node. */
function smokeEnvironment(home: string): Record<string, string> {
  return {
    // A minimal PATH that deliberately omits any node/pnpm install location:
    // the runtime runs under the explicitly-forked bundled Node, so the
    // system node is neither needed nor consulted.
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
    DSH_DESKTOP: '1',
    DSH_HOME: home,
  }
}

/**
 * Run the clean-copy boot smoke against one packaged artifact.
 * @param artifact - the `.app` bundle, Windows, or Linux app directory.
 * @param platform - the artifact's platform.
 * @param timeoutMs - the readiness deadline.
 * @returns the smoke outcome.
 */
export async function runRuntimeSmoke(artifact: string, platform: NodeJS.Platform, timeoutMs = 60_000): Promise<SmokeResult> {
  const paths = artifactPaths(artifact, platform)
  for (const [label, path] of Object.entries(paths)) {
    if (!existsSync(path)) return { ok: false, detail: `missing ${label} at ${path}` }
  }
  const manifest = readBuildManifest(paths.manifest)
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  try {
    const child: ChildProcess = fork(paths.entry, [], {
      execPath: paths.node,
      execArgv: [],
      cwd: paths.runtimeDir,
      env: smokeEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
    })
    let diagnostics = ''
    child.stdout?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })

    return await new Promise<SmokeResult>((resolveResult) => {
      let settled = false
      const timer = setTimeout(() => {
        finish(false, `runtime did not report ready within ${String(timeoutMs)}ms; diagnostics:\n${diagnostics}`)
      }, timeoutMs)
      const finish = (ok: boolean, detail: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const outcome: SmokeResult = { ok, detail }
        // Best-effort teardown: ask for a graceful shutdown, then force-kill
        // past a grace. The deadline is ref'd so the parent outlives the
        // child and always reports the outcome.
        try { if (child.exitCode === null && child.connected) child.send({ type: 'runtime.shutdown' }) } catch { /* child already gone */ }
        const deadline = setTimeout(() => {
          try { if (child.exitCode === null) child.kill('SIGKILL') } catch { /* already gone */ }
          resolveResult(outcome)
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(deadline)
          resolveResult(outcome)
        })
      }
      child.on('message', (message: { type?: unknown; dshVersion?: unknown } | null) => {
        if (message === null || typeof message !== 'object' || message.type !== 'runtime.ready') return
        const reported = String(message.dshVersion)
        if (reported !== manifest.deepseekHarnessVersion) {
          finish(false, `runtime ready reports dshVersion ${reported}, manifest pins ${manifest.deepseekHarnessVersion}`)
          return
        }
        finish(true, `runtime ready (dshVersion ${reported}) under the packaged Node`)
      })
      child.on('error', error => finish(false, `failed to launch packaged runtime: ${error.message}`))
      child.on('exit', (code, signal) => {
        if (!settled) {
          finish(false, `runtime exited before ready (code ${String(code)}, signal ${String(signal)}); diagnostics:\n${diagnostics}`)
        }
      })
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const explicit = process.argv[2]
  const platform = process.platform
  const artifact = locateArtifact(explicit, platform)
  if (!existsSync(artifact)) {
    console.error(`smoke-runtime: artifact not found at ${artifact}`)
    process.exit(2)
  }
  const result = await runRuntimeSmoke(artifact, platform)
  console.log(`smoke-runtime: ${result.ok ? 'PASS' : 'FAIL'} — ${result.detail}`)
  process.exit(result.ok ? 0 : 1)
}

// Run only as the entry script; the packaging pipeline imports the smoke.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
