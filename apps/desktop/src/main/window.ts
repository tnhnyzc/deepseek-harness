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
 * @returns the application window
 */
export function createAppWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
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
