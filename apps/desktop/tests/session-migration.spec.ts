/**
 * Layer D — genuine cross-artifact A→B session `cwd` migration + the
 * production native opener, driven through the rendered UI.
 *
 * Release A is the accepted pre-repin Desktop product (commit 4327dc33, DSH
 * `0.1.1-rc.2`, session format **v0**); release B is this tree (DSH alpha.1,
 * session format **v2**). The two are built independently and this suite runs
 * the real upgrade path a user takes:
 *
 *   1. release A creates a real v0 profile — a workspace (with a sentinel
 *      marker) adopted through the native picker, a session whose `cwd` is
 *      that workspace, and one legitimate turn that performs two `write`
 *      mutations so the "Show in folder" affordance renders;
 *   2. release A quits cleanly and a copy of its DSH home is handed to B;
 *   3. release B opens that copy and its **real** v0→v1→v2 migration runs on
 *      reopen (adjacent generations, the v0 source left untouched);
 *   4. the restored Session `cwd` is asserted equal to the original
 *      normalised workspace;
 *   5. the rendered "Show in folder" affordance is clicked and the resulting
 *      `session/openWorkspacePath` is proved to use that restored `cwd` and
 *      reach the production native-opener seam (main's `shell.openPath`);
 *   6. the workspace sentinel is asserted byte-identical (the open did not
 *      disturb the migrated workspace).
 *
 * `native-boot.spec.ts` remains the separate lower-level native transport
 * coverage; this suite is the A→B migration coverage that is not. The
 * `releasedV0SessionFormatCodec` fixtures stay the narrow codec/migration
 * coverage and do not replace this genuine cross-artifact check.
 *
 * Self-skips without a GUI session or a built release A + B. Point
 * `DSH_RELEASE_A_APP_DIR` at a different release A `apps/desktop` dir.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ElectronApplication, Page } from 'playwright'
import { _electron as electron } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScriptedProvider, type ScriptedProvider, type TurnScript } from './support/deterministic-provider.ts'
import {
  acknowledgeFirstRun,
  clickMenu,
  decodeSessionArtifact,
  e2eRequired,
  legacyComposerEditable,
  legacyComposerSubmit,
  legacyRpc,
  openSidebar,
  rpc,
  skipUnless,
  switchAccessMode,
  waitForShellReady,
  type SessionSummary,
} from './support/electron-world.ts'

const releaseAAppDir = process.env.DSH_RELEASE_A_APP_DIR ?? '/private/tmp/dsh-release-a/apps/desktop'
const releaseBAppDir = join(import.meta.dirname, '..')

const built = (appDir: string): boolean =>
  existsSync(join(appDir, 'dist', 'main', 'index.js')) && existsSync(join(appDir, 'dist', 'renderer', 'index.html'))

function guiAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
}

const TITLE_TEXT = 'Migration v0 session'
const MARKER = 'migration files turn'
const DONE_TEXT = 'MIGRATION_FILES_DONE'
const SENTINEL_FILE = 'sentinel.txt'
const SENTINEL_BYTES = 'dsh-migration-sentinel-0\n'

/** The one legitimate file-producing turn: seven `write` mutations, then a close.
 *  Release B surfaces the "show in folder" overflow affordance only past the
 *  six-chip row, so the turn must produce more than six files. */
const PRODUCED_FILES = ['alpha.txt', 'beta.txt', 'gamma.txt', 'delta.txt', 'epsilon.txt', 'zeta.txt', 'eta.txt']
const PROVIDER_TURNS: TurnScript = {
  [MARKER]: [
    ...PRODUCED_FILES.map(name => ({ kind: 'tool' as const, name: 'write', args: { file_path: name, content: `${name}\n` } })),
    { kind: 'text', chunks: [[DONE_TEXT, 50]], finish: true },
  ],
}

/** Find the first session log (plain or zstd) under a DSH home. */
function findSessionLog(home: string): string | null {
  const logs: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd') logs.push(path)
    }
  }
  walk(join(home, 'sessions'))
  return logs[0] ?? null
}

/** The session generation files (v0 source + any migrated successors) in one dir. */
function generationFiles(sessionDir: string): string[] {
  if (!existsSync(sessionDir)) return []
  return readdirSync(sessionDir).filter(name => name.startsWith('session.') && (name.endsWith('.jsonl') || name.endsWith('.zstd')))
}

/**
 * A bounded poll for setup hooks, where `expect.poll` is not permitted (it is
 * test-body only). Fails with the condition that did not become true.
 */
async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
}

describe.skipIf(skipUnless(guiAvailable(), built(releaseAAppDir), built(releaseBAppDir)))('desktop A→B session cwd migration + native opener', () => {
  let provider: ScriptedProvider
  let work: string
  let aHome: string
  let bUserData: string
  let workspaceDir: string
  let v0Log: string
  let bSessionDir: string
  let app: ElectronApplication
  let win: Page

  const launch = (appDir: string, userData: string): Promise<ElectronApplication> => electron.launch({
    args: [appDir, `--user-data-dir=${userData}`],
    env: { ...process.env, DEEPSEEK_API_KEY: 'keyless-session-migration', DEEPSEEK_BASE_URL: provider.url },
  })

  /** Patch main's production opener to record the paths it is handed. */
  const patchNativeOpen = async (): Promise<void> => {
    await app.evaluate(({ shell }) => {
      const state = globalThis as unknown as { __dshOpenPaths?: string[] }
      state.__dshOpenPaths = []
      ;(shell as unknown as Record<string, unknown>).openPath = (path: string) => {
        state.__dshOpenPaths!.push(path)
        return Promise.resolve('')
      }
    })
  }
  const readNativeOpenPaths = async (): Promise<string[]> =>
    app.evaluate(() => (globalThis as unknown as { __dshOpenPaths?: string[] }).__dshOpenPaths ?? [])

  beforeAll(async () => {
    if (e2eRequired) {
      if (!guiAvailable()) throw new Error('required A→B E2E lane has no GUI session (DISPLAY/xvfb missing)')
      if (!built(releaseAAppDir)) throw new Error(`required A→B E2E lane has no built release A at ${releaseAAppDir}`)
      if (!built(releaseBAppDir)) throw new Error('required A→B E2E lane has no built release B; the build step must run first')
    }
    provider = await createScriptedProvider(PROVIDER_TURNS, TITLE_TEXT)
    work = mkdtempSync(join(tmpdir(), 'dsh-session-migration-'))
    // The controlled workspace: a real directory, canonicalised like the product, with a sentinel.
    mkdirSync(join(work, 'mig-ws'), { recursive: true })
    workspaceDir = await realpath(join(work, 'mig-ws'))
    writeFileSync(join(workspaceDir, SENTINEL_FILE), SENTINEL_BYTES)

    // ---- Release A: create the genuine v0 profile. ----
    aHome = join(work, 'a-user-data', 'harness')
    const aApp = await launch(releaseAAppDir, join(work, 'a-user-data'))
    const aWin = await aApp.firstWindow()
    await aWin.waitForLoadState('domcontentloaded')
    await waitForShellReady(aWin)
    await acknowledgeFirstRun(aWin)
    // Adopt the workspace through the real native picker path (only the OS click is stubbed).
    await aApp.evaluate(({ dialog }, dir) => {
      ;(dialog as unknown as Record<string, unknown>).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
    }, workspaceDir)
    expect(await clickMenu(aApp, ['File', 'Open Workspace…'])).toBe(true)
    await pollUntil(async () => {
      const workspaces = await legacyRpc<{ items: { path: string }[] }>(aWin, 'workspace.list', {}, 'a-ws')
      return workspaces.items.some(item => item.path === workspaceDir)
    }, 30_000, 'the adopted workspace to be listed')
    await pollUntil(() => legacyComposerEditable(aWin), 60_000, 'the composer to become editable')
    // Writes resolve against the adopted workspace's cwd.
    await switchAccessMode(aWin, 'Workspace Write')
    await legacyComposerSubmit(aWin, MARKER)
    await pollUntil(() => aWin.evaluate((text: string) => document.body.innerText.includes(text), DONE_TEXT), 90_000, 'the file-producing turn to render')
    // World state: the writes really ran in the workspace.
    for (const name of PRODUCED_FILES) expect(existsSync(join(workspaceDir, name))).toBe(true)
    const aSessions = await legacyRpc<{ items: SessionSummary[] }>(aWin, 'session.list', {}, 'a-list')
    expect(aSessions.items.map(item => item.cwd)).toContain(workspaceDir)
    // Clean shutdown (the user's quit path).
    await aApp.close()

    // Verify the on-disk profile is a genuine v0 artifact with the controlled cwd.
    const foundLog = findSessionLog(aHome)
    if (foundLog === null) throw new Error('release A profile has no session log; the v0 profile was not created')
    v0Log = foundLog
    const v0Header = JSON.parse(decodeSessionArtifact(v0Log).split('\n')[0]!) as { version: number; cwd?: string }
    expect(v0Header.version).toBe(0)
    expect(v0Header.cwd).toBe(workspaceDir)

    // ---- Hand a copy of the A user data to release B (a fresh B profile). ----
    // Only the user-owned state crosses the upgrade (sessions, workspace
    // registry, settings, identity); the installed DSH app (profiles/) stays
    // release B's own build so it boots against its own harness.
    bUserData = join(work, 'b-user-data')
    mkdirSync(bUserData, { recursive: true })
    cpSync(aHome, join(bUserData, 'harness'), {
      recursive: true,
      filter: source => !source.replace(/\\/g, '/').endsWith('/profiles') && !source.replace(/\\/g, '/').endsWith('/profiles/'),
    })
    // The v2 generation is published beside the v0 source IN THE RELEASE B HOME
    // (the copy release B opens), not the release A home. Resolve that dir from
    // the copied v0 log so the migration assertion checks the right place.
    const bCopiedLog = findSessionLog(join(bUserData, 'harness'))
    if (bCopiedLog === null) throw new Error('the release B copy lost the v0 session log; the migration cannot be verified')
    bSessionDir = join(bCopiedLog, '..')

    // ---- Release B: open the copy (its real v0→v1→v2 migration runs on list). ----
    app = await launch(releaseBAppDir, bUserData)
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await waitForShellReady(win)
    await acknowledgeFirstRun(win)
    // B opens to a blank view; the migrated session must be listed with the
    // original cwd (its v0→v2 migration ran on this open).
    await pollUntil(async () => {
      const sessions = await rpc<{ items: SessionSummary[] }>(win, 'session/list', { _request: {} }, 'b-ready')
      return sessions.items.some(item => item.cwd === workspaceDir)
    }, 60_000, 'the migrated session to be listed with the original cwd')
  }, 420_000)

  afterAll(async () => {
    if (app !== undefined) await app.close().catch(() => {})
    await provider.close()
    if (process.env.KEEP_WORK !== '1') rmSync(work, { recursive: true, force: true })
    else console.error(`[session-migration] KEEP_WORK set; work dir preserved at ${work}`)
  }, 120_000)

  it('release B restores the migrated session cwd unchanged, beside the untouched v0 source', async () => {
    // Reopen the migrated session through the sidebar; reading its log runs the
    // real v0→v1→v2 migration (an adjacent generation is published, v0 untouched).
    await openSidebar(win)
    const sessionRow = win.locator('[role="treeitem"]').filter({ has: win.locator('button[aria-label^="Session actions for"]') }).first()
    await sessionRow.waitFor({ timeout: 30_000 })
    await sessionRow.click()
    // The restored cwd is the original normalised workspace.
    const sessions = await rpc<{ items: SessionSummary[] }>(win, 'session/list', { _request: {} }, 'b-list')
    const migrated = sessions.items.find(item => item.cwd === workspaceDir)
    expect(migrated).toBeDefined()
    expect(migrated!.cwd).toBe(workspaceDir)
    // Adjacent migration: a v2 generation was published beside the untouched v0
    // source in the release B home.
    await expect.poll(async () => {
      const generations = generationFiles(bSessionDir)
      return generations.some(name => name.startsWith('session.v2.'))
        && generations.some(name => name === 'session.jsonl' || name === 'session.jsonl.zstd')
    }, { timeout: 30_000 }).toBe(true)
  }, 120_000)

  it('the Show-in-folder affordance opens the restored cwd through the production native opener', async () => {
    // Release B shows the overflow affordance only past the six-chip row, so the
    // replayed turn produces more than six files to surface it.
    const showInFolder = win.getByRole('button', { name: /Show in folder|在文件夹中显示/ })
    await expect.poll(() => showInFolder.count(), { timeout: 60_000 }).toBe(1)
    // Record what the production opener (main's shell.openPath) is handed, then open.
    await patchNativeOpen()
    await showInFolder.click()
    // The opener is handed the workspace with the "." suffix (cwd + "/.");
    // normalise before comparing so the assertion matches the restored folder.
    await expect
      .poll(async () => {
        const paths = await readNativeOpenPaths()
        const normalised = await Promise.all(paths.map(async (p) => { try { return await realpath(p) } catch { return p } }))
        return normalised.includes(workspaceDir)
      }, { timeout: 30_000 })
      .toBe(true)
  }, 180_000)

  it('the workspace sentinel and release A files are untouched by the migration and the open', async () => {
    expect(readFileSync(join(workspaceDir, SENTINEL_FILE), 'utf8')).toBe(SENTINEL_BYTES)
    for (const name of PRODUCED_FILES) expect(existsSync(join(workspaceDir, name))).toBe(true)
  }, 30_000)
})
