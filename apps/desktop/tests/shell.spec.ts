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

function guiAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
}

const built = existsSync(mainEntry) && existsSync(rendererIndex)

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
        expect(await win.evaluate(() => document.getElementById('root')?.dataset.state)).toBe('booting-desktop')

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
