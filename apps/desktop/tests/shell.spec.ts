/**
 * Shell smoke: the packaged renderer boots over dsh-app:// in a sandboxed,
 * Node-free renderer with the pinned CSP, the closed preload bridge
 * surface, <webview> embedding pinned off, no request leaving the app
 * protocol, no served file outside the renderer distribution, and no
 * Electron security warning caused by the application configuration.
 * Self-skips without a built app or a GUI session.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { describe, it, expect } from 'vitest'
import { APP_HOME_URL } from '../src/main/protocol.ts'

const appDir = resolve(import.meta.dirname, '..')
const mainEntry = join(appDir, 'dist', 'main', 'index.js')
const rendererIndex = join(appDir, 'dist', 'renderer', 'index.html')
const runtimeEntry = resolve(appDir, '..', 'desktop-runtime', 'dist', 'index.js')

function nodeTargetName(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  return `${platform}-${arch}`
}
const bundledNode = join(appDir, 'node', nodeTargetName(process.platform, process.arch), process.platform === 'win32' ? 'node.exe' : 'node')

function guiAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
}

const built = existsSync(mainEntry) && existsSync(rendererIndex)
// End-to-end runtime smoke needs the built runtime bundle and the pinned
// bundled Node for this platform; otherwise it self-skips.
const runtimeBuilt = built && existsSync(runtimeEntry) && existsSync(bundledNode)

describe.skipIf(!guiAvailable() || !built)('desktop shell smoke', () => {
  it(
    'boots to the packaged renderer over dsh-app://',
    async () => {
      const app = await electron.launch({ args: [appDir] })
      try {
        const win = await app.firstWindow()
        const warnings: string[] = []
        const external: string[] = []
        win.on('console', (message) => {
          const text = message.text()
          if (!text.includes('Electron Security Warning')) return
          // The pinned Cordis loader module (seeded as the @deepseek-ai/cordis
          // platform module) runs new Function at module scope —
          // vendor/loader/src/config/utils.ts, vendor pin b150a551 — so the
          // CSP must carry 'unsafe-eval' for the pinned tree to boot; the
          // runtime smoke below is the boot proof. That one warning is the
          // documented consequence. Every other security warning still fails
          // the smoke.
          if (text.includes('Insecure Content-Security-Policy')) return
          warnings.push(text)
        })
        win.on('request', (request) => {
          if (!request.url().startsWith('dsh-app://')) external.push(request.url())
        })
        await win.reload()
        await win.waitForLoadState('domcontentloaded')

        expect(win.url()).toBe(APP_HOME_URL)
        // From stage 2 the root mirrors the runtime lifecycle; before the
        // first IPC round-trip it still shows the initial shell state.
        const state = await win.evaluate(() => document.getElementById('root')?.dataset.state)
        expect(['booting-desktop', 'stopped', 'starting', 'ready', 'stopping', 'failed']).toContain(state)

        // The served policy is the pinned minimized CSP (the stage 10
        // finding and its correction): no 'unsafe-inline' in script-src;
        // script-src blob: is the carrier's classic-script path;
        // 'unsafe-eval' is the pinned loader's; img-src blob: is the pinned
        // DSH image-preview path (URL.createObjectURL results as <img src>).
        const csp = await win.evaluate(() =>
          document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
        )
        expect(csp).toBe(
          "default-src 'self'; script-src 'self' blob: 'unsafe-eval'; style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
        )

        const globals = await win.evaluate(() => {
          const api = (globalThis as { dshDesktop?: Record<string, unknown> }).dshDesktop
          return {
            require: typeof (globalThis as Record<string, unknown>).require,
            process: typeof (globalThis as Record<string, unknown>).process,
            webviewTag: typeof (globalThis as { HTMLWebViewElement?: unknown }).HTMLWebViewElement,
            bridge: api === undefined ? [] : Object.keys(api).sort(),
          }
        })
        expect(globals.require).toBe('undefined')
        expect(globals.process).toBe('undefined')
        // webviewTag is pinned off: the <webview> element type never exists.
        expect(globals.webviewTag).toBe('undefined')
        // The preload bridge is the closed six-method surface, nothing more.
        expect(globals.bridge).toEqual([
          'getBootPayload', 'getRuntimeState', 'onDesktopCommand', 'onRuntimeState', 'openTransport', 'requestRestart',
        ])

        // The url is inlined: the callback is serialized into the page
        // context, where this file's imports do not exist.
        const traversal = await win.evaluate(
          async () => (await fetch('dsh-app://127.0.0.1/%2e%2e/%2e%2e/etc/passwd')).status,
        )
        expect(traversal).toBe(404)

        expect(warnings).toEqual([])
        expect(external).toEqual([])
      } finally {
        await app.close()
      }
    },
    120_000,
  )

  it(
    'loads blob-backed image previews under the pinned CSP and still refuses remote images',
    async () => {
      // The stage 10 correction: the pinned DSH conversation client previews
      // attachment images as URL.createObjectURL results — draft attachments
      // from a File (ui-conversation browserDraftAttachment) and historical
      // images from a Blob (ui-conversation resolveImage) — rendered as
      // <img src="blob:…">. This exercises both exact shapes under the
      // production CSP on the dsh-app origin, where Chromium enforces it.
      const app = await electron.launch({ args: [appDir] })
      try {
        const win = await app.firstWindow()
        const violations: string[] = []
        win.on('console', (message) => {
          const text = message.text()
          if (text.includes('Content Security Policy')) violations.push(text)
        })
        await win.reload()
        await win.waitForLoadState('domcontentloaded')

        const facts = await win.evaluate(async () => {
          // A real 1x1 PNG so a successful load means the bytes decoded.
          const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
          const load = (url: string): Promise<{ ok: boolean; naturalWidth: number }> => new Promise((resolve) => {
            const img = new Image()
            img.onload = () => { resolve({ ok: true, naturalWidth: img.naturalWidth }) }
            img.onerror = () => { resolve({ ok: false, naturalWidth: 0 }) }
            img.src = url
          })
          // Draft shape: File -> object URL (browserDraftAttachment).
          const file = new File([bytes], 'draft.png', { type: 'image/png' })
          const draft = await load(URL.createObjectURL(file))
          // Historical shape: Blob -> object URL (resolveImage).
          const historical = await load(URL.createObjectURL(new Blob([bytes.buffer], { type: 'image/png' })))
          // Negative control: a remote image must stay refused by img-src.
          const remote = await load('https://example.com/probe.png')
          return { draft, historical, remote }
        })

        // Both pinned preview shapes load; the remote control is refused.
        expect(facts.draft).toEqual({ ok: true, naturalWidth: 1 })
        expect(facts.historical).toEqual({ ok: true, naturalWidth: 1 })
        expect(facts.remote.ok).toBe(false)

        // Give Chromium a beat to deliver the violation console message,
        // then assert the remote image was refused by the img-src
        // directive and that no CSP violation names a blob: *resource*
        // (the quoted directive itself mentions blob:; a refused blob
        // resource appears as 'blob:…').
        await new Promise((resolve) => { setTimeout(resolve, 300) })
        const remoteViolations = violations.filter(text => text.includes('https://example.com/probe.png'))
        expect(remoteViolations.length).toBe(1)
        expect(remoteViolations[0]).toContain('img-src')
        expect(violations.filter(text => text.includes("'blob:")).length).toBe(0)
      } finally {
        await app.close()
      }
    },
    120_000,
  )
})

describe.skipIf(!guiAvailable() || !runtimeBuilt)('desktop runtime smoke', () => {
  it('boots the standalone runtime, reaches ready, and shuts it down cleanly on quit', async () => {
    const app = await electron.launch({ args: [appDir] })
    try {
      const win = await app.firstWindow()
      await win.reload()
      await win.waitForLoadState('domcontentloaded')

      // The supervisor (Electron main) forks the bundled Node and drives the
      // real DSH boot; the renderer mirrors the resulting state.
      await win.waitForFunction(() => {
        const state = document.getElementById('root')?.dataset.state
        return state === 'ready' || state === 'failed'
      }, undefined, { timeout: 120_000 })
      const state = await win.evaluate(() => document.getElementById('root')?.dataset.state)
      expect(state).toBe('ready')

      // Stage 4: ready hands the root to the DSH client tree. The carrier
      // seam and the boot protocol are installed before the tree takes over,
      // and the shell state screen is gone — one root, the pinned app in it.
      // Stage 10: this mount is also the CSP boot proof — the pinned loader
      // module's module-scope new Function must execute under the policy,
      // or the graph global and the tree never appear and this times out.
      await win.waitForFunction(() => {
        const globals = globalThis as { __DSH_TRANSPORT__?: unknown; __DSH_BOOT__?: unknown }
        return globals.__DSH_TRANSPORT__ !== undefined
          && globals.__DSH_BOOT__ !== undefined
          && document.querySelector('.shell-state') === null
      }, undefined, { timeout: 60_000 })

      // The transport end-to-end: the app's boot channel (opened at ready
      // through the preload's openTransport) carries a keyless round trip
      // through the main broker, the child IPC, and the runtime adapter. The
      // smoke drives it through the pinned carrier seam the DSH tree itself
      // uses, on the app's single channel — the broker is per-generation, so
      // a second channel would replace the boot channel and the boot
      // traffic's in-flight responses would race the test's own.
      const facts = await win.evaluate(async () => {
        const hooks = (globalThis as unknown as {
          __DSH_TRANSPORT__: { fetch: (input: URL, init: RequestInit) => Promise<Response> }
        }).__DSH_TRANSPORT__
        const response = await hooks.fetch(new URL('/api/session.list', location.origin), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-rpc', method: 'session.list', payload: {} }),
        })
        return { status: response.status, body: await response.text() }
      })
      expect(facts.status).toBe(200)
      const envelope = JSON.parse(facts.body) as { type: string; result: { ok: boolean; value: { items: unknown[] } } }
      expect(envelope.type).toBe('server-response')
      expect(envelope.result.ok).toBe(true)
      expect(Array.isArray(envelope.result.value.items)).toBe(true)
    } finally {
      // app.close() triggers before-quit -> supervisor.stop(): graceful DSH
      // disposal, then a forced process-group kill if the runtime refused.
      await app.close()
    }
  }, 180_000)
})
