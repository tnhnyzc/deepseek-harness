/**
 * Packaged-app execution, as a suite gate: launches the actual packaged
 * Electron executable and proves the Stage 11 execution contract (real DSH
 * UI, security baseline, live native channel, bounded carrier round trip,
 * zero product listeners, crash/restart to a fresh generation). Self-skips
 * without a built artifact or a GUI session, so a clean checkout stays
 * green; the `package` pipeline and the CI lanes run it for real.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guiAvailable, runPackagedAppSmoke } from '../scripts/smoke-packaged-app.ts'

const APP_ROOT = join(import.meta.dirname, '..')
const OUT_DIR = join(APP_ROOT, 'out')

/** The single packaged artifact for this platform, or undefined when absent. */
function locateArtifact(): { artifact: string; platform: NodeJS.Platform } | undefined {
  if (!existsSync(OUT_DIR)) return undefined
  const platform = process.platform
  // Directories only: the distributable archive and its .sha256 sidecar sit
  // beside the artifact directory under `out/`.
  const candidates = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.includes(`-${platform}-`))
    .map(entry => entry.name)
  if (candidates.length !== 1) return undefined
  const candidate = candidates[0]
  if (candidate === undefined) return undefined
  const base = join(OUT_DIR, candidate)
  const artifact = platform === 'darwin' ? join(base, 'DeepSeek Harness Desktop.app') : base
  return existsSync(artifact) ? { artifact, platform } : undefined
}

const located = locateArtifact()

describe.skipIf(!located || !guiAvailable())('packaged app execution', () => {
  it('launches the actual packaged executable and proves the execution contract', async () => {
    if (located === undefined) throw new Error('artifact not located (describe.skipIf guard)')
    const result = await runPackagedAppSmoke(located.artifact, located.platform)
    expect(result.ok, result.detail).toBe(true)
  }, 900_000)
})
