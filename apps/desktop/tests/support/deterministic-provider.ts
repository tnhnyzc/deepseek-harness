/**
 * The deterministic scripted LLM provider the desktop integration and
 * end-to-end suites drive the REAL pinned DSH against.
 *
 * This is the single shared implementation of the source-backed provider
 * technique established in Stage 6 / Stage 8. It is a loopback HTTP server on
 * an ephemeral port (bound to 127.0.0.1 only) that the pinned DeepSeek
 * provider reaches through its `DEEPSEEK_BASE_URL` keyless seam — the same
 * seam the web lane's real-host e2e uses. DSH itself stays real; only the
 * model endpoint is scripted, so a broken provider contract, a broken agent
 * loop, or a broken stream carrier all surface exactly as they would against
 * a live model.
 *
 * Scripting vocabulary (per turn, keyed by a marker the test puts in the
 * prompt text; the step is selected by how many tool results follow the
 * marker in the request):
 *
 *   - `text`      paced content deltas, then a stop (a normal streamed turn)
 *   - `tool`      a single tool call (bash, ask_user_question, ...)
 *   - `text-tool` content deltas then a tool call in ONE model response
 *                 (the only way the agent loop interleaves them)
 *
 * The automatic session-title call (the provider recognises it by
 * `max_tokens === 64`) is answered with a neutral title so it never consumes
 * a scripted step. Any request outside the script finishes with a short text
 * so a stray or replanned request cannot hang the suite.
 *
 * Provider-failure injection (a scripted HTTP error or an early close) is
 * supported by the `fail` step kind, which the agent loop must treat as a
 * turn failure, not a hang.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One scripted provider step. */
export type TurnStep =
  | { kind: 'text'; chunks: [text: string, delayMs: number][]; finish: boolean }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'text-tool'; chunks: [text: string, delayMs: number][]; tool: { name: string; args: Record<string, unknown> } }
  | { kind: 'fail'; status?: number; closeEarly?: boolean }

/** Per-turn scripts keyed by the marker the test puts in the prompt text. */
export type TurnScript = Record<string, TurnStep[]>

/** A running deterministic provider. */
export interface ScriptedProvider {
  /** The loopback base URL to point `DEEPSEEK_BASE_URL` at. */
  url: string
  /** The bound port (for diagnostics / listener scans). */
  port: number
  close(): Promise<void>
}

function sse(data: string): string {
  return `data: ${data}\n\n`
}

function sseStop(): string {
  return sse('{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}') + sse('[DONE]')
}

/** The last user-text marker and how many tool results follow it (the step). */
export function routeTurn(turns: TurnScript, body: string): { marker: string | undefined; step: number } {
  let messages: unknown
  try {
    messages = (JSON.parse(body) as { messages?: unknown }).messages
  } catch {
    return { marker: undefined, step: 0 }
  }
  if (!Array.isArray(messages)) return { marker: undefined, step: 0 }
  let marker: string | undefined
  let markerIndex = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as { role?: unknown; content?: unknown }
    if (message?.role !== 'user') continue
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? (message.content as { type?: unknown; text?: unknown }[]).map(item => typeof item?.text === 'string' ? item.text : '').join(' ')
        : ''
    for (const key of Object.keys(turns)) {
      if (text.includes(key)) {
        marker = key
        markerIndex = index
      }
    }
  }
  if (marker === undefined) return { marker: undefined, step: 0 }
  let step = 0
  for (let index = markerIndex + 1; index < messages.length; index += 1) {
    if ((messages[index] as { role?: unknown })?.role === 'tool') step += 1
  }
  return { marker, step }
}

/**
 * Create and start a deterministic provider.
 * @param turns - the per-turn scripts keyed by prompt marker.
 * @param titleText - the neutral title returned for the auto-title call.
 * @returns the running provider (loopback, ephemeral port).
 */
export async function createScriptedProvider(turns: TurnScript, titleText: string): Promise<ScriptedProvider> {
  let toolCallCounter = 0
  const sseToolCall = (name: string, args: Record<string, unknown>): string => {
    toolCallCounter += 1
    return sse(JSON.stringify({
      choices: [{
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, id: `call_scripted_${String(toolCallCounter)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      }],
    }))
      + sse('{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}')
      + sse('[DONE]')
  }

  const serveTurn = async (response: ServerResponse, parsed: { max_tokens?: unknown }, body: string): Promise<void> => {
    if (parsed.max_tokens === 64) {
      response.end(sse(`{"choices":[{"delta":{"content":"${titleText}"}}]}`) + sseStop())
      return
    }
    const { marker, step } = routeTurn(turns, body)
    const current = marker !== undefined ? turns[marker]?.[step] : undefined
    if (current === undefined) {
      // Outside the script (stray or replanned request): finish with text.
      response.end(sse('{"choices":[{"delta":{"content":"scripted idle"}}]}') + sseStop())
      return
    }
    if (current.kind === 'fail') {
      if (current.closeEarly === true) {
        response.destroy()
        return
      }
      response.writeHead(current.status ?? 500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'scripted provider failure', code: String(current.status ?? 500) } }))
      return
    }
    if (current.kind === 'tool') {
      response.end(sseToolCall(current.name, current.args))
      return
    }
    if (current.kind === 'text-tool') {
      for (const [text, delayMs] of current.chunks) {
        if (response.destroyed) return
        await new Promise((resolveWait) => { setTimeout(resolveWait, delayMs) })
        if (response.destroyed) return
        response.write(sse(`{"choices":[{"delta":{"content":"${text}"}}]}`))
      }
      if (!response.destroyed) response.end(sseToolCall(current.tool.name, current.tool.args))
      return
    }
    for (const [text, delayMs] of current.chunks) {
      if (response.destroyed) return
      await new Promise((resolveWait) => { setTimeout(resolveWait, delayMs) })
      if (response.destroyed) return
      response.write(sse(`{"choices":[{"delta":{"content":"${text}"}}]}`))
    }
    if (current.finish && !response.destroyed) response.end(sseStop())
  }

  const handleProviderRequest = (request: IncomingMessage, response: ServerResponse): void => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let parsed: { max_tokens?: unknown } = {}
      try { parsed = JSON.parse(body) as { max_tokens?: unknown } } catch { /* non-JSON probes get the title stream */ }
      void serveTurn(response, parsed, body).catch(() => {
        // A destroyed socket during pacing is the expected cancel outcome.
        if (!response.destroyed) {
          try { response.end() } catch { /* already destroyed */ }
        }
      })
    })
  }

  const server: Server = createServer(handleProviderRequest)
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: () => new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) }),
  }
}
