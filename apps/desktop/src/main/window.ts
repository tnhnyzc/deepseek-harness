/**
 * The single application window.
 * @module @deepseek-ai/dsh-desktop/src/main/window
 */
import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { APP_HOME_URL } from './protocol.ts'
import { hardenWebContents } from './security.ts'

/**
 * Create the single application window with the desktop security baseline
 * and load the main application page. The window may exist while the
 * runtime is still starting: the renderer projects the startup state.
 *
 * The ordinary native frame is the chrome strategy on every platform (no
 * custom titlebar, no hidden traffic lights): macOS gets its native
 * title bar with working traffic lights, Windows/Linux their standard
 * window controls. The size is content-bounds based so the client's
 * 1024px desktop-layout breakpoint is met identically on every platform,
 * and the minimum keeps the window at or above that breakpoint so the app
 * never drops into the client's narrow (rail) regime by accident.
 * @returns the application window
 */
export function createAppWindow(): BrowserWindow {
  const win = new BrowserWindow({
    useContentSize: true,
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Explicit, not default-reliant: a future Electron default change must
      // not silently re-enable <webview> embedding.
      webviewTag: false,
      // DevTools is a development affordance: packaged builds deny the API
      // itself, so no menu item, accelerator, or page script can open it.
      devTools: !app.isPackaged,
      // The checked-in CJS bridge (a sandboxed preload cannot use ESM); it
      // resolves in both the development layout and the packaged asar.
      preload: join(app.getAppPath(), 'src', 'preload', 'index.cjs'),
    },
  })
  hardenWebContents(win.webContents)
  win.once('ready-to-show', () => {
    win.show()
  })
  void win.loadURL(APP_HOME_URL)
  return win
}
