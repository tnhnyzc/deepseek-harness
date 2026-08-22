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
          if (message.text().includes('Electron Security Warning')) warnings.push(message.text())
        })
        win.on('request', (request) => {
          if (!request.url().startsWith('dsh-app://')) external.push(request.url())
        })
        await win.reload()
        await win.waitForLoadState('domcontentloaded')

        expect(win.url()).toBe('dsh-app://app/index.html')
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

        const traversal = await win.evaluate(
          async () => (await fetch('dsh-app://app/%2e%2e/%2e%2e/etc/passwd')).status,
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

      // Ready implies a settled DSH Context, not a localhost probe: the
      // renderer shows the runtime + DSH versions reported over IPC.
      const body = await win.evaluate(() => document.body.textContent ?? '')
      expect(body).toContain('Harness ready — runtime ')
      expect(body).toContain(', DSH ')

      // The transport end-to-end: the preload hands the renderer half of a
      // real MessagePort over Electron IPC; a keyless fetch round-trips
      // through the main broker, the child IPC, and the runtime adapter.
      const facts = await win.evaluate(async () => {
        const port = await window.dshDesktop.openTransport()
        try {
          const requestId = 'smoke-fetch'
          const payload = new TextEncoder().encode(
            JSON.stringify({ type: 'client-request', rpcId: 'smoke-rpc', method: 'session.list', payload: {} }),
          )
          const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            let status = 0
            const chunks: Uint8Array[] = []
            const onClose = () => { reject(new Error('transport port closed mid-fetch')) }
            port.addEventListener('close', onClose)
            port.addEventListener('message', (event) => {
              const data = (event as { data?: unknown }).data
              const message = data as {
                type: string
                status?: number
                data?: Uint8Array
                code?: string
                message?: string
              } | undefined
              if (message === undefined) return
              if (message.type === 'fetch.response.head') status = message.status ?? 0
              else if (message.type === 'fetch.response.chunk' && message.data !== undefined) chunks.push(message.data)
              else if (message.type === 'fetch.response.end') {
                port.removeEventListener('close', onClose)
                const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
                let offset = 0
                for (const chunk of chunks) {
                  merged.set(chunk, offset)
                  offset += chunk.byteLength
                }
                resolve({ status, body: new TextDecoder().decode(merged) })
              } else if (message.type === 'fetch.error') {
                port.removeEventListener('close', onClose)
                reject(new Error(`fetch.error: ${String(message.code)} ${String(message.message)}`))
              }
            })
            port.postMessage({ type: 'fetch.open', requestId, url: 'http://dsh.local/api/session.list', method: 'POST', headers: [['content-type', 'application/json']] })
            port.postMessage({ type: 'fetch.request.chunk', requestId, sequence: 0, data: payload })
            port.postMessage({ type: 'fetch.request.end', requestId })
          })
          return result
        } finally {
          port.close()
        }
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
