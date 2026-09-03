/**
 * Layer D — the canonical end-to-end user journey: the real, user-facing
 * product path, driven through the rendered UI, on a TRULY fresh profile.
 *
 * This is the one authoritative happy-path E2E. It deliberately does the
 * things the Stage 6 parity suite cannot: it starts from an EMPTY `DSH_HOME`
 * (no seeded workspace registry), so the first workspace is set up through
 * the REAL DSH → native picker path — the OS directory dialog is the one
 * surface an automated driver cannot click, so the test injects a
 * deterministic dialog result through the established Stage 5 seam (the
 * product's own `dialog` port, patched in main) while the DSH action stays
 * real. It then runs the normal workflow a user would:
 *
 *   fresh profile → welcome handled → first workspace added (picker path)
 *   → session → prompt → streamed reply → tool → approval (allow) →
 *   question (answer) → cancel → rename → settings → clean quit → relaunch
 *   → persisted session + history restored
 *
 * Real Electron + real desktop-runtime + real pinned DSH + real client tree;
 * the only non-real element is the deterministic loopback model the pinned
 * DeepSeek provider reaches through `DEEPSEEK_BASE_URL`. Lower tiers (B, C)
 * may use host APIs to isolate failures; this tier exercises the product path.
 *
 * Self-skips without a built app or a GUI session.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ElectronApplication, Page } from 'playwright'
import { _electron as electron } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScriptedProvider, type ScriptedProvider } from './support/deterministic-provider.ts'
import {
  acknowledgeFirstRun,
  awaitDurableTitle,
  clickMenu,
  composerEditable,
  e2eRequired,
  openSidebar,
  rpc,
  skipUnless,
  switchAccessMode,
  waitForShellReady,
  type SessionSummary,
} from './support/electron-world.ts'

const appDir = join(import.meta.dirname, '..')
const mainEntry = join(appDir, 'dist', 'main', 'index.js')
const rendererIndex = join(appDir, 'dist', 'renderer', 'index.html')
const runtimeEntry = join(appDir, '..', 'desktop-runtime', 'dist', 'index.js')
const bundledNode = join(appDir, 'node', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'node.exe' : 'node')

function guiAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
}

const built = existsSync(mainEntry) && existsSync(rendererIndex)
const runtimeBuilt = built && existsSync(runtimeEntry) && existsSync(bundledNode)

const TITLE_TEXT = 'Journey probe title'

describe.skipIf(skipUnless(guiAvailable(), runtimeBuilt))('desktop canonical user journey (fresh profile, real picker)', () => {
  let provider: ScriptedProvider
  let work: string
  let userData: string
  let home: string
  let workspaceDir: string
  let app: ElectronApplication
  let win: Page
  const pageErrors: string[] = []
  const consoleErrors: string[] = []

  const attachConsole = (page: Page): void => {
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
  }

  const assertCleanConsole = (): void => {
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  }

  /**
   * Patch the product's `dialog` port in main so the native directory picker
   * resolves with a deterministic directory (the Stage 5 seam). The DSH
   * directory-picker seat, the native channel, and the main capability all
   * stay real; only the OS click is replaced.
   */
  const stubDirectoryDialog = async (chosenDir: string): Promise<void> => {
    await app.evaluate(({ dialog }, dir) => {
      ;(dialog as unknown as Record<string, unknown>).showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [dir] })
    }, chosenDir)
  }

  const launchApp = (): Promise<ElectronApplication> => electron.launch({
    args: [appDir, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'keyless-user-journey',
      DEEPSEEK_BASE_URL: provider.url,
    },
  })

  beforeAll(async () => {
    if (e2eRequired) {
      if (!guiAvailable()) throw new Error('required canonical E2E lane has no GUI session (DISPLAY/xvfb missing)')
      if (!runtimeBuilt) throw new Error('required canonical E2E lane has no built desktop/runtime; the build step must run first')
    }
    provider = await createScriptedProvider({
      'journey stream turn': [
        { kind: 'text', chunks: [['JOURNEY_PARTIAL_', 200], ['JOURNEY_STREAM_DONE', 200]], finish: true },
      ],
      'journey tool turn': [
        { kind: 'tool', name: 'bash', args: { command: 'echo journey > journey-out.txt', description: 'write the journey file' } },
        { kind: 'text', chunks: [['TOOL_JOURNEY_DONE', 100]], finish: true },
      ],
      'journey approval turn': [
        { kind: 'tool', name: 'bash', args: { command: 'echo journey > approval-out.txt', description: 'write the approval file' } },
        {
          kind: 'tool', name: 'bash',
          args: {
            command: 'echo journey > approval-out.txt', description: 'write the approval file',
            sandbox_permissions: 'workspace-write', justification: 'the read-only sandbox refused the write this task needs',
          },
        },
        { kind: 'text', chunks: [['APPROVAL_JOURNEY_DONE', 100]], finish: true },
      ],
      'journey question turn': [
        {
          kind: 'tool', name: 'ask_user_question',
          args: {
            questions: [{
              id: 'color', question: 'Pick a color for the journey.', header: 'Color',
              options: [{ label: 'Blue' }, { label: 'Green' }],
            }],
          },
        },
        { kind: 'text', chunks: [['QUESTION_JOURNEY_DONE', 100]], finish: true },
      ],
      'journey cancel turn': [
        {
          kind: 'text',
          chunks: [
            ['CANCEL_1', 350], ['CANCEL_2', 350], ['CANCEL_3', 350], ['CANCEL_4', 350],
            ['CANCEL_5', 350], ['CANCEL_6', 350], ['CANCEL_7', 350], ['CANCEL_FINAL', 350],
          ],
          finish: true,
        },
      ],
    }, TITLE_TEXT)
    work = mkdtempSync(join(tmpdir(), 'dsh-user-journey-'))
    userData = join(work, 'user-data')
    home = join(userData, 'harness')
    // The first workspace the user will pick: a real directory, canonicalised
    // through the product's identity canon (see the packaged smoke).
    mkdirSync(join(work, 'journey-ws'), { recursive: true })
    workspaceDir = await realpath(join(work, 'journey-ws'))
    writeFileSync(join(workspaceDir, 'keep.txt'), 'workspace\n')
    // FRESH profile: no seedWorkspaceRegistry. The DSH home is empty.
    app = await launchApp()
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    attachConsole(win)
    await waitForShellReady(win)
    // The welcome / first-run notice is handled exactly as a first-run user
    // would (its backdrop would intercept every later click).
    await acknowledgeFirstRun(win)
  }, 240_000)

  afterAll(async () => {
    if (app !== undefined) await app.close().catch(() => {})
    await provider.close()
    rmSync(work, { recursive: true, force: true })
  }, 120_000)

  it('boots a fresh profile to the real DSH UI with no workspace yet', async () => {
    await win.waitForFunction(() => {
      const globals = globalThis as { __DSH_BOOT__?: unknown }
      return globals.__DSH_BOOT__ !== undefined
    }, undefined, { timeout: 30_000 })
    // Fresh home: the workspace registry is empty — nothing was seeded.
    const workspaces = await rpc<{ items: { workspaceId: string }[] }>(win, 'workspace.list', {}, 'journey')
    expect(workspaces.items).toEqual([])
    assertCleanConsole()
  }, 60_000)

  it('adds the first workspace through the real native picker path', async () => {
    await stubDirectoryDialog(workspaceDir)
    expect(await clickMenu(app, ['File', 'Open Workspace…'])).toBe(true)
    // The picked directory is adopted as a workspace by the real DSH.
    await expect.poll(async () => {
      const workspaces = await rpc<{ items: { workspaceId: string; path: string; title: string }[] }>(win, 'workspace.list', {}, 'journey')
      return workspaces.items
    }, { timeout: 30_000 }).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: workspaceDir }),
    ]))
    // The client connects the workspace and opens its blank session: the
    // unlocked composer is the terminal state of that user-visible path.
    await expect.poll(() => composerEditable(win), { timeout: 60_000 }).toBe(true)
    assertCleanConsole()
  }, 90_000)

  it('streams an assistant reply incrementally', async () => {
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('journey stream turn')
    await composer.press('Enter')
    // Incremental streaming: the partial text must paint BEFORE the final text.
    await win.waitForFunction(
      () => {
        const text = document.body.innerText
        return text.includes('JOURNEY_PARTIAL_') && !text.includes('JOURNEY_STREAM_DONE')
      },
      undefined,
      { timeout: 30_000, polling: 50 },
    )
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('JOURNEY_STREAM_DONE')), { timeout: 30_000 }).toBe(true)
    assertCleanConsole()
  }, 90_000)

  it('runs the bash tool and renders it in the conversation and trajectory', async () => {
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('journey tool turn')
    await composer.press('Enter')
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('TOOL_JOURNEY_DONE')), { timeout: 60_000 }).toBe(true)
    const toolRow = win.locator('[data-chat-flow-key]').filter({ hasText: 'write the journey file' }).first()
    await expect.poll(async () => toolRow.count(), { timeout: 15_000 }).toBe(1)
    await toolRow.click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('journey-out.txt')), { timeout: 15_000 }).toBe(true)
    // The trajectory view carries the same round.
    await win.getByRole('tab', { name: 'Trajectory' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('journey-out.txt')), { timeout: 15_000 }).toBe(true)
    await win.getByRole('tab', { name: 'Chat' }).click()
    // World state: the tool really ran.
    expect(existsSync(join(workspaceDir, 'journey-out.txt'))).toBe(true)
    assertCleanConsole()
  }, 120_000)

  it('asks for approval on a sandbox escalation and runs it after Allow once', async () => {
    await switchAccessMode(win, 'Read Only')
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('journey approval turn')
    await composer.press('Enter')
    const panel = win.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    await panel.getByRole('button', { name: 'Allow once' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('APPROVAL_JOURNEY_DONE')), { timeout: 60_000 }).toBe(true)
    expect(await panel.count()).toBe(0)
    expect(existsSync(join(workspaceDir, 'approval-out.txt'))).toBe(true)
    assertCleanConsole()
  }, 180_000)

  it('answers an ask_user_question through the question composer', async () => {
    await switchAccessMode(win, 'Workspace Write')
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('journey question turn')
    await composer.press('Enter')
    const question = win.locator('[data-question-key]')
    await question.waitFor({ timeout: 60_000 })
    await expect.poll(() => question.getByText('Pick a color for the journey.').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await question.getByRole('radio', { name: /Blue/ }).click()
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('QUESTION_JOURNEY_DONE')), { timeout: 60_000 }).toBe(true)
    expect(await question.count()).toBe(0)
    assertCleanConsole()
  }, 180_000)

  it('cancels a running turn with Stop generating', async () => {
    const composer = win.locator('[data-composer-card] textarea')
    await composer.fill('journey cancel turn')
    await composer.press('Enter')
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('CANCEL_1')), { timeout: 30_000 }).toBe(true)
    const stop = win.getByRole('button', { name: 'Stop generating' })
    await stop.click({ timeout: 10_000 })
    await expect.poll(async () => stop.count(), { timeout: 30_000 }).toBe(0)
    await expect.poll(() => composerEditable(win), { timeout: 30_000 }).toBe(true)
    const sessions = await rpc<{ items: SessionSummary[] }>(win, 'session.list', {}, 'journey')
    expect(sessions.items.every(item => !item.running)).toBe(true)
    assertCleanConsole()
  }, 120_000)

  it('renames the session and persists the title', async () => {
    await openSidebar(win)
    const row = win.locator(`[role="treeitem"]:has(> span:has(button[aria-label="Session actions for ${TITLE_TEXT}"]))`)
    await row.first().waitFor({ timeout: 30_000 })
    await row.first().hover()
    await row.locator('button[aria-label^="Session actions for"]').first().click()
    await win.getByRole('menuitem', { name: 'Rename' }).click()
    const dialog = win.getByRole('dialog')
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.locator('input[aria-label="Session name"]').fill('Journey renamed')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await win.locator('[role="treeitem"]').filter({ hasText: 'Journey renamed' }).first().waitFor({ timeout: 15_000 })
    await awaitDurableTitle(home, 'Journey renamed', 'user', 10_000)
    assertCleanConsole()
  }, 90_000)

  it('reaches the provider and model settings', async () => {
    await openSidebar(win)
    await win.getByRole('button', { name: 'Settings' }).first().click()
    await win.getByRole('tab', { name: 'Models' }).or(win.getByRole('button', { name: 'Models', exact: true })).first().click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('DeepSeek')), { timeout: 15_000 }).toBe(true)
    await win.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
    assertCleanConsole()
  }, 90_000)

  it('restores the session and history after a clean quit and relaunch', async () => {
    // Clean quit (the user's Cmd+Q / window close path), then relaunch the
    // same profile.
    await app.close()
    app = await launchApp()
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    pageErrors.length = 0
    consoleErrors.length = 0
    attachConsole(win)
    await waitForShellReady(win)
    // The first-run acknowledgement persisted: no welcome notice on relaunch.
    expect(await win.getByRole('button', { name: 'Continue' }).count()).toBe(0)
    // Auto-selection restores the workspace and reopens its session.
    await expect.poll(() => composerEditable(win), { timeout: 60_000 }).toBe(true)
    const sessions = await rpc<{ items: SessionSummary[] }>(win, 'session.list', {}, 'journey')
    expect(sessions.items.length).toBeGreaterThanOrEqual(1)
    expect(sessions.items.every(item => !item.running)).toBe(true)
    // The durable rename shows on the cold list (the projection cache
    // checkpointed it during the clean shutdown).
    expect(sessions.items.some(item => item.projections?.values.title === 'Journey renamed')).toBe(true)
    // Reopening the session replays its rendered history: the tool, the
    // approval, and the question rounds are all there.
    await openSidebar(win)
    const sessionRow = win.locator('[role="treeitem"]').filter({ has: win.locator('button[aria-label^="Session actions for"]') }).first()
    await sessionRow.waitFor({ timeout: 15_000 })
    await sessionRow.click()
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('TOOL_JOURNEY_DONE')), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('APPROVAL_JOURNEY_DONE')), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => win.evaluate(() => document.body.innerText.includes('QUESTION_JOURNEY_DONE')), { timeout: 15_000 }).toBe(true)
    assertCleanConsole()
  }, 240_000)
})
