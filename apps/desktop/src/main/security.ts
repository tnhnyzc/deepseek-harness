/**
 * Navigation and privilege lockdown for application web contents.
 * @module @deepseek-ai/dsh-desktop/src/main/security
 */
import { shell, type WebContents } from 'electron'
import { APP_PROTOCOL, APP_PROTOCOL_HOST, isAppUrl } from './protocol.ts'

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

/** The exact browser permission the pinned DSH clipboard helper needs. */
export const CLIPBOARD_WRITE_PERMISSION = 'clipboard-sanitized-write'

/** The trusted application origin the check handler matches exactly. */
const APP_ORIGIN = `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}`

/**
 * The webContents surface the permission policy inspects: a structural
 * subset of Electron's `WebContents` so tests fake it without importing
 * Electron values into the Node test context (the sender check's
 * `IpcSender` follows the same pattern).
 */
export interface PermissionWebContents {
  /** `'window'` for the application windows; other types are never granted. */
  getType(): string
  /** The main-frame URL the request arrived through. */
  getURL(): string
}

/**
 * The session surface the permission policy installs: a structural subset
 * of Electron's `Session` so tests fake it without importing Electron
 * values into the Node test context (the sender check's `IpcSender`
 * follows the same pattern).
 */
export interface PermissionSession {
  /** The permission prompt handler: `(webContents, permission, callback)`. */
  setPermissionRequestHandler(
    handler: (webContents: PermissionWebContents, permission: string, callback: (granted: boolean) => void) => void,
  ): void
  /**
   * The permission check handler: `(webContents, permission, requestingOrigin)`.
   * Electron may consult it with a null webContents (before contents exist) —
   * such a request is unverifiable and therefore denied.
   */
  setPermissionCheckHandler(
    handler: (webContents: PermissionWebContents | null, permission: string, requestingOrigin: string) => boolean,
  ): void
}

/**
 * Whether one permission may be granted: the policy is default-deny with
 * exactly one exception — the pinned DSH clipboard helper
 * (`packages/client/ui-primitives/src/clipboard.ts`) writes through
 * `navigator.clipboard.writeText`, and Electron 43 routes that call to the
 * session's permission REQUEST handler with `clipboard-sanitized-write`
 * (probe evidence: `apps/desktop/tests/desktop-clipboard-security.spec.ts`
 * and the stage 10 correction Agent Note). The grant is limited to a
 * window-type webContents on the app protocol: Electron's permission
 * callbacks expose no requesting frame, so the main-frame restriction is
 * enforced through the window type plus the main-frame URL; the app
 * renders no subframes (`webviewTag` off, no third-party frames).
 *
 * @param webContents - the requesting contents
 * @param permission - the permission string Electron named
 * @returns true only for the clipboard write from an application window
 */
export function isSessionPermissionAllowed(webContents: PermissionWebContents, permission: string): boolean {
  return permission === CLIPBOARD_WRITE_PERMISSION
    && webContents.getType() === 'window'
    && isAppUrl(webContents.getURL())
}

/**
 * Install the session permission policy on both Electron hooks: the
 * request handler answers the prompt path (the one the clipboard write
 * takes), and the check handler covers the paths Electron consults
 * without prompting. Both agree on the same default-deny predicate; the
 * check handler additionally requires the exact app origin, because the
 * Chromium capability probes it receives at load time carry an empty
 * origin and URL and are therefore unverifiable.
 * @param session - session to lock down
 * @returns nothing
 */
export function installSessionPermissionPolicy(session: PermissionSession): void {
  session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isSessionPermissionAllowed(webContents, permission))
  })
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    webContents !== null
      && isSessionPermissionAllowed(webContents, permission)
      && requestingOrigin === APP_ORIGIN,
  )
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
