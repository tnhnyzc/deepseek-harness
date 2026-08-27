/**
 * The private frontend protocol. dsh-app:// serves only the packaged
 * renderer distribution; no other local file is reachable through it.
 * @module @deepseek-ai/dsh-desktop/src/main/protocol
 */
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'

/** The private frontend protocol scheme. */
export const APP_PROTOCOL = 'dsh-app'
/**
 * The single protocol host: a loopback literal. The pinned DSH client
 * derives `ctx.connection.isLoopback` from `location.hostname` through its
 * zero-dependency classifier, and UI affordances (native path open, the
 * configuration plane) AND on that flag — a bare custom host would classify
 * non-loopback and hide them. `127.0.0.1` is loopback to the unmodified
 * classifier, and it is the authority the `/api` Host fence sees when the
 * runtime completes it from the request URL.
 */
export const APP_PROTOCOL_HOST = '127.0.0.1'
/** URL of the main application page. */
export const APP_HOME_URL = `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/index.html`

/**
 * Register the scheme with standard-URL, secure-context, and fetch
 * privileges. Must run before the app is ready.
 * @returns nothing
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

/**
 * Whether a navigation target stays inside the application.
 * @param rawUrl - navigation target
 * @returns true for a parseable app-protocol URL without a foreign host
 */
export function isAppUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  return url.protocol === `${APP_PROTOCOL}:` && (url.host === APP_PROTOCOL_HOST || url.host === '')
}

/**
 * Decode a URL pathname for filesystem mapping.
 * @param pathname - URL pathname
 * @returns the decoded path, or undefined for invalid percent sequences or
 *   a null byte in the encoded or the decoded form (`%00` decodes to one)
 */
export function decodePathname(pathname: string): string | undefined {
  if (pathname.includes('\u0000')) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  return decoded.includes('\u0000') ? undefined : decoded
}

/**
 * Map a decoded web path onto a file under the renderer distribution root.
 * The result is confined to the root: `..` traversal, absolute paths, and
 * every other escape answer undefined.
 * @param rendererRoot - absolute renderer distribution directory
 * @param webPath - decoded absolute web path
 * @returns absolute file path inside the root, or undefined outside it
 */
export function resolveRendererFile(rendererRoot: string, webPath: string): string | undefined {
  if (!webPath.startsWith('/')) return undefined
  const root = normalize(rendererRoot)
  const candidate = normalize(join(root, webPath))
  if (candidate !== `${root}${sep}` && !candidate.startsWith(`${root}${sep}`)) return undefined
  return candidate === `${root}${sep}` ? root : candidate
}

/**
 * Install the protocol handler rooted at the renderer distribution.
 * Served files are additionally re-checked against the real (symlink-
 * resolved) root before their bytes are read.
 * @param rendererRoot - absolute renderer distribution directory
 * @returns nothing
 */
export function handleAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_PROTOCOL_HOST && url.host !== '') return notFound()
    const webPath = decodePathname(url.pathname)
    if (webPath === undefined) return notFound()
    let candidate = resolveRendererFile(rendererRoot, webPath)
    if (candidate === undefined) return notFound()
    if (candidate === normalize(rendererRoot)) candidate = join(candidate, 'index.html')
    if (!existsSync(candidate)) return notFound()
    const [realRoot, realFile] = await Promise.all([realpath(rendererRoot), realpath(candidate)])
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) return notFound()
    return net.fetch(pathToFileURL(realFile).toString())
  })
}

/**
 * @returns a 404 response for unreachable renderer files
 */
function notFound(): Response {
  return new Response('not found', { status: 404, statusText: 'Not Found' })
}
