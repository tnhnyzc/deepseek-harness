// @vitest-environment jsdom
/**
 * Unit coverage for the DSH desktop carrier: the `__DSH_TRANSPORT__` seam
 * shape (the candidate's `ClientTransportHooks`), the stream opener's codec
 * bridge (endpoint→route, payload and items as opaque JSON bytes), the unary
 * fetch primitive, and the bundle loader (fetch over the fetch primitive,
 * execution through the documented classic-script seam). A scripted fake
 * transport stands in for the stage 3 port; nothing here decodes an envelope
 * beyond the codec's own JSON framing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  endpointRoute,
  frameRemoteItem,
} from '@deepseek-ai/dsh-desktop-runtime/remote-codec'
import {
  evaluateClassicScript,
  installDesktopCarrier,
  loadClientBundle,
} from '../src/renderer/dsh-carrier.ts'
import type { DesktopStream, DesktopTransport } from '../src/renderer/transport.ts'

interface FetchCall {
  url: string
  init?: RequestInit
}

interface ScriptedStream {
  url: string
  data?: Uint8Array
  frames: Uint8Array[]
  closed: boolean
}

/** The transport input is a url string or a Request; both carry an href. */
function urlText(url: string | Request): string {
  return url instanceof Request ? url.url : url
}

function fakeTransport(behavior?: {
  fetch?: (call: FetchCall) => Promise<Response>
  onStream?: (stream: ScriptedStream) => void
}): DesktopTransport & { calls: FetchCall[]; streams: ScriptedStream[]; openSignals: AbortSignal[] } {
  const calls: FetchCall[] = []
  const streams: ScriptedStream[] = []
  const openSignals: AbortSignal[] = []
  const transport: DesktopTransport & { calls: FetchCall[]; streams: ScriptedStream[]; openSignals: AbortSignal[] } = {
    calls,
    streams,
    openSignals,
    async fetch(url, init) {
      const call: FetchCall = { url: urlText(url) }
      if (init !== undefined) call.init = init
      calls.push(call)
      if (behavior?.fetch) return behavior.fetch(call)
      throw new Error(`fake transport: unexpected fetch ${urlText(url)}`)
    },
    async openStream(url, signal, data) {
      if (signal !== undefined) openSignals.push(signal)
      const stream: ScriptedStream = { url: urlText(url), frames: [], closed: false, ...(data !== undefined ? { data } : {}) }
      streams.push(stream)
      behavior?.onStream?.(stream)
      const handle: DesktopStream = {
        id: `fake-${String(streams.length)}`,
        outcome: new Promise<void>(() => { /* never settles in the fake */ }),
        async* frames() {
          for (const frame of stream.frames) yield frame
          await new Promise<void>((resolveWait) => {
            const check = (): void => { if (stream.closed) resolveWait(); else setTimeout(check, 5) }
            check()
          })
        },
        async send() {
          throw new Error('fake transport: no uplink in these tests')
        },
        close() {
          stream.closed = true
        },
      }
      return handle
    },
    close() {
      for (const stream of streams) stream.closed = true
    },
  }
  return transport
}

function envelopeResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('installDesktopCarrier', () => {
  let evaluation: { evaluateScript: (source: string) => Promise<void> }

  beforeEach(() => {
    evaluation = { evaluateScript: vi.fn(async () => undefined) }
  })

  afterEach(() => {
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
  })

  it('installs the carrier seam shape on the page global', () => {
    const transport = fakeTransport()
    installDesktopCarrier(transport, evaluation)
    const hooks = (globalThis as unknown as {
      __DSH_TRANSPORT__: {
        fetch: (input: URL, init: RequestInit) => Promise<Response>
        openStream: (endpoint: string, payload: unknown, signal: AbortSignal) => AsyncIterable<unknown>
        loadBundle?: (url: string) => Promise<void>
        ownsHost?: boolean
      }
    }).__DSH_TRANSPORT__
    expect(typeof hooks.fetch).toBe('function')
    expect(typeof hooks.openStream).toBe('function')
    expect(typeof hooks.loadBundle).toBe('function')
    // The transport owns the Host outright (a local spawned runtime).
    expect(hooks.ownsHost).toBe(true)
  })

  it('routes the generic RPC fetch through the fetch primitive', async () => {
    const transport = fakeTransport({
      fetch: async (call) => {
        const body = call.init?.body
        const rpcId = typeof body === 'string' ? (JSON.parse(body) as { rpcId: string }).rpcId : 'r'
        return envelopeResponse(rpcId, {})
      },
    })
    installDesktopCarrier(transport, evaluation)
    const hooks = (globalThis as unknown as {
      __DSH_TRANSPORT__: { fetch: (input: URL, init: RequestInit) => Promise<Response> }
    }).__DSH_TRANSPORT__
    const response = await hooks.fetch(new URL('http://dsh.local/api/session.list'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'unit-rpc-1', method: 'session.list', payload: {} }),
    })
    expect(response.status).toBe(200)
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.url).toBe('http://dsh.local/api/session.list')
  })
})

describe('stream opener codec bridge (through the seam)', () => {
  let evaluation: { evaluateScript: (source: string) => Promise<void> }

  beforeEach(() => {
    evaluation = { evaluateScript: vi.fn(async () => undefined) }
  })

  afterEach(() => {
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
  })

  it('opens on the stream primitive with the route and the codec payload, and decodes the items', async () => {
    const payloads = [
      { type: 'session/title', sessionId: 's1', title: 'one' },
      { type: 'session/log', sessionId: 's1', entry: { n: 1 } },
    ]
    const transport = fakeTransport({
      onStream: (stream) => {
        for (const payload of payloads) stream.frames.push(frameRemoteItem(payload))
        stream.closed = true
      },
    })
    installDesktopCarrier(transport, evaluation)
    const hooks = (globalThis as unknown as {
      __DSH_TRANSPORT__: { openStream: (endpoint: string, payload: unknown, signal: AbortSignal) => AsyncIterable<unknown> }
    }).__DSH_TRANSPORT__
    const items: unknown[] = []
    const controller = new AbortController()
    for await (const item of hooks.openStream('events.mux', { args: {} }, controller.signal)) {
      items.push(item)
    }
    expect(items).toEqual(payloads)
    expect(transport.streams).toHaveLength(1)
    expect(transport.calls).toHaveLength(0)
    expect(transport.openSignals).toEqual([controller.signal])
    // The route is the codec's endpoint→route map; the initial body is the
    // codec's JSON payload.
    expect(transport.streams[0]?.url).toBe(endpointRoute('events.mux'))
    expect(new TextDecoder().decode(transport.streams[0]?.data ?? new Uint8Array())).toBe(JSON.stringify({ args: {} }))
  })

  it('reassembles an item that spans several wire frames', async () => {
    const payload = { type: 'session/log', sessionId: 's1', entry: 'y'.repeat(100 * 1024) }
    const framed = frameRemoteItem(payload)
    const transport = fakeTransport({
      onStream: (stream) => {
        // Split the framed item across three wire frames.
        stream.frames.push(framed.subarray(0, 20_000), framed.subarray(20_000, 50_000), framed.subarray(50_000))
        stream.closed = true
      },
    })
    installDesktopCarrier(transport, evaluation)
    const hooks = (globalThis as unknown as {
      __DSH_TRANSPORT__: { openStream: (endpoint: string, payload: unknown, signal: AbortSignal) => AsyncIterable<unknown> }
    }).__DSH_TRANSPORT__
    const items: unknown[] = []
    for await (const item of hooks.openStream('events.mux', { args: {} }, new AbortController().signal)) {
      items.push(item)
    }
    expect(items).toEqual([payload])
  })
})

describe('loadClientBundle', () => {
  let evaluation: { evaluateScript: (source: string) => Promise<void> }

  beforeEach(() => {
    evaluation = { evaluateScript: vi.fn(async () => undefined) }
  })

  it('fetches the page-relative url against the origin and executes the bytes', async () => {
    const transport = fakeTransport({
      fetch: async () => new Response('console.log(1)', { status: 200 }),
    })
    await loadClientBundle(transport, '/plugins/@deepseek-ai/dsh-client-modules/client.js', evaluation)
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.url).toBe(new URL('/plugins/@deepseek-ai/dsh-client-modules/client.js', location.origin).href)
    expect(evaluation.evaluateScript).toHaveBeenCalledTimes(1)
    expect(evaluation.evaluateScript).toHaveBeenCalledWith('console.log(1)')
  })

  it('rejects with the carrier status for a failed bundle fetch', async () => {
    const transport = fakeTransport({
      fetch: async () => new Response('not found', { status: 404 }),
    })
    await expect(loadClientBundle(transport, '/plugins/@deepseek-ai/dsh-nope/client.js', evaluation))
      .rejects.toThrow('HTTP 404')
    expect(evaluation.evaluateScript).not.toHaveBeenCalled()
  })
})

describe('evaluateClassicScript', () => {
  const objectUrls: string[] = []
  let createSpy: { mockRestore: () => void }
  let revokeSpy: { mockRestore: () => void }

  beforeEach(() => {
    createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:mock/${String(objectUrls.length)}`
      objectUrls.push(url)
      return url
    })
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  afterEach(() => {
    createSpy.mockRestore()
    revokeSpy.mockRestore()
    document.head.replaceChildren()
    objectUrls.length = 0
  })

  /** Append a script and settle it by dispatching the given event. */
  async function runAndSettle(event: 'load' | 'error'): Promise<{ promise: Promise<void>; url?: string }> {
    const promise = evaluateClassicScript('body.evalSource = 42')
    // Mark the rejection observed before the test attaches its handler.
    promise.catch(() => undefined)
    // The script is appended synchronously inside the promise executor.
    const script = document.head.querySelector('script')
    script?.dispatchEvent(new Event(event))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const url = script?.getAttribute('src') ?? undefined
    return { promise, ...(url === undefined ? {} : { url }) }
  }

  it('executes through a blob object url and cleans up on load', async () => {
    const { promise, url } = await runAndSettle('load')
    await expect(promise).resolves.toBeUndefined()
    expect(url).toEqual(expect.stringMatching(/^blob:mock\//))
    expect(revokeSpy).toHaveBeenCalledWith(url)
    expect(document.head.querySelector('script')).toBeNull()
  })

  it('rejects and cleans up on a script error', async () => {
    const { promise, url } = await runAndSettle('error')
    await expect(promise).rejects.toThrow('client script failed to execute')
    expect(revokeSpy).toHaveBeenCalledWith(url)
    expect(document.head.querySelector('script')).toBeNull()
  })
})
