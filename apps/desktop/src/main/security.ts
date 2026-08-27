/**
 * Navigation and privilege lockdown for application web contents.
 * @module @deepseek-ai/dsh-desktop/src/main/security
 */
import { shell, type WebContents } from 'electron'
import { isAppUrl } from './protocol.ts'

/**
 * Whether a URL may be handed to the operating system shell.
 * @param rawUrl - candidate external URL
 * @returns true only for a parseable http or https URL
 */
export function isWebUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  return url.protocol === 'https:' || url.protocol === 'http:'
}

/**
 * Lock one webContents down: navigation is confined to the app protocol,
 * new windows are denied, webviews are refused, and only a validated web
 * URL ever reaches shell.openExternal.
 * @param webContents - contents to harden
 * @returns nothing
 */
export function hardenWebContents(webContents: WebContents): void {
  webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

/**
 * The session surface the permission lockdown installs: a structural
 * subset of Electron's `Session` so tests fake it without importing
 * Electron values into the Node test context (the sender check's
 * `IpcSender` follows the same pattern).
 */
export interface PermissionSession {
  /** The permission prompt handler: `(webContents, permission, callback)`. */
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void
  /** The permission check handler: `(webContents, permission, requestingOrigin)`. */
  setPermissionCheckHandler(
    handler: (webContents: unknown, permission: string, requestingOrigin: unknown) => boolean,
  ): void
}

/**
 * Deny every permission on the session: the shell has no current consumer
 * for them, and future capabilities opt in explicitly. Both handlers are
 * default-deny — the request handler answers the permission prompt, and the
 * check handler covers the paths Electron consults without prompting — so
 * no permission is grantable until a capability installs its own explicit
 * policy.
 * @param session - session to deny
 * @returns nothing
 */
export function denySessionPermissions(session: PermissionSession): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
}

/**
 * The sender surface of an IPC invocation that the trust check inspects.
 * Electron's `IpcMainEvent` and `IpcMainInvokeEvent` satisfy it; tests fake
 * it without importing Electron values into the Node test context.
 */
export interface IpcSender {
  sender: { id: number }
  senderFrame: { url: string; parent: unknown; isDestroyed(): boolean } | null
}

/**
 * Whether an IPC invocation came from the trusted application main frame:
 * the app windows are sandboxed with no node integration, so a legitimate
 * caller is the main frame of a known application window. Subframes,
 * destroyed senders, non-app origins, and unknown webContents are all
 * refused.
 *
 * @param event - the IPC event (or its sender surface)
 * @param windows - the current application windows
 * @returns true only for a live main frame of a known window on the app protocol
 */
export function isTrustedIpcSender(event: IpcSender, windows: ReadonlyArray<{ webContents: { id: number } }>): boolean {
  const frame = event.senderFrame
  if (frame === null || frame.isDestroyed()) return false
  if (frame.parent !== null) return false // a subframe, not the app page itself
  if (!isAppUrl(frame.url)) return false
  return windows.some(window => window.webContents.id === event.sender.id)
}
