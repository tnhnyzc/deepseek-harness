/**
 * The desktop host plane's client-boot artifacts. The web composition
 * delivers the boot protocol through the index render (facade script,
 * parser-preload script tags, the `__DSH_BOOT__` global) over HTTP; the
 * desktop host has no HTTP server, so it reads the same artifacts from the
 * in-process sources — the composed graph from the client module registry
 * and the injection rows from the pinned `bootInjections` — and hands them
 * to the carrier: the graph and the two host-owned script artifacts ride a
 * control message, and the bundle bytes the graph rows name are served on
 * the transport's fetch channel at the same `/plugins` path the web
 * composition serves, resolved through the registry's table (no path logic
 * is duplicated here).
 * @module @deepseek-ai/dsh-desktop-runtime/boot-graph
 */

import { readFile } from 'node:fs/promises'
import { bootInjections, type WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** The control message carrying the host's client-boot artifacts to the supervisor. */
export interface BootGraphMessage {
  type: 'runtime.boot-graph'
  /** The composed entry graph, byte-identical in shape to `window.__DSH_BOOT__`. */
  graph: WebBootGraph
  /** The module-loader facade script the index render splices into the head. */
  moduleLoaderScript: string
  /** The parser-preload bundle urls, in the order the index render emits them. */
  preloadBundles: string[]
}

/** The surface the boot artifacts read: the registry's graph accessor. */
export interface BootGraphSource {
  graph(): WebBootGraph
}

/**
 * Build the control message from the live registry: the current graph plus
 * the facade and preload rows exactly as the pinned boot protocol emits them.
 * @param source - the client module registry (or a stand-in exposing `graph()`).
 * @returns the message the supervisor caches until the renderer pulls it.
 * @throws when the injection rows no longer carry the facade script row.
 */
export function bootGraphMessage(source: BootGraphSource): BootGraphMessage {
  const graph = source.graph()
  const injections = bootInjections(graph)
  const facade = injections.find(row => row.kind === 'script')
  if (facade === undefined || typeof facade.text !== 'string') {
    throw new Error('desktop runtime: the boot injections carry no module-loader facade script')
  }
  return {
    type: 'runtime.boot-graph',
    graph,
    moduleLoaderScript: facade.text,
    preloadBundles: injections
      .filter(row => row.kind === 'script-src')
      .map(row => row.src),
  }
}

/** The prefix the web composition serves client bundles under (a carrier path, not a route this module owns). */
const BUNDLE_PREFIX = '/plugins/'
const BUNDLE_SUFFIX = '/client.js'
const SOURCE_MAP_SUFFIX = '/client.js.map'

/**
 * Fetch dispatch serving client bundle bytes the way the registry's own
 * `/plugins` route does: only the ids the registry's table knows, only the
 * bundle and source-map suffixes, `no-cache`, 405 for non-GET/HEAD, 404 for
 * every miss. The id → file resolution is the registry's (`clientPath`);
 * this function owns only the request/response mechanics.
 * @param registry - the client module table the paths resolve through.
 * @returns a fetch dispatch for the bundle routes.
 */
export function createClientBundleFetch(
  registry: { clientPath(id: string): string | undefined },
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 })
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return notFound()
    }
    const isSourceMap = pathname.startsWith(BUNDLE_PREFIX) && pathname.endsWith(SOURCE_MAP_SUFFIX)
    const suffix = isSourceMap ? SOURCE_MAP_SUFFIX : BUNDLE_SUFFIX
    const id = pathname.startsWith(BUNDLE_PREFIX) && pathname.endsWith(suffix)
      ? pathname.slice(BUNDLE_PREFIX.length, -suffix.length)
      : undefined
    const clientPath = id === undefined ? undefined : registry.clientPath(id)
    const path = clientPath === undefined ? undefined : `${clientPath}${isSourceMap ? '.map' : ''}`
    if (path === undefined) return notFound()
    try {
      const body = await readFile(path)
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'content-type': isSourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        },
      })
    } catch {
      // Registered but unreadable (bundle not built): a loud 404, like the
      // registry's own route.
      return notFound()
    }
  }
}

function notFound(): Response {
  return new Response('not found', { status: 404 })
}
