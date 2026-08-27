/**
 * The IPC sender trust check: state reads, restarts, and transport opens are
 * answered only for the application's own main frame. Subframes, destroyed
 * senders, foreign origins, and unknown webContents are all refused.
 *
 * The session permission policy: default-deny on both Electron hooks, with
 * the single source-proven exception — the pinned DSH clipboard write
 * (`clipboard-sanitized-write`) from an application window.
 */

import { describe, expect, it } from 'vitest'
import {
  CLIPBOARD_WRITE_PERMISSION,
  installSessionPermissionPolicy,
  isTrustedIpcSender,
  isSessionPermissionAllowed,
  type IpcSender,
  type PermissionWebContents,
} from '../src/main/security.ts'

// D3: the protocol host is loopback (127.0.0.1), not a bare 'app' host.
const TRUSTED_URL = 'dsh-app://127.0.0.1/index.html'

function senderEvent(overrides: Partial<IpcSender> = {}): IpcSender {
  return {
    sender: { id: 7 },
    senderFrame: { url: TRUSTED_URL, parent: null, isDestroyed: () => false },
    ...overrides,
  }
}

const frame = (url: string, overrides: Partial<{ parent: unknown; isDestroyed: () => boolean }> = {}): IpcSender['senderFrame'] => ({
  url,
  parent: null,
  isDestroyed: () => false,
  ...overrides,
})

const windows = [{ webContents: { id: 7 } }]

describe('isTrustedIpcSender', () => {
  it('trusts the main frame of a known window', () => {
    expect(isTrustedIpcSender(senderEvent(), windows)).toBe(true)
  })

  it('refuses a subframe of the app page', () => {
    expect(isTrustedIpcSender(senderEvent({ senderFrame: frame(TRUSTED_URL, { parent: { id: 1 } }) }), windows)).toBe(false)
  })

  it('refuses a destroyed or missing frame', () => {
    expect(isTrustedIpcSender(senderEvent({ senderFrame: frame(TRUSTED_URL, { isDestroyed: () => true }) }), windows)).toBe(false)
    expect(isTrustedIpcSender(senderEvent({ senderFrame: null }), windows)).toBe(false)
  })

  it('refuses a foreign origin', () => {
    expect(isTrustedIpcSender(senderEvent({ senderFrame: frame('http://evil.example/index.html') }), windows)).toBe(false)
    expect(isTrustedIpcSender(senderEvent({ senderFrame: frame('file:///etc/passwd') }), windows)).toBe(false)
    expect(isTrustedIpcSender(senderEvent({ senderFrame: frame('dsh-app://evil-host/index.html') }), windows)).toBe(false)
    expect(isTrustedIpcSender(senderEvent({ senderFrame: frame('not a url') }), windows)).toBe(false)
  })

  it('refuses an unknown webContents', () => {
    expect(isTrustedIpcSender(senderEvent({ sender: { id: 8 } }), windows)).toBe(false)
    expect(isTrustedIpcSender(senderEvent(), [])).toBe(false)
  })
})

// ── the session permission policy: default-deny + the clipboard write ─────

const wc = (url: string, type = 'window'): PermissionWebContents => ({
  getType: () => type,
  getURL: () => url,
})

describe('isSessionPermissionAllowed', () => {
  it('allows exactly the clipboard write from an application window', () => {
    expect(CLIPBOARD_WRITE_PERMISSION).toBe('clipboard-sanitized-write')
    expect(isSessionPermissionAllowed(wc(TRUSTED_URL), CLIPBOARD_WRITE_PERMISSION)).toBe(true)
  })

  it('denies every other permission', () => {
    for (const permission of ['clipboard-read', 'notifications', 'media', 'geolocation', 'usb', 'fullscreen']) {
      expect(isSessionPermissionAllowed(wc(TRUSTED_URL), permission), permission).toBe(false)
    }
  })

  it('denies the clipboard write from a foreign origin', () => {
    for (const url of ['https://evil.example/index.html', 'file:///etc/passwd', 'dsh-app://wrong-host/index.html']) {
      expect(isSessionPermissionAllowed(wc(url), CLIPBOARD_WRITE_PERMISSION), url).toBe(false)
    }
  })

  it('denies the clipboard write from a non-window webContents', () => {
    for (const type of ['webview', 'backgroundPage', 'offscreen']) {
      expect(isSessionPermissionAllowed(wc(TRUSTED_URL, type), CLIPBOARD_WRITE_PERMISSION), type).toBe(false)
    }
  })
})

describe('installSessionPermissionPolicy', () => {
  function fakeSession() {
    const installed: {
      request?: (webContents: PermissionWebContents, permission: string, callback: (granted: boolean) => void) => void
      check?: (webContents: PermissionWebContents | null, permission: string, requestingOrigin: string) => boolean
    } = {}
    const session = {
      setPermissionRequestHandler: (handler: NonNullable<typeof installed.request>): void => { installed.request = handler },
      setPermissionCheckHandler: (handler: NonNullable<typeof installed.check>): void => { installed.check = handler },
    }
    return { installed, session }
  }

  it('installs both hooks with the same default-deny predicate', () => {
    const { installed, session } = fakeSession()
    installSessionPermissionPolicy(session)
    expect(installed.request).toBeTypeOf('function')
    expect(installed.check).toBeTypeOf('function')
  })

  it('the request hook grants the trusted app clipboard write', () => {
    const { installed, session } = fakeSession()
    installSessionPermissionPolicy(session)
    const granted: boolean[] = []
    installed.request?.(wc(TRUSTED_URL), CLIPBOARD_WRITE_PERMISSION, (value) => { granted.push(value) })
    expect(granted).toEqual([true])
  })

  it('the request hook denies every other case', () => {
    const { installed, session } = fakeSession()
    installSessionPermissionPolicy(session)
    const cases: Array<[PermissionWebContents, string]> = [
      [wc(TRUSTED_URL), 'clipboard-read'],
      [wc(TRUSTED_URL), 'notifications'],
      [wc('https://evil.example/'), CLIPBOARD_WRITE_PERMISSION],
      [wc('file:///etc/passwd'), CLIPBOARD_WRITE_PERMISSION],
      [wc('dsh-app://wrong-host/'), CLIPBOARD_WRITE_PERMISSION],
      [wc(TRUSTED_URL, 'webview'), CLIPBOARD_WRITE_PERMISSION],
    ]
    for (const [contents, permission] of cases) {
      const granted: boolean[] = []
      installed.request?.(contents, permission, (value) => { granted.push(value) })
      expect(granted, `${permission} @ ${contents.getURL()}`).toEqual([false])
    }
  })

  it('the check hook grants the clipboard write only with the exact app origin', () => {
    const { installed, session } = fakeSession()
    installSessionPermissionPolicy(session)
    expect(installed.check?.(wc(TRUSTED_URL), CLIPBOARD_WRITE_PERMISSION, 'dsh-app://127.0.0.1')).toBe(true)
    // Wrong origins and the load-time capability probes (empty origin/URL).
    expect(installed.check?.(wc(TRUSTED_URL), CLIPBOARD_WRITE_PERMISSION, 'https://evil.example')).toBe(false)
    expect(installed.check?.(wc(TRUSTED_URL), CLIPBOARD_WRITE_PERMISSION, 'file:///')).toBe(false)
    expect(installed.check?.(wc(TRUSTED_URL), CLIPBOARD_WRITE_PERMISSION, 'dsh-app://wrong-host')).toBe(false)
    expect(installed.check?.(wc(TRUSTED_URL), CLIPBOARD_WRITE_PERMISSION, '')).toBe(false)
    expect(installed.check?.(wc(''), CLIPBOARD_WRITE_PERMISSION, 'dsh-app://127.0.0.1')).toBe(false)
    // A null webContents is unverifiable (Electron may consult the check
    // before contents exist) and is denied.
    expect(installed.check?.(null, CLIPBOARD_WRITE_PERMISSION, 'dsh-app://127.0.0.1')).toBe(false)
  })

  it('the check hook denies every other permission, even from the app', () => {
    const { installed, session } = fakeSession()
    installSessionPermissionPolicy(session)
    for (const permission of ['clipboard-read', 'media', 'geolocation', 'web-app-installation']) {
      expect(installed.check?.(wc(TRUSTED_URL), permission, 'dsh-app://127.0.0.1'), permission).toBe(false)
    }
  })
})
