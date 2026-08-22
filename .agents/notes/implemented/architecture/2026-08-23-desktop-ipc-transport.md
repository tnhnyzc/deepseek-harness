# Agent Note: desktop stage 3 — IPC transport (fetch + stream)

Status: implemented

English | [中文](2026-08-23-desktop-ipc-transport.zh.md)

## Problem

Stage 3 (SPEC #8–#11) must add the IPC transport layer between the renderer and the standalone runtime: primitive A, a fetch-compatible request/response carrier; primitive B, an opaque ordered bidirectional stream carrier; and a dumb broker in Electron main that may inspect only transport metadata (routing, lifecycle, size limits, cancellation, diagnostics) and never decodes business payloads. Streaming must be indefinitely long with bounded buffering — SPEC #10 names "pause/resume or credit signaling if required" — and no upstream source edits are allowed. Two hostile serialization edges sit between the two ends of every channel: the Electron IPC between main and the renderer, and the fork IPC between main and the runtime child.

## Decision

The protocol lives in the runtime package, `apps/desktop-runtime/src/transport.ts`, exported through a `./transport` subpath so the runtime and the desktop app share one parser: sixteen wire message types (the SPEC #9 set plus `fetch.response.credit` and `stream.credit`), the size constants (64 KiB maximum frame, 256 KiB credit window, 32 MiB maximum request), a strict wire-boundary parser that throws `TransportProtocolError` on malformed frames, `TransportSendWindow` for per-direction credit accounting, `isTransportMessage` as the channel demux discriminant, and a structural `TransportPort` surface both Node ports satisfy.

Backpressure is credit signaling, which SPEC #10 explicitly permits: each direction may hold 256 KiB in flight, and the consumer returns credit as it consumes — a response chunk when it enters the `ReadableStream` queue, a stream frame when the consumer dequeues it — so an abandoned consumer stalls the runtime within one window instead of buffering unbounded. The broker's size guard inspects only the `data` byte length of data-bearing frames and synthesizes a `frame-too-large` error back to the originator instead of relaying a frame the receiving edge would drop.

The main↔runtime edge cannot transfer a `MessagePort`: Node `child_process` has no port transfer at all (empirically: `child.postMessage` does not exist, `child.send(null, [port])` throws "This handle type cannot be sent", and `child.send(port)` arrives as a plain object), so the broker relays the wire messages themselves over the existing structured-clone fork IPC, demultiplexed from the `runtime.*` control messages by the type discriminant. The same edge has a second fact: the child-IPC clone degrades `Uint8Array` (and even `Buffer`) to a plain object. The protocol module therefore owns an opaque wire codec — `toOpaqueTransportWire` / `fromOpaqueTransportWire`, a base64 marker around the `data` field — applied at both pipe ends (the supervisor's send/receive and the runtime's process adapter), so the broker guard, the runtime parser, and the renderer client ever see only raw bytes.

The runtime adapter, `attachTransportRuntime(port, api)`, serves primitive A through the real `toFetchHandler` seam (it routes by `url.pathname` only, so the client's dummy origin `http://dsh.local` is safe) and primitive B through a pinned downlink map that resolves the stream `url` the DSH client would name it — `/api/events.mux` to `api.events.mux`, `/api/events.host` to `api.events.host` — framing mux output as the host's exact `ServerRequest` envelopes. A `runtime.transport-closed` control message (or the process `disconnect`) ends the in-flight operations of the current channel generation but leaves the adapter armed for the next one; only the boot-time disposer kills it. The runtime entry attaches the transport after boot settles and fails loud when the `apiProxy` service is absent.

The dumb broker in Electron main owns per-generation channel pairs. Only Electron's `MessageChannelMain` ports can cross `webContents` IPC — Node `worker_threads` ports cannot, verified empirically — and the renderer half is delivered with `webContents.postMessage(channel, message, [port])`, the explicit transfer-list form, because `webContents.send` does not transfer ports. The broker relays transparently in both directions, denies an open while the runtime is not ready, ends the runtime channel when the renderer port closes, and closes the renderer port when the runtime goes away.

The renderer half of the port cannot cross `contextBridge` at all: a live `MessagePort` resolves in the page as an inert object, and even a bridged event's `data` would be lost because `MessageEvent.data` is a prototype accessor the bridge clone drops. The preload therefore keeps the real port in its isolated world and exposes its surface as plain functions; message events cross as plain `{ data }` objects with own properties. `openTransport()` resolves that surface and rejects on the denial channel or a 10 s timeout.

The renderer client, `createDesktopTransport(port)` in `apps/desktop/src/renderer/transport.ts`, exposes primitive A as a `fetch`-compatible function that constructs a real browser `Response` whose body is a `ReadableStream` (`duplex: 'half'` whenever the request carries a stream body; 204/205/304 responses carry a null body, which the transport maps from its empty-stream form; abort posts `fetch.abort` and rejects with `AbortError`), and primitive B as `openStream(url)` resolving to `DesktopStream { id, outcome, frames(), send, close }` with credit returned per dequeued frame and an uplink frame bound that throws locally. A closed port settles every pending operation with the `transport-closed` error.

Build plumbing: `apps/desktop` takes a workspace dev-dependency on `@deepseek-ai/dsh-desktop-runtime` (the broker imports the protocol subpath, and the main build bundles the runtime first because the repo root build does not cover the desktop package); `apps/desktop-runtime/tsconfig.json` gains the project reference to `packages/host/apiproxy` so the adapter types the `ApiProxy` seam; the root `tsconfig.base.json` gains the one paths entry for the protocol subpath.

## Consequences

- New workspace edge and entry point: `apps/desktop` → `@deepseek-ai/dsh-desktop-runtime`, the `./transport` exports subpath, and the explicit build ordering in the desktop build script; `knip.json` drops the now-redundant runtime `src/index.ts` entry (knip infers it from the package exports).
- The child-IPC relay is the only non-`MessagePort` edge in the system; the opaque codec is confined to the two pipe ends and never appears in the broker, the renderer client, or any test beyond the boot suite.
- D2 (contract "unknown" list) is resolved: credit signaling is designed and tested, including a 600 KiB response body stalling on the window and resuming on returned credit, and per-frame credit on the stream carrier.
- The pinned downlink map couples the desktop to the client's stream naming at this SHA; a new DSH stream endpoint is a one-line map entry, and the transport itself stays stream-agnostic per SPEC #9.
- The runtime control protocol gains `runtime.transport-closed`, a channel-generation signal distinct from process death; the supervisor's force-kill path is unchanged.
- Stage 4 now consumes `window.dshDesktop.openTransport()` for the renderer's `__DSH_TRANSPORT__` integration (contract §3.5, C3); the client-facing `AbstractApiClient` subclass is the remaining stage 4 work.

## Alternatives considered

- Transfer a `MessagePort` over fork IPC — impossible: Node `child_process` supports no port transfer (the three probes above; the documented transferable set is net handles only).
- Run the runtime in an Electron `utilityProcess` — rejected: the stage 2 supervisor already owns the pinned-Node fork with full `DSH_HOME`/environment control, and `utilityProcess` would add an ABI and isolation surface for no transport benefit.
- Let the renderer create the channel and send its port to main — considered while the main→renderer delivery failed; the main-owned `MessageChannelMain` pair with the explicit transfer list works, and keeping channel-generation ownership in the broker preserves the deny/replace/teardown semantics in one place.
- A hand-rolled JSON-RPC over the single fork IPC channel — rejected: no ordered per-stream framing or per-stream credit, and it would push business semantics into main, which SPEC #11 forbids.
- A larger window or no credit — rejected by SPEC #10: "do not permit an unbounded array of token chunks in Electron main".
