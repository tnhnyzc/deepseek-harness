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
 * composition serves, through the registry's own authoritative serving face
 * (`fetchBundle`) so the two carriers share one parser and one validation.
 * @module @deepseek-ai/dsh-desktop-runtime/boot-graph
 */

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

/**
 * Fetch dispatch serving client bundle bytes through the registry's own
 * authoritative serving face (`fetchBundle`), so the shell/no-Web carrier and
 * the web composition's HTTP route share one parser and one validation and
 * cannot disagree about single/combo URLs, advertised revisions, source maps,
 * method handling, or the prior-generation recomposition race window. This
 * module owns only the dispatch — no bundle parsing or path logic.
 * @param registry - the client module registry that owns the response state.
 * @returns a fetch dispatch for the bundle routes.
 */
export function createClientBundleFetch(
  registry: { fetchBundle(request: Request): Promise<Response> },
): (request: Request) => Promise<Response> {
  return request => registry.fetchBundle(request)
}
