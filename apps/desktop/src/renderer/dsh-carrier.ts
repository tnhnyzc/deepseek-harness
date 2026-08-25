/**
 * The DSH desktop carrier: installs the pinned `__DSH_TRANSPORT__` seam over
 * the stage 3 transport so the existing DSH client tree runs unchanged.
 * `createApiClient` returns an `AbstractApiClient` whose transport aspect is
 * this carrier — unary calls (and the generic RPC channel's fetch) ride the
 * fetch primitive, and the two downstream event streams ride the stream
 * primitive, wrapped in a Response whose body replays the carrier's frames
 * so the base class's own SSE reader parses them. `loadBundle` carries the
 * module system's bundle bytes: fetch over the fetch primitive, executed as
 * a classic script (the pinned module protocol registers through
 * `window.__ModuleLoader__.load` at execution). Nothing here decodes an
 * envelope or names a business method; the pinned client owns all of that.
 * @module @deepseek-ai/dsh-desktop/src/renderer/dsh-carrier
 */

import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '@deepseek-ai/dsh-client-connection/src/api-path.ts'
import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'
import { AbstractApiClient, type IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { DesktopTransport } from './transport.ts'

/**
 * The documented test seam: a replacement for the classic-script evaluator.
 * jsdom cannot execute scripts at all, so specs inject a stand-in that
 * observes the sources instead of running them.
 */
export interface CarrierEvaluation {
  evaluateScript(source: string): Promise<void>
}

/**
 * Execute one script source as a same-origin classic script (blob object
 * url). The bundle bytes arrive through the trusted transport, so a blob
 * under the document origin keeps the pinned classic-script semantics
 * without widening the CSP beyond `blob:`.
 * @param source - the script text to execute.
 * @returns a promise settling when the script has executed (or failed).
 */
export function evaluateClassicScript(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const settle = (finish: () => void): void => {
      URL.revokeObjectURL(objectUrl)
      script.remove()
      finish()
    }
    script.src = objectUrl
    script.addEventListener('load', () => { settle(resolve) }, { once: true })
    script.addEventListener('error', () => { settle(() => { reject(new Error('client script failed to execute')) }) }, { once: true })
    document.head.append(script)
  })
}

/**
 * Fetch one client bundle over the fetch primitive and execute it as a
 * classic script.
 * @param carrier - the transport client the bundle bytes cross.
 * @param url - the graph row's bundle url (page-relative).
 * @param evaluation - optional test seam standing in for script execution.
 * @returns a promise settling once the script has executed.
 */
export async function loadClientBundle(carrier: DesktopTransport, url: string, evaluation?: CarrierEvaluation): Promise<void> {
  const response = await carrier.fetch(new URL(url, location.origin).href)
  if (!response.ok) {
    throw new Error(`client bundle ${url} failed to load: HTTP ${response.status}`)
  }
  const source = new TextDecoder().decode(await response.arrayBuffer())
  const evaluate: (source: string) => Promise<void> = evaluation
    ? source => evaluation.evaluateScript(source)
    : evaluateClassicScript
  await evaluate(source)
}

/**
 * The carrier's API client: the pinned abstract client over the transport.
 * The only platform decision is routing — the two downstream event paths
 * open the stream primitive; everything else is the fetch primitive.
 */
class DesktopApiClient extends AbstractApiClient {
  constructor(private readonly carrier: DesktopTransport) {
    super()
  }

  /** The transport aspect: stream primitive for the event paths, fetch primitive for the rest. */
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    if (input.pathname === MUX_EVENTS_PATH || input.pathname === HOST_EVENTS_PATH) {
      return this.streamResponse(input, init?.signal ?? undefined)
    }
    return this.carrier.fetch(input.href, init)
  }

  /**
   * One downstream event stream over the stream primitive. The carrier's
   * frames are the host carrier's own SSE bytes; this only replays them into
   * a readable Response body, so the base class's SSE reader — framing,
   * envelope and frame-schema parsing, onOpen timing — runs unchanged.
   */
  private streamResponse(url: URL, signal: AbortSignal | undefined): Promise<Response> {
    return this.carrier.openStream(url.href).then((stream) => {
      const frames = stream.frames()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const result = await frames.next()
          if (result.done) {
            controller.close()
            return
          }
          controller.enqueue(result.value)
        },
        cancel: () => {
          // The consumer gave up: end the stream at the carrier (the local
          // generator settles with it).
          stream.close()
        },
      })
      if (signal !== undefined) {
        if (signal.aborted) stream.close()
        else signal.addEventListener('abort', () => { stream.close() }, { once: true })
      }
      return new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    })
  }
}

/**
 * Install the pinned carrier seam on the page global. Must run before the
 * DSH client tree boots: the connection plugin reads `__DSH_TRANSPORT__`
 * once, at apply time.
 * @param carrier - the transport client the seam carries.
 * @param evaluation - optional test seam standing in for script execution.
 * @returns nothing; the seam is on `globalThis.__DSH_TRANSPORT__`.
 */
export function installDesktopCarrier(carrier: DesktopTransport, evaluation?: CarrierEvaluation): void {
  const api: IApiClient = new DesktopApiClient(carrier)
  const hooks: ClientTransportHooks = {
    createApiClient: () => api,
    fetch: (input, init) => carrier.fetch(input.href, init),
    loadBundle: url => loadClientBundle(carrier, url, evaluation),
  }
  ;(globalThis as { __DSH_TRANSPORT__?: ClientTransportHooks }).__DSH_TRANSPORT__ = hooks
}
