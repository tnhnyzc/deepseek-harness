/**
 * Shared Playwright "world" helpers for the desktop desktop-integration (C)
 * and end-to-end (D) suites.
 *
 * These are the interaction and persistence primitives the suites drive the
 * REAL renderer with (the pinned DSH client tree over the desktop transport).
 * They deliberately talk to the UI through the same surfaces a user does —
 * the composer, the sidebar, the row menus, the settings dialog — and read
 * durable state through the on-disk session logs, never through a test-only
 * backdoor. Every wait is bounded and fails with the condition that did not
 * become true.
 *
 * The renderer is unprivileged (contextIsolation, sandboxed, no Node); the
 * only bridge this layer uses is the product's own `__DSH_TRANSPORT__` fetch
 * carrier, which is how the shipped client calls the host plane.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'

/**
 * A required CI lane sets `DSH_DESKTOP_E2E_REQUIRED=1` to say "this lane MUST
 * run the suite". On such a lane a missing precondition (no GUI, no built
 * runtime, no artifact) is a loud failure, never a self-skip: a vacuous pass
 * on a lane that is supposed to execute the test is a worse outcome than a red
 * lane. Headless or un-built local checkouts (no flag) skip cleanly instead.
 */
export const e2eRequired = process.env.DSH_DESKTOP_E2E_REQUIRED === '1'

/**
 * A `describe.skipIf` predicate. On a required lane it always returns `false`
 * (the suite runs; a missing precondition then throws in `beforeAll`).
 * Otherwise it skips when any precondition is unmet.
 */
export function skipUnless(...preconditions: boolean[]): boolean {
  if (e2eRequired) return false
  return !preconditions.every(Boolean)
}

/** One node of the live native menu dump. */
export interface MenuNode {
  label: string
  role?: string | undefined
  accelerator?: string | null
  enabled: boolean
  children: MenuNode[]
}

/** Dump the live native menu as a plain structure the test can assert on. */
export async function menuDump(app: ElectronApplication): Promise<MenuNode[] | null> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    if (menu === null) return null
    const walk = (items: Electron.MenuItem[]): MenuNode[] =>
      items.map(item => ({
        label: item.label,
        role: item.role,
        accelerator: item.accelerator,
        enabled: item.enabled,
        children: item.submenu === null || item.submenu === undefined ? [] : walk(item.submenu.items),
      }))
    return walk(menu.items)
  })
}

/** Click a native menu item by its top-down label path in the main process. */
export async function clickMenu(app: ElectronApplication, path: string[]): Promise<boolean> {
  return app.evaluate(({ Menu }, labels) => {
    const menu = Menu.getApplicationMenu()
    if (menu === null) return false
    let pool: Electron.MenuItem[] = menu.items
    let found: Electron.MenuItem | undefined
    for (const label of labels) {
      const item = pool.find(candidate => candidate.label === label)
      if (item === undefined) return false
      found = item
      if (item.submenu !== null && item.submenu !== undefined) pool = item.submenu.items
    }
    found?.click()
    return true
  }, path)
}

interface RpcEnvelope<T> {
  type: string
  result: { ok: boolean; value: T; error?: { code?: string; message?: string } }
}

/**
 * Drive one host-plane RPC through the renderer's own transport carrier —
 * the exact path the shipped client uses. Resolves the envelope value or
 * throws with the host error.
 */
export async function rpc<T>(win: Page, method: string, payload: unknown, tag: string): Promise<T> {
  return win.evaluate(async ({ m, p, t }: { m: string; p: unknown; t: string }) => {
    const transport = globalThis as unknown as { __DSH_TRANSPORT__: { fetch: (input: URL, init: RequestInit) => Promise<Response> } }
    const response = await transport.__DSH_TRANSPORT__.fetch(new URL(`/api/${m}`, location.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `${t}-${m}`, method: m, payload: p }),
    })
    return JSON.parse(await response.text()) as RpcEnvelope<T>
  }, { m: method, p: payload, t: tag }).then((envelope) => {
    if (!envelope.result.ok) throw new Error(`${method} failed: ${envelope.result.error?.code}: ${envelope.result.error?.message}`)
    return envelope.result.value
  })
}

export interface SessionSummary {
  sessionId: string
  blank: boolean
  running: boolean
  cwd?: string
  /** Projection baseline for the row (the cold list's title hint). */
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

/** The conversation composer is live when its textarea is writable. */
export function composerEditable(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const el = document.querySelector('[data-composer-card] textarea') as HTMLTextAreaElement | null
    return el !== null && !el.readOnly
  })
}

/**
 * Wait for the shell to project readiness (or a failure), then assert it is
 * ready. Fails with the projected state if it settles failed.
 */
export async function waitForShellReady(win: Page, timeoutMs = 120_000): Promise<void> {
  await win.waitForFunction(() => {
    const state = document.getElementById('root')?.dataset.state
    return state === 'ready' || state === 'failed'
  }, undefined, { timeout: timeoutMs })
  const state = await win.evaluate(() => document.getElementById('root')?.dataset.state)
  if (state !== 'ready') throw new Error(`the shell projected ${String(state)}, expected ready`)
}

/**
 * Acknowledge the product-wide first-run notice through its own button,
 * exactly as a first-run user would (its backdrop would intercept every later
 * click). A no-op when this home already acknowledged it.
 */
export async function acknowledgeFirstRun(win: Page): Promise<boolean> {
  const continueButton = win.getByRole('button', { name: 'Continue' })
  try {
    await continueButton.waitFor({ state: 'visible', timeout: 60_000 })
    await continueButton.click()
    await continueButton.waitFor({ state: 'detached', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/** The session tree lives in the sidebar, which a fresh profile opens collapsed. */
export async function openSidebar(win: Page): Promise<void> {
  const toggle = win.getByRole('button', { name: 'Open sidebar' })
  if (await toggle.count() > 0) {
    await toggle.first().click()
    await win.locator('[role="treeitem"]').first().waitFor({ timeout: 15_000 })
  }
}

/** Switch the session's sandbox access mode through the composer's own menu. */
export async function switchAccessMode(win: Page, mode: 'Read Only' | 'Workspace Write'): Promise<void> {
  await win.locator('button[aria-label^="Access mode"]').click()
  await win.getByRole('menuitem', { name: mode }).click()
  await expectPoll(async () =>
    (await win.locator(`button[aria-label="Access mode, current: ${mode}"]`).count()) > 0, { timeout: 15_000 })
}

/**
 * Seed the workspace registry the way the product persists it (version 2), so
 * a suite can start from a known workspace without driving the OS dialog.
 * The canonical journey instead drives the real picker path; this is the
 * alternative the parity suite owns. The path must already be canonicalised
 * through the product's identity canon (see smoke-packaged-app.ts).
 */
export function seedWorkspaceRegistry(harnessHome: string, dir: string, title = 'journey-workspace', id = 'ws-journey'): void {
  const now = new Date().toISOString()
  const storages = join(harnessHome, 'storages')
  mkdirSync(storages, { recursive: true })
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
    tables: {
      workspaces: {
        [id]: { path: dir, title, sessionIds: [], createdAt: now, updatedAt: now },
      },
    },
  }
  writeFileSync(join(storages, 'workspace.json'), JSON.stringify(doc, null, 2) + '\n')
}

/**
 * Decode a session artifact. The shipped JSONL backend stores a concatenated
 * Zstandard frame container (one frame per durable batch); Node's one-shot
 * zstd API reads only the first frame, so the frame boundaries are located
 * structurally, mirroring the backend's scanner.
 */
export function decodeSessionArtifact(file: string): string {
  if (!file.endsWith('.zstd')) return readFileSync(file, 'utf8')
  const buffer = readFileSync(file)
  const ZSTD_MAGIC = 0xfd2fb528
  const frames: { start: number; end: number }[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    let complete = true
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) { complete = false } else { offset += remainingHeaderBytes }
    if (complete) {
      for (;;) {
        if (buffer.length - offset < 3) { complete = false; break }
        const blockHeader = buffer.readUIntLE(offset, 3)
        offset += 3
        const lastBlock = (blockHeader & 1) !== 0
        const blockType = (blockHeader >>> 1) & 0x03
        const blockSize = blockHeader >>> 3
        const payloadBytes = blockType === 0x01 ? 1 : blockSize
        if (buffer.length - offset < payloadBytes) { complete = false; break }
        offset += payloadBytes
        if (lastBlock) break
      }
    }
    if (complete) {
      if (checksum && buffer.length - offset < 4) complete = false
      else if (checksum) offset += 4
    }
    if (!complete || offset <= start) break
    frames.push({ start, end: offset })
  }
  return frames
    .map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    .join('')
}

/** The session/title rows currently durable in the on-disk JSONL logs. */
export function sessionLogTitles(home: string): Record<string, { seq: number; title: unknown; source: unknown }[]> {
  const logs: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd') logs.push(path)
    }
  }
  walk(home)
  const out: Record<string, { seq: number; title: unknown; source: unknown }[]> = {}
  for (const file of logs) {
    const text = decodeSessionArtifact(file)
    out[file] = text.split('\n').filter(Boolean).map((line) => {
      try {
        const record = JSON.parse(line) as { type?: unknown; seq?: unknown; data?: { title?: unknown; source?: { kind?: unknown } } }
        return record.type === 'session/title'
          ? { seq: Number(record.seq), title: record.data?.title, source: record.data?.source?.kind }
          : null
      } catch {
        return null
      }
    }).filter((row): row is { seq: number; title: unknown; source: unknown } => row !== null)
  }
  return out
}

/** Poll until the write-behind has durably written the title row. */
export async function awaitDurableTitle(home: string, title: string, source: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const rows of Object.values(sessionLogTitles(home))) {
      if (rows.some(row => row.title === title && row.source === source)) return
    }
    if (Date.now() > deadline) break
    await new Promise((resolveWait) => { setTimeout(resolveWait, 250) })
  }
  throw new Error(`title row "${title}" (source ${source}) never durable; on-disk rows: ${JSON.stringify(sessionLogTitles(home))}`)
}

// A local poll (the support module does not import vitest's expect).
async function expectPoll(predicate: () => Promise<boolean>, { timeout }: { timeout: number }): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeout)} ms waiting for the access-mode switch to settle`)
    await new Promise((resolveWait) => { setTimeout(resolveWait, 100) })
  }
}
