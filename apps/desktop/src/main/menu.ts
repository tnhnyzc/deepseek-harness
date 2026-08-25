/**
 * The stage 7 native application menu: the standard platform menus (app,
 * File, Edit, View, Session, Window, Help) with the desktop UX commands
 * bound to the closed `DesktopCommand` vocabulary. A menu click sends one
 * vocabulary member over the command channel to the app window's main
 * frame; the renderer translates it into the existing pinned DSH client
 * action (see `src/renderer/desktop-commands.ts`). This module never
 * touches Harness state itself — Electron owns the chrome, the pinned
 * client owns the semantics. Platform accelerators are the standard set
 * (Cmd/Ctrl+N, Cmd/Ctrl+O, Cmd/Ctrl+`, Cmd/Ctrl+\`); there are no
 * OS-global shortcuts and no Escape bindings, and Developer Tools is
 * offered only while the app runs unpackaged.
 * The template is a pure function of its options so the menu surface can
 * be unit-tested without an Electron app.
 * @module @deepseek-ai/dsh-desktop/src/main/menu
 */
import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopCommand } from '../shared/desktop-command.ts'

/** The desktop shell's display name (matches the packager's app name). */
export const DESKTOP_APP_NAME = 'DeepSeek Harness Desktop'

/**
 * Everything the menu template needs, supplied by the shell entry so the
 * template stays a pure function (tests pass recorders, not Electron).
 */
export interface ApplicationMenuOptions {
  /** The display name used in the app menu and About item. */
  appName: string
  /** The platform is macOS (app menu, Window role, Command modifiers). */
  isMac: boolean
  /** The app runs unpackaged (Developer Tools is offered in the View menu). */
  devToolsAvailable: boolean
  /** Send one closed-vocabulary command to the app window's main frame. */
  sendCommand: (command: DesktopCommand) => void
  /** Show the platform about panel (non-macOS Help item). */
  showAbout: () => void
}

/**
 * Build the application menu template.
 * @param options - the shell-supplied menu inputs
 * @returns the template Electron builds into the native menu
 */
export function buildApplicationMenuTemplate(options: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const send = (command: DesktopCommand): void => { options.sendCommand(command) }
  const appMenu: MenuItemConstructorOptions = {
    label: options.appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => { send('open-settings') } },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => { send('new-session') } },
      { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => { send('open-workspace') } },
      { type: 'separator' },
      { role: 'close' },
    ],
  }
  const devToolsEntry: MenuItemConstructorOptions[] = options.devToolsAvailable ? [{ role: 'toggleDevTools' }] : []
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => { send('toggle-sidebar') } },
      { type: 'separator' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { role: 'resetZoom' },
      ...devToolsEntry,
    ],
  }
  const sessionMenu: MenuItemConstructorOptions = {
    label: 'Session',
    submenu: [
      { label: 'New Session', click: () => { send('new-session') } },
      { label: 'Cancel Current Run', click: () => { send('cancel-run') } },
      { label: 'Rename Session', click: () => { send('rename-session') } },
    ],
  }
  const windowMenu: MenuItemConstructorOptions = { label: 'Window', role: 'windowMenu' }
  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      // Disabled until the fork publishes documentation or a runtime log
      // surface: the runtime's stdio lands in a bounded in-memory
      // diagnostics buffer (stage 17 owns the page and opener).
      { label: 'DeepSeek Harness Documentation', enabled: false, toolTip: 'No published documentation for this fork yet.' },
      { label: 'View Runtime Logs', enabled: false, toolTip: 'Runtime logs are in memory until the diagnostics stage.' },
      // macOS carries About in the application menu (role: 'about'); the
      // other platforms put it in Help.
      ...(options.isMac ? [] : [{ label: `About ${options.appName}`, click: () => { options.showAbout() } }]),
    ],
  }
  return [
    ...(options.isMac ? [appMenu] : []),
    fileMenu,
    { role: 'editMenu' },
    viewMenu,
    sessionMenu,
    ...(options.isMac ? [windowMenu] : []),
    helpMenu,
  ]
}

/**
 * Install the native application menu: the about panel identity plus the
 * template built from the shell's options.
 * @param options - the shell-supplied menu inputs
 */
export function installApplicationMenu(options: ApplicationMenuOptions): void {
  app.setAboutPanelOptions({ applicationName: options.appName, version: app.getVersion() })
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(options)))
}
