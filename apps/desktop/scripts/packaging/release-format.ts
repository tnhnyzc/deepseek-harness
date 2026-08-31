/**
 * The distributable release format per platform:
 *
 * - darwin: `ditto` zip of the `.app` bundle (macOS-native; preserves
 *   resource forks, symlinks, and the bundle's directory structure —
 *   `--keepParent` makes the archive root the `.app` itself);
 * - win32: zip of the app directory via Windows PowerShell's
 *   `Compress-Archive` (the only zero-install zip writer on the runner);
 * - linux:  `tar.gz` of the app directory via `tar` (the canonical Linux
 *   distribution format).
 *
 * The archive name carries the desktop version and the packaged target, so
 * the format is a function of build inputs alone:
 * `<product>-<version>-<platform>-<arch>.zip|tar.gz`, plus a `.sha256`
 * sidecar (hex digest of the archive bytes, one line) as the download
 * integrity check. Cross-platform construction of another platform's
 * archive is out of scope by design, as with staging: each CI runner
 * packages its own platform.
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/release-format
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'

/** The distributable format (and archive extension) per node platform name. */
export function releaseArchiveFormat(platform: NodeJS.Platform): 'zip' | 'tar.gz' {
  return platform === 'linux' ? 'tar.gz' : 'zip'
}

/** Run one child process to completion, streaming nothing, failing loud on nonzero exit. */
function runTool(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', error => reject(new Error(`release-format: ${command} failed to start: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolveRun()
      else reject(new Error(`release-format: ${command} ${args.join(' ')} exited ${String(code)}: ${stderr.trim().slice(0, 400)}`))
    })
  })
}

/**
 * Create the distributable archive for one packaged artifact.
 * @param artifact - the `.app` bundle (darwin) or app directory (win32, linux).
 * @param outDir - where the archive (and its `.sha256` sidecar) are written.
 * @param platform - the artifact's node platform name.
 * @param version - the desktop app version (apps/desktop package.json).
 * @param arch - the packaged target architecture.
 * @returns the archive path, its format, and its size in bytes.
 */
export async function createReleaseArchive(
  artifact: string,
  outDir: string,
  platform: NodeJS.Platform,
  version: string,
  arch: string,
): Promise<{ archive: string; format: string; bytes: number; sha256: string }> {
  const format = releaseArchiveFormat(platform)
  const archiveName = `DeepSeek Harness Desktop-${version}-${platform}-${arch}.${format}`
  const archive = join(outDir, archiveName)
  await fsp.rm(archive, { force: true })
  if (platform === 'darwin') {
    await runTool('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', artifact, archive])
  } else if (platform === 'win32') {
    // PowerShell 5.1's Compress-Archive zips the directory as the archive
    // root (the exe and resources stay one level down, as a user expects).
    await runTool('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -LiteralPath '${artifact.replace(/'/g, "''")}' -DestinationPath '${archive.replace(/'/g, "''")}' -Force`,
    ])
  } else {
    // tar -C parent name: the archive root is the app directory itself.
    const parent = resolve(artifact, '..')
    await runTool('tar', ['-czf', archive, '-C', parent, resolve(artifact).slice(parent.length + 1)])
  }
  const bytes = (await fsp.stat(archive)).size
  const digest = createHash('sha256')
  const handle = await fsp.open(archive, 'r')
  try {
    for await (const chunk of handle.createReadStream()) {
      digest.update(chunk as Buffer)
    }
  } finally {
    await handle.close()
  }
  const sha256 = digest.digest('hex')
  await fsp.writeFile(`${archive}.sha256`, `${sha256}  ${archiveName}\n`)
  return { archive, format, bytes, sha256 }
}
