/**
 * The single application window.
 * @module @deepseek-ai/dsh-desktop/src/main/window
 */
import { BrowserWindow } from 'electron'
import { APP_HOME_URL } from './protocol.ts'
import { hardenWebContents } from './security.ts'

/**
 * Create the single application window with the desktop security baseline
 * and load the main application page.
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
    },
  })
  hardenWebContents(win.webContents)
  win.once('ready-to-show', () => {
    win.show()
  })
  void win.loadURL(APP_HOME_URL)
  return win
}
