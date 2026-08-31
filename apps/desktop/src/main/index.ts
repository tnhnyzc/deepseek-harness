/**
 * Desktop shell entry. This process owns the application and window
 * lifecycle and supervises the standalone Harness runtime (stage 2); it
 * never hosts the Harness itself.
 * @module @deepseek-ai/dsh-desktop/src/main/index
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, MessageChannelMain, session } from 'electron'
import { handleAppProtocol, registerAppScheme } from './protocol.ts'
import {
  bundledNodeExecutable,
  dshHomeDirectory,
  runtimeCwd,
  runtimeEntryPath,
} from './runtime-paths.ts'
import { createNativeCapabilities } from './native-capabilities.ts'
import { createNativeChannel, type NativeChannelOptions } from './native-channel.ts'
import { createRuntimeSupervisor, type RuntimeSupervisor, type RuntimeStateView } from './runtime.ts'
import { CLIPBOARD_WRITE_PERMISSION, installSessionPermissionPolicy, isTrustedIpcSender, type IpcSender } from './security.ts'
import { createTransportBroker, TRANSPORT_OPEN_CHANNEL, wrapMainPort, type BrokerChannel } from './transport-broker.ts'
import { createAppWindow, getAppWindowWebPreferences } from './window.ts'
import { DESKTOP_APP_NAME, installApplicationMenu } from './menu.ts'
import { DESKTOP_COMMAND_CHANNEL } from '../shared/desktop-command.ts'

/** The renderer channels of the supervision bridge. */
const STATE_CHANNEL = 'dsh-desktop:runtime-state'
const GET_CHANNEL = 'dsh-desktop:runtime-get'
const RESTART_CHANNEL = 'dsh-desktop:runtime-restart'
const BOOT_GRAPH_CHANNEL = 'dsh-desktop:boot-graph'
// Test-only, environment-gated: the packaged-app smoke reads the
// process-level facts no other channel exposes. Absent without
// DSH_DESKTOP_SMOKE=1, so the shipped surface stays closed.
const SMOKE_CHANNEL = 'dsh-desktop:smoke-report'

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
  let supervisor: RuntimeSupervisor | undefined
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(() => {
    app.name = DESKTOP_APP_NAME
    // Default-deny with the single source-proven exception: the pinned DSH
    // clipboard write (see installSessionPermissionPolicy).
    installSessionPermissionPolicy(session.defaultSession)
    handleAppProtocol(rendererDistRoot())
    // The app package directory: development checkout layout or asar root.
    const desktopDir = app.getAppPath()
    const home = dshHomeDirectory(app.getPath('userData'))
    mkdirSync(home, { recursive: true })
    // The runtime child gets a curated environment (not this process's), so
    // the smoke gate is forwarded explicitly; absent, the runtime publishes
    // no smoke facts and the bridge exposes no smoke method.
    const smokeGate = process.env.DSH_DESKTOP_SMOKE === '1'
      ? { extraEnv: { DSH_DESKTOP_SMOKE: '1' } satisfies Record<string, string> }
      : {}
    supervisor = createRuntimeSupervisor({
      entry: runtimeEntryPath(app.isPackaged, process.resourcesPath, desktopDir),
      nodeExecutable: bundledNodeExecutable(app.isPackaged, process.resourcesPath, desktopDir),
      cwd: runtimeCwd(app.isPackaged, process.resourcesPath, desktopDir),
      home,
      ...smokeGate,
      onStateChange: (view: RuntimeStateView) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(STATE_CHANNEL, view)
        }
      },
    })
    // The renderer bridge is trusted-only: state reads, restarts, and
    // transport opens come from the app's own main frame, never from
    // subframes or other origins.
    const trusted = (event: IpcSender): boolean => isTrustedIpcSender(event, BrowserWindow.getAllWindows())
    ipcMain.handle(GET_CHANNEL, (event) => {
      if (!trusted(event)) throw new Error('desktop shell: untrusted IPC sender')
      const current = supervisor
      if (current === undefined) throw new Error('desktop shell: runtime supervisor not initialized')
      return current.view()
    })
    ipcMain.handle(BOOT_GRAPH_CHANNEL, (event) => {
      if (!trusted(event)) throw new Error('desktop shell: untrusted IPC sender')
      const current = supervisor
      if (current === undefined) throw new Error('desktop shell: runtime supervisor not initialized')
      return current.bootPayload() ?? null
    })
    ipcMain.handle(RESTART_CHANNEL, (event) => {
      if (!trusted(event)) throw new Error('desktop shell: untrusted IPC sender')
      const current = supervisor
      if (current === undefined) throw new Error('desktop shell: runtime supervisor not initialized')
      current.requestRestart()
      return true
    })
    // Test-only (DSH_DESKTOP_SMOKE=1): one read-only fact report for the
    // packaged-app smoke; the shipped surface stays closed without it.
    if (process.env.DSH_DESKTOP_SMOKE === '1') {
      ipcMain.handle(SMOKE_CHANNEL, (event) => {
        if (!trusted(event)) throw new Error('desktop shell: untrusted IPC sender')
        const current = supervisor
        if (current === undefined) throw new Error('desktop shell: runtime supervisor not initialized')
        const view = current.view()
        const win = BrowserWindow.getAllWindows()[0]
        return {
          isPackaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          electronVersion: process.versions.electron,
          childPid: current.childPid(),
          runtime: {
            state: view.state,
            ...(view.ready === undefined ? {} : { runtimeVersion: view.ready.runtimeVersion, dshVersion: view.ready.dshVersion }),
            ...(view.reason === undefined ? {} : { reason: view.reason }),
          },
          smokeFacts: current.smokeFacts() ?? null,
          webPreferences: getAppWindowWebPreferences() ?? null,
          devToolsOpened: win === undefined ? null : win.webContents.isDevToolsOpened(),
          permissionPolicy: { defaultDeny: true, allowedPermission: CLIPBOARD_WRITE_PERMISSION, handlers: ['request', 'check'] },
        }
      })
    }
    const broker = createTransportBroker({
      runtime: supervisor.transport,
      isRuntimeReady: () => supervisor?.view().state === 'ready',
      // Only Electron's main-process channel ports can cross webContents IPC;
      // Node worker_threads ports cannot.
      channelFactory: (): BrokerChannel => {
        const channel = new MessageChannelMain()
        return { local: wrapMainPort(channel.port1), remote: channel.port2 }
      },
    })
    // The native capability channel is per-generation, like the transport
    // channel: a generation's channel owns its pending set, its teardown
    // settles that generation's requests, and a fresh channel owns the next
    // generation (the supervisor clears the message handler before the
    // close handler runs, so the re-registration below survives). The
    // narrowed local keeps the channel's closures off the reassigned let.
    const runtime = supervisor
    const nativeChannelOptions: NativeChannelOptions = {
      capabilities: createNativeCapabilities(),
      send: (message) => { runtime.native.send(message) },
      getWindow: () => BrowserWindow.getAllWindows()[0],
    }
    let nativeChannel = createNativeChannel(nativeChannelOptions)
    const armNativeChannel = (): void => {
      runtime.native.onMessage((value) => { nativeChannel.handle(value) })
    }
    armNativeChannel()
    runtime.native.onClose(() => {
      nativeChannel.teardown('runtime generation ended')
      nativeChannel = createNativeChannel(nativeChannelOptions)
      armNativeChannel()
    })
    ipcMain.on(TRANSPORT_OPEN_CHANNEL, (event) => {
      if (!trusted(event)) return
      broker.handleOpenRequest(event.sender)
    })
    supervisor.start()
    createAppWindow()
    installApplicationMenu({
      appName: DESKTOP_APP_NAME,
      isMac: process.platform === 'darwin',
      devToolsAvailable: !app.isPackaged,
      // The command rides only to the app window's main frame; the preload
      // re-checks the closed vocabulary before the page sees it.
      sendCommand: (command) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win !== undefined) win.webContents.send(DESKTOP_COMMAND_CHANNEL, command)
      },
      showAbout: () => { app.showAboutPanel() },
    })
    app.on('window-all-closed', () => {
      app.quit()
    })
    app.on('before-quit', (event) => {
      broker.teardown()
      nativeChannel.teardown('application quitting')
      const current = supervisor
      if (current === undefined) return
      const state = current.view().state
      // Nothing to stop (stopped/failed) or a stop already in flight.
      if (state === 'stopping' || state === 'stopped' || state === 'failed') return
      event.preventDefault()
      void current.stop().then(() => {
        app.quit()
      })
    })
  })
}
