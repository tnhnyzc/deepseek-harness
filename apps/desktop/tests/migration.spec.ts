/**
 * Layer D — migration safety: a user's persisted data written by one release
 * must open intact under a fresh instance of the current release (the A→B
 * upgrade check). This spec runs the migration harness ({@link ./support/migration.ts}):
 *
 * - Phase A generates a realistic "release A" profile (workspace + a session
 *   with a streamed and a tool turn + a user-set durable title) through the
 *   current app;
 * - Phase B boots a FRESH instance at that same profile ("release B") and
 *   verifies the workspace, the session, its durable title, and its recorded
 *   content all survive.
 *
 * Pre-release honesty: no prior released artifact exists to upgrade FROM, so
 * Phase A is a same-format stand-in for a real prior release's data. The
 * harness's `verifyMigratedData` is what a true cross-artifact A→B check will
 * run once a prior release ships — point it at that release's user-data dir.
 * The invariant this proves now is the one a future A→B must preserve: the
 * current release's persisted data is intact under a fresh instance of itself.
 *
 * Self-skips without a GUI or a built desktop/runtime; a required lane
 * (DSH_DESKTOP_E2E_REQUIRED=1) fails loudly instead.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScriptedProvider, type ScriptedProvider } from './support/deterministic-provider.ts'
import { e2eRequired, sessionLogTitles, skipUnless } from './support/electron-world.ts'
import {
  cleanupWork,
  createMigrationFixture,
  newWorkRoot,
  toolFileExists,
  verifyMigratedData,
  type MigrationFixture,
} from './support/migration.ts'

const appDir = join(import.meta.dirname, '..')
const mainEntry = join(appDir, 'dist', 'main', 'index.js')
const rendererIndex = join(appDir, 'dist', 'renderer', 'index.html')
const runtimeEntry = join(appDir, '..', 'desktop-runtime', 'dist', 'index.js')
const bundledNode = join(appDir, 'node', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'node.exe' : 'node')

function guiAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
}

const runtimeBuilt = existsSync(mainEntry) && existsSync(rendererIndex) && existsSync(runtimeEntry) && existsSync(bundledNode)

describe.skipIf(skipUnless(guiAvailable(), runtimeBuilt))('desktop migration (user data across a release upgrade)', () => {
  let provider: ScriptedProvider
  let work: string
  let fixture: MigrationFixture

  beforeAll(async () => {
    if (e2eRequired) {
      if (!guiAvailable()) throw new Error('required migration lane has no GUI session (DISPLAY/xvfb missing)')
      if (!runtimeBuilt) throw new Error('required migration lane has no built desktop/runtime; the build step must run first')
    }
    provider = await createScriptedProvider({
      'migration stream turn': [
        { kind: 'text', chunks: [['MIGRATION_STREAM_DONE', 120]], finish: true },
      ],
      'migration tool turn': [
        { kind: 'tool', name: 'bash', args: { command: 'echo migrated > migrated-out.txt', description: 'write the migrated file' } },
        { kind: 'text', chunks: [['MIGRATION_TOOL_DONE', 100]], finish: true },
      ],
    }, 'Migrated auto title')
    work = newWorkRoot('dsh-migration-')
    // Phase A: generate the "release A" profile.
    fixture = await createMigrationFixture(provider, work, 'Migrated auto title')
  }, 300_000)

  afterAll(async () => {
    await provider.close()
    cleanupWork(work)
  }, 120_000)

  it('release A left complete, durable user data on disk', async () => {
    // The tool really ran in the workspace (world state persisted).
    expect(toolFileExists(fixture)).toBe(true)
    // The user-set title is durable in the on-disk session log (source "user").
    const titleRows = Object.values(sessionLogTitles(fixture.home)).flat()
    expect(titleRows.some(row => row.title === fixture.durableTitle && row.source === 'user')).toBe(true)
  }, 30_000)

  it('release B opens the release A profile intact', async () => {
    const result = await verifyMigratedData(fixture.userData, fixture)
    // The first-run acknowledgement persisted across the upgrade.
    expect(result.firstRunCount).toBe(0)
    // The workspace is still listed.
    expect(result.workspaceListed).toBe(true)
    // The session survived with its durable title on the cold list, not running.
    expect(result.sessions.length).toBeGreaterThanOrEqual(1)
    expect(result.sessions.every(item => !item.running)).toBe(true)
    expect(result.titleOnColdList).toBe(true)
    // Reopening the session replays its recorded content.
    expect(result.contentReplayed).toBe(true)
  }, 180_000)
})
