/**
 * Stage 10 security-hardening pins: the preload bridge installs only in the
 * main frame and exposes exactly the closed surface, the boot-graph
 * publication is bound-checked at the wire, the renderer CSP is the pinned
 * minimized policy, and the BrowserWindow security flags stay pinned in
 * source (an Electron default change must not silently widen the surface).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parseBootGraphMessage, parseSmokeReportMessage } from '../src/main/runtime.ts'

const DESKTOP_ROOT = join(import.meta.dirname, '..')

// ---- the preload bridge: main-frame only, closed surface ----

interface PreloadRun {
  exposed: { name: string; api: Record<string, unknown> } | undefined
  requiredElectron: boolean
}

/**
 * Evaluate the checked-in CJS preload the way the CJS loader would (wrapped
 * function, injected `require` and `window`), so the main-frame guard and
 * the exposed surface are tested behaviorally without an Electron runtime.
 */
function runPreload(options: { subframe: boolean; smoke?: boolean }): PreloadRun {
  let exposed: PreloadRun['exposed']
  let requiredElectron = false
  const fakeRequire = (specifier: string): unknown => {
    if (specifier !== 'electron') throw new Error(`unexpected require ${specifier}`)
    requiredElectron = true
    return {
      contextBridge: {
        exposeInMainWorld: (name: string, api: Record<string, unknown>): void => { exposed = { name, api } },
      },
      ipcRenderer: {
        invoke: (): void => { throw new Error('invoke is not exercised by this test') },
        on: (): void => { /* the disposer is not exercised by this test */ },
        removeListener: (): void => { /* the disposer is not exercised by this test */ },
        send: (): void => { /* the transport open is not exercised by this test */ },
      },
    }
  }
  const top: object = {}
  const self: object = options.subframe ? {} : top
  // The checked-in CJS uses a top-level return, so the source is wrapped in a
  // function body and compiled with node:vm instead of the Function
  // constructor (which the lint surface refuses).
  const source = readFileSync(join(DESKTOP_ROOT, 'src', 'preload', 'index.cjs'), 'utf8')
  // The sandboxed preload reads the app environment through the Electron
  // `process` polyfill; the shim carries only the smoke gate, exactly as a
  // DSH_DESKTOP_SMOKE=1 launch (or its absence) would present it.
  const sandbox: Record<string, unknown> = {
    process: { env: options.smoke ? { DSH_DESKTOP_SMOKE: '1' } : {} },
  }
  const factory = new Script(`(function (require, module, exports, window) {\n${source}\n})`).runInNewContext(sandbox) as (
    require: typeof fakeRequire,
    module: object,
    exports: object,
    window: { top: object; self: object },
  ) => void
  factory(fakeRequire, {}, {}, { top, self })
  return { exposed, requiredElectron }
}

const EXPECTED_BRIDGE_SURFACE = [
  'getRuntimeState', 'getBootPayload', 'onRuntimeState', 'requestRestart', 'openTransport', 'onDesktopCommand',
]

describe('preload bridge installation', () => {
  it('installs the closed surface in the main frame', () => {
    const { exposed, requiredElectron } = runPreload({ subframe: false })
    expect(requiredElectron).toBe(true)
    expect(exposed?.name).toBe('dshDesktop')
    expect(Object.keys(exposed?.api ?? {}).sort()).toEqual([...EXPECTED_BRIDGE_SURFACE].sort())
  })

  it('adds only the smoke report under the DSH_DESKTOP_SMOKE gate', () => {
    const { exposed } = runPreload({ subframe: false, smoke: true })
    expect(Object.keys(exposed?.api ?? {}).sort()).toEqual([...EXPECTED_BRIDGE_SURFACE, 'smokeReport'].sort())
  })

  it('installs nothing in a subframe and never touches electron there', () => {
    const { exposed, requiredElectron } = runPreload({ subframe: true })
    expect(exposed).toBeUndefined()
    expect(requiredElectron).toBe(false)
  })
})

// ---- the boot-graph publication: bound-checked at the wire ----

const validBootGraph = (): Record<string, unknown> => ({
  type: 'runtime.boot-graph',
  graph: {
    rev: 'abc123def456',
    entries: [
      { id: '@deepseek-ai/dsh-client-modules', url: '/plugins/@deepseek-ai%2Fdsh-client-modules/client.js?rev=abc123def456', rev: 'abc123def456' },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/plugins/@deepseek-ai%2Fdsh-client-runtime/client.js?rev=abc123def456', rev: 'abc123def456', external: ['react'] },
    ],
  },
  moduleLoaderScript: 'window.__ModuleLoader__={mode:"queue"}',
  preloadBundles: [
    '/plugins/@deepseek-ai%2Fdsh-client-modules/client.js?rev=abc123def456',
    '/plugins/@deepseek-ai%2Fdsh-client-runtime/client.js?rev=abc123def456',
  ],
})

describe('parseBootGraphMessage', () => {
  it('passes a well-formed publication through', () => {
    const message = validBootGraph()
    const parsed = parseBootGraphMessage(message)
    expect(parsed).toBeDefined()
    expect(parsed?.moduleLoaderScript).toBe(message.moduleLoaderScript)
    expect(parsed?.preloadBundles).toEqual(message.preloadBundles)
    expect(parsed?.graph).toEqual(message.graph)
  })

  it('drops a publication that is not the boot-artifact shape', () => {
    expect(parseBootGraphMessage(null)).toBeUndefined()
    expect(parseBootGraphMessage({ type: 'runtime.boot-graph' })).toBeUndefined()
    const noGraph = validBootGraph()
    delete noGraph.graph
    expect(parseBootGraphMessage(noGraph)).toBeUndefined()
    const badRev = validBootGraph()
    ;(badRev.graph as Record<string, unknown>).rev = 42
    expect(parseBootGraphMessage(badRev)).toBeUndefined()
  })

  it('drops an over-bound publication at the wire', () => {
    const overScript = validBootGraph()
    overScript.moduleLoaderScript = 'x'.repeat(1024 * 1024 + 1)
    expect(parseBootGraphMessage(overScript)).toBeUndefined()

    const overEntries = validBootGraph()
    const graph = overEntries.graph as { entries: Array<Record<string, unknown>> }
    for (let index = 0; index < 256; index++) {
      graph.entries.push({ id: `pkg-${index}`, url: `/plugins/pkg-${index}/client.js?rev=r`, rev: 'r' })
    }
    expect(parseBootGraphMessage(overEntries)).toBeUndefined()

    const overUrl = validBootGraph()
    const entries = (overUrl.graph as { entries: Array<Record<string, unknown>> }).entries
    const entry = entries[0]
    if (entry === undefined) throw new Error('test fixture lost its first entry')
    entry.url = 'u'.repeat(8193)
    expect(parseBootGraphMessage(overUrl)).toBeUndefined()

    const overBundle = validBootGraph()
    ;(overBundle.preloadBundles as string[]).push('u'.repeat(8193))
    expect(parseBootGraphMessage(overBundle)).toBeUndefined()
  })
})

// ---- the smoke-fact publication: bound-checked at the wire ----

describe('parseSmokeReportMessage', () => {
  it('passes a well-formed probe report through', () => {
    const message = {
      type: 'runtime.smoke-report',
      channelRoundTrip: { code: 'malformed-request' },
      nativeOpenPath: { ok: false, code: 'open-failed', message: 'Failed to open path' },
    }
    expect(parseSmokeReportMessage(message)).toEqual({
      channelRoundTrip: { code: 'malformed-request' },
      nativeOpenPath: { ok: false, code: 'open-failed', message: 'Failed to open path' },
    })
  })

  it('drops reports that are not the smoke-report shape', () => {
    expect(parseSmokeReportMessage(null)).toBeUndefined()
    expect(parseSmokeReportMessage({ type: 'runtime.smoke-report' })).toBeUndefined()
    expect(parseSmokeReportMessage({ nativeOpenPath: { ok: 'no' } })).toBeUndefined()
    expect(parseSmokeReportMessage({ channelRoundTrip: { code: 'malformed-request' } })).toBeUndefined()
  })

  it('drops an over-bound report at the wire', () => {
    expect(parseSmokeReportMessage({ channelRoundTrip: { code: 'x'.repeat(65) }, nativeOpenPath: { ok: false } })).toBeUndefined()
    expect(parseSmokeReportMessage({ channelRoundTrip: { code: 'malformed-request' }, nativeOpenPath: { ok: false, code: 'x'.repeat(65) } })).toBeUndefined()
    expect(parseSmokeReportMessage({ channelRoundTrip: { code: 'malformed-request' }, nativeOpenPath: { ok: false, message: 'x'.repeat(513) } })).toBeUndefined()
  })
})

// ---- the pinned renderer CSP ----

describe('renderer content-security-policy', () => {
  it('is the pinned minimized policy', () => {
    const html = readFileSync(join(DESKTOP_ROOT, 'src', 'renderer', 'index.html'), 'utf8')
    const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
    // The pinned policy: no 'unsafe-inline' in script-src; script-src blob:
    // is the carrier's classic-script execution path; 'unsafe-eval' is the
    // pinned Cordis loader's module-scope new Function (the stage 10
    // finding); img-src blob: is the pinned DSH image-preview path —
    // ui-conversation's draft attachments (service.ts
    // browserDraftAttachment) and historical images (resolveImage) are
    // URL.createObjectURL results rendered as <img src>. Editing the policy
    // requires re-justifying it here.
    expect(content).toBe(
      "default-src 'self'; script-src 'self' blob: 'unsafe-eval'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    )
  })
})

// ---- the pinned BrowserWindow security flags ----

describe('BrowserWindow security surface', () => {
  it('pins the full security flag set in source', () => {
    const source = readFileSync(join(DESKTOP_ROOT, 'src', 'main', 'window.ts'), 'utf8')
    for (const flag of [
      'nodeIntegration: false',
      'contextIsolation: true',
      'sandbox: true',
      'webSecurity: true',
      'webviewTag: false',
      'devTools: !app.isPackaged',
    ]) {
      expect(source, `window.ts must pin ${flag}`).toContain(flag)
    }
  })
})
