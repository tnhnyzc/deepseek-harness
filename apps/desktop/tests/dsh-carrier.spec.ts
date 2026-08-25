// @vitest-environment jsdom
/**
 * Unit coverage for the DSH desktop carrier: the `__DSH_TRANSPORT__` seam
 * shape, the event-path vs fetch routing inside the carrier's API client,
 * and the bundle loader (fetch over the fetch primitive, execution through
 * the documented classic-script seam). A scripted fake transport stands in
 * for the stage 3 port; nothing here decodes an envelope beyond what the
 * pinned client's own schemas require.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  frames: string[]
  closed: boolean
}

/** The transport input is a url string or a Request; both carry an href. */
function urlText(url: string | Request): string {
  return url instanceof Request ? url.url : url
}

/** The fake always sends a JSON string body; refuse anything else loudly. */
function requestBody(call: FetchCall): Record<string, unknown> {
  const body = call.init?.body
  if (typeof body !== 'string') {
    throw new Error(`fake transport: expected a string body, got ${typeof body}`)
  }
  return JSON.parse(body) as Record<string, unknown>
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
    async openStream(_url, signal) {
      if (signal !== undefined) openSignals.push(signal)
      const stream: ScriptedStream = { frames: [], closed: false }
      streams.push(stream)
      behavior?.onStream?.(stream)
      const handle: DesktopStream = {
        id: `fake-${String(streams.length)}`,
        outcome: new Promise<void>(() => { /* never settles in the fake */ }),
        async* frames() {
          for (const frame of stream.frames) yield new TextEncoder().encode(frame)
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

  it('installs the pinned seam shape on the page global', () => {
    const transport = fakeTransport()
    installDesktopCarrier(transport, evaluation)
    const hooks = (globalThis as unknown as {
      __DSH_TRANSPORT__: {
        createApiClient: () => unknown
        fetch: (input: URL, init: RequestInit) => Promise<Response>
        loadBundle?: (url: string) => Promise<void>
      }
    }).__DSH_TRANSPORT__
    expect(typeof hooks.createApiClient).toBe('function')
    expect(typeof hooks.fetch).toBe('function')
    expect(typeof hooks.loadBundle).toBe('function')
    // The API client is one instance for the page's whole lifetime.
    expect(hooks.createApiClient()).toBe(hooks.createApiClient())
  })

  it('routes the generic RPC fetch through the fetch primitive', async () => {
    const transport = fakeTransport({
      fetch: async (call) => {
        const body = requestBody(call) as { rpcId: string }
        return envelopeResponse(body.rpcId, {})
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

describe('DesktopApiClient routing (through the seam client)', () => {
  let evaluation: { evaluateScript: (source: string) => Promise<void> }

  beforeEach(() => {
    evaluation = { evaluateScript: vi.fn(async () => undefined) }
  })

  afterEach(() => {
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
  })

  it('sends a unary call over the fetch primitive and parses the pinned envelope', async () => {
    const transport = fakeTransport({
      fetch: async (call) => {
        const body = requestBody(call) as { rpcId: string }
        return envelopeResponse(body.rpcId, { items: [] })
      },
    })
    installDesktopCarrier(transport, evaluation)
    const hooks = (globalThis as unknown as {
      __DSH_TRANSPORT__: {
        createApiClient: () => {
          sessions: { list: (payload: object, signal?: AbortSignal) => Promise<{ result: { ok: boolean; value: { items: unknown[] } } }> }
        }
      }
    }).__DSH_TRANSPORT__
    const response = await hooks.createApiClient().sessions.list({}, new AbortController().signal)
    expect(response.result.ok).toBe(true)
    expect(transport.calls).toHaveLength(1)
    // The pinned client resolves the method path against location.origin,
    // not a fixed hostname; the transport carries whatever origin the page has.
    expect(transport.calls[0]?.url).toBe(new URL('/api/session.list', location.origin).href)
    const sent = requestBody(transport.calls[0] ?? { url: '' }) as { type: string; method: string }
    expect(sent.type).toBe('client-request')
    expect(sent.method).toBe('session.list')
    expect(transport.streams).toHaveLength(0)
  })

  it('opens the mux event path on the stream primitive, not the fetch primitive', async () => {
    const transport = fakeTransport({
      onStream: (stream) => {
        // A malformed frame: the pinned reader drops it with a log and
        // keeps reading, so the drop is the proof the bytes reached it.
        stream.frames.push('data: not-a-real-mux-frame\n\n')
        stream.closed = true
      },
    })
    const dropLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    installDesktopCarrier(transport, evaluation)
    const hooks = (globalThis as unknown as {
      __DSH_TRANSPORT__: {
        createApiClient: () => { events: { mux: (payload: object, signal: AbortSignal, onOpen?: () => void) => AsyncIterable<unknown> } }
      }
    }).__DSH_TRANSPORT__
    const onOpen = vi.fn()
    const frameCount = { value: 0 }
    const muxController = new AbortController()
    for await (const _frame of hooks.createApiClient().events.mux({}, muxController.signal, onOpen)) {
      frameCount.value += 1
    }
    // The opener resolved (onOpen fired), no fetch-primitive traffic ran,
    // and the frame flowed into the pinned SSE reader (dropped, logged).
    // Restore only after asserting: mockRestore clears the call history.
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(transport.streams).toHaveLength(1)
    expect(transport.calls).toHaveLength(0)
    // The caller's signal rides the open itself, so the transport owns the
    // cancellation for the stream's whole lifetime, pending open included.
    expect(transport.openSignals).toEqual([muxController.signal])
    expect(frameCount.value).toBe(0)
    expect(dropLog).toHaveBeenCalledWith(expect.stringContaining('/api/events.mux'), expect.anything())
    dropLog.mockRestore()
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
