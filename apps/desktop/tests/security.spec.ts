/**
 * The IPC sender trust check: state reads, restarts, and transport opens are
 * answered only for the application's own main frame. Subframes, destroyed
 * senders, foreign origins, and unknown webContents are all refused.
 */

import { describe, expect, it } from 'vitest'
import { denySessionPermissions, isTrustedIpcSender, type IpcSender } from '../src/main/security.ts'

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

describe('denySessionPermissions', () => {
  function fakeSession() {
    const installed: {
      request?: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void
      check?: (webContents: unknown, permission: string, requestingOrigin: unknown) => boolean
    } = {}
    const session = {
      setPermissionRequestHandler: (handler: NonNullable<typeof installed.request>): void => { installed.request = handler },
      setPermissionCheckHandler: (handler: NonNullable<typeof installed.check>): void => { installed.check = handler },
    }
    return { installed, session }
  }

  it('installs a deny-all request handler and a deny-all check handler', () => {
    const { installed, session } = fakeSession()
    denySessionPermissions(session)
    expect(installed.request).toBeTypeOf('function')
    expect(installed.check).toBeTypeOf('function')
    const denied: boolean[] = []
    installed.request?.(null, 'geolocation', (granted) => { denied.push(granted) })
    expect(denied).toEqual([false])
    expect(installed.check?.(null, 'camera', null)).toBe(false)
  })
})
