/**
 * Desktop shell entry. This process owns the application and window
 * lifecycle and, from stage 2 on, supervises the standalone Harness
 * runtime; it never hosts the Harness itself.
 * @module @deepseek-ai/dsh-desktop/src/main/index
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { handleAppProtocol, registerAppScheme } from './protocol.ts'
import { denySessionPermissions } from './security.ts'
import { createAppWindow } from './window.ts'

/**
 * Resolve the packaged renderer distribution directory.
 * @returns absolute directory containing the renderer index.html
 */
function rendererDistRoot(): string {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'renderer')
    : join(app.getAppPath(), 'dist', 'renderer')
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(`desktop shell: renderer distribution missing at ${root}; run the app build first`)
  }
  return root
}

registerAppScheme()

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(() => {
    denySessionPermissions(session.defaultSession)
    handleAppProtocol(rendererDistRoot())
    createAppWindow()
    app.on('window-all-closed', () => {
      app.quit()
    })
  })
}
