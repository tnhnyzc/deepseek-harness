/**
 * Navigation and privilege lockdown for application web contents.
 * @module @deepseek-ai/dsh-desktop/src/main/security
 */
import { shell, type Session, type WebContents } from 'electron'
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
 * Deny every permission request on the session: the shell has no current
 * consumer for them, and future capabilities opt in explicitly.
 * @param session - session to deny
 * @returns nothing
 */
export function denySessionPermissions(session: Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}
