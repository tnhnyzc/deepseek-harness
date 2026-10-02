/**
 * The DSH desktop carrier: installs the `__DSH_TRANSPORT__` seam (the
 * candidate's `ClientTransportHooks`) over the stage 3 transport so the
 * candidate DSH client tree runs unchanged. The candidate client owns all DSH
 * semantics; this carrier only routes its transport surface onto the generic
 * byte channel — unary RPC rides the fetch primitive, stream Remote methods
 * ride the stream primitive (the DSH-facing codec maps the endpoint to a route
 * and encodes the payload and items as opaque JSON bytes at this boundary),
 * and `loadBundle` carries the module system's bundle bytes: fetch over the
 * fetch primitive, executed as a classic script (the candidate module protocol
 * registers through `window.__ModuleLoader__.load` at execution). Nothing here
 * decodes an RPC envelope or names a business method.
 * @module @deepseek-ai/dsh-desktop/src/renderer/dsh-carrier
 */

import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'
import {
  RemoteItemReader,
  encodeRemotePayload,
  endpointRoute,
} from '@deepseek-ai/dsh-desktop-runtime/remote-codec'
import type { DesktopStream, DesktopTransport } from './transport.ts'

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
 * under the document origin keeps the classic-script semantics without
 * widening the CSP beyond `blob:`.
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
 * One stream Remote method over the stream primitive. The opener's frames are
 * the codec's opaque JSON bytes; this only replays them, decoded, as the
 * candidate's decoded-item iterable so the base client's stream consumption
 * (framing, envelope and item-schema parsing) runs unchanged. The caller's
 * signal rides the open itself: the transport owns its cancellation for the
 * stream's whole lifetime, including the pending open acknowledgement, and the
 * stream is closed on every terminal.
 * @param carrier - the transport client the stream frames cross.
 * @param endpoint - the Remote endpoint the client names the stream by.
 * @param payload - the Remote endpoint's open arguments.
 * @param signal - the caller's cancellation for the open's whole lifetime.
 * @returns an iterable of the stream's decoded items.
 */
function openRemoteStream(
  carrier: DesktopTransport,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  return (async function* (): AsyncGenerator<unknown, void> {
    let stream: DesktopStream
    try {
      stream = await carrier.openStream(endpointRoute(endpoint), signal, encodeRemotePayload(payload))
    } catch (error) {
      throw error
    }
    const reader = new RemoteItemReader()
    try {
      for await (const frame of stream.frames()) {
        for (const item of reader.push(frame)) {
          yield item
        }
      }
    } finally {
      stream.close()
    }
  })()
}

/**
 * Install the carrier seam on the page global. Must run before the DSH client
 * tree boots: the connection plugin reads `__DSH_TRANSPORT__` once, at apply
 * time. The transport owns the Host outright (it runs inside this shell's
 * spawned runtime), so the privileged surface is reachable regardless of the
 * page authority.
 * @param carrier - the transport client the seam carries.
 * @param evaluation - optional test seam standing in for script execution.
 * @returns nothing; the seam is on `globalThis.__DSH_TRANSPORT__`.
 */
export function installDesktopCarrier(carrier: DesktopTransport, evaluation?: CarrierEvaluation): void {
  const hooks: ClientTransportHooks = {
    fetch: (input, init) => carrier.fetch(input.href, init),
    openStream: (endpoint, payload, signal) => openRemoteStream(carrier, endpoint, payload, signal),
    loadBundle: url => loadClientBundle(carrier, url, evaluation),
    ownsHost: true,
  }
  ;(globalThis as { __DSH_TRANSPORT__?: ClientTransportHooks }).__DSH_TRANSPORT__ = hooks
}
