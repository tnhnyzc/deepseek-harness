/**
 * Shell smoke: the packaged renderer boots over dsh-app:// in a sandboxed,
 * Node-free renderer with a valid CSP, no request leaving the app
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
          // The pinned Cordis loader evaluates its `!!js` config expressions
          // through new Function at module scope, so the stage 4 CSP must
          // carry 'unsafe-eval' for the pinned tree to boot; that one warning
          // is the documented consequence. Every other security warning still
          // fails the smoke.
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

        const csp = await win.evaluate(() =>
          document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
        )
        expect(csp).toContain("script-src 'self'")

        const globals = await win.evaluate(() => ({
          require: typeof (globalThis as Record<string, unknown>).require,
          process: typeof (globalThis as Record<string, unknown>).process,
        }))
        expect(globals.require).toBe('undefined')
        expect(globals.process).toBe('undefined')

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
