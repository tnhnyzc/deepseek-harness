/**
 * Unit coverage for the dsh-app:// path-confinement and URL-validation logic
 * that keeps the protocol handler and the navigation lockdown from serving
 * or opening anything outside the renderer distribution.
 */
import { join, normalize } from 'node:path'
import { describe, it, expect } from 'vitest'
import { isLoopbackHostname } from '@deepseek-ai/dsh-client-connection/src/loopback-hostname.ts'
import {
  APP_PROTOCOL,
  APP_PROTOCOL_HOST,
  decodePathname,
  isAppUrl,
  resolveRendererFile,
} from '../src/main/protocol.ts'
import { isWebUrl } from '../src/main/security.ts'

const root = normalize('/opt/renderer')
const rooted = (rel: string): string => normalize(join(root, rel))

describe('resolveRendererFile', () => {
  it('maps a web path onto a file under the renderer root', () => {
    expect(resolveRendererFile(root, '/index.html')).toBe(rooted('index.html'))
    expect(resolveRendererFile(root, '/assets/app.js')).toBe(rooted('assets/app.js'))
  })

  it('answers the root itself for the root path', () => {
    expect(resolveRendererFile(root, '/')).toBe(root)
  })

  it('rejects .. traversal that escapes the root', () => {
    expect(resolveRendererFile(root, '/../../etc/passwd')).toBeUndefined()
    expect(resolveRendererFile(root, '/assets/../../../etc/passwd')).toBeUndefined()
  })

  it('rejects a path that does not begin with a slash', () => {
    expect(resolveRendererFile(root, 'index.html')).toBeUndefined()
  })
})

describe('decodePathname', () => {
  it('decodes percent-encoded sequences', () => {
    expect(decodePathname('/index.html')).toBe('/index.html')
    expect(decodePathname('/%2e%2e/%2e%2e/etc/passwd')).toBe('/../../etc/passwd')
  })

  it('rejects an invalid percent sequence', () => {
    expect(decodePathname('/%zz/index.html')).toBeUndefined()
  })

  it('rejects an embedded null byte', () => {
    expect(decodePathname('/a\u0000b')).toBeUndefined()
  })
})

describe('isAppUrl', () => {
  it('accepts the app protocol on the app host or with no host', () => {
    expect(isAppUrl(`${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/index.html`)).toBe(true)
    expect(isAppUrl(`${APP_PROTOCOL}://`)).toBe(true)
  })

  it('rejects a foreign host and every other protocol', () => {
    expect(isAppUrl(`${APP_PROTOCOL}://evil/index.html`)).toBe(false)
    expect(isAppUrl(`${APP_PROTOCOL}://index.html`)).toBe(false)
    expect(isAppUrl('https://example.com/')).toBe(false)
    expect(isAppUrl('not a url')).toBe(false)
  })
})

describe('protocol host and the pinned loopback classifier', () => {
  // The pinned client derives ctx.connection.isLoopback from
  // location.hostname through its zero-dependency classifier; UI affordances
  // and the /api Host fence AND on loopback. A bare custom host would
  // classify non-loopback and hide them, so the host is a loopback literal.
  it('classifies the protocol host as loopback to the pinned classifier', () => {
    expect(isLoopbackHostname(APP_PROTOCOL_HOST)).toBe(true)
  })
})

describe('isWebUrl', () => {
  it('accepts http and https only', () => {
    expect(isWebUrl('https://example.com/')).toBe(true)
    expect(isWebUrl('http://example.com/')).toBe(true)
  })

  it('rejects non-web schemes and unparseable input', () => {
    expect(isWebUrl('file:///etc/passwd')).toBe(false)
    expect(isWebUrl(`${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/index.html`)).toBe(false)
    expect(isWebUrl('javascript:alert(1)')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
  })
})
