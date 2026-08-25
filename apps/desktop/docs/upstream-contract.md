# Upstream contract (desktop)

Source-level contract of DeepSeek Harness at the pinned SHA, for the
desktop application defined in the root `ARCHITECTURE.md` and `SPEC.md`.

- Pinned SHA: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Tag: `dsh-v0.1.1-rc.2`
- Pinned: 2026-08-22
- Behavior baseline: see `UPSTREAM.md` (stage 0 task 0.2 record)

Every claim below was verified against source at the pinned SHA. Citations
are `path:line` with symbol names; line numbers are from the pinned tree.
Historical notes (`.agents/notes/`, `docs/`) are flagged where they
disagree with current source; current source wins.

Each item ends with a consumption tag:

```text
DESKTOP-CONSUMPTION: consume unchanged | minimal generic extension
(name the narrowest boundary) | desktop-only | unknown+reason
```

---

## 1. Programmatic Harness boot

### 1.1 Composition entry point

`dsh web` has no host-side entry class. The CLI dispatches profiles:
`apps/cli/src/bin.ts:30-37` imports and runs `runProfile`
(`apps/cli/src/profile-boot.ts:207`); `web` is a commander alias for
`--profile web` (`apps/cli/src/args.ts:156, 166-169`).

The web profile is the bundle pair
`['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`
(`packages/boot/app-boot/src/profile.ts:114-117`). The profile dir is
`$DSH_HOME/profiles/web`, auto-initialized from the template
(`packages/boot/app-boot/src/profile.ts:104-111, 371-403`), and the whole
app is a patch stack applied in order (`apps/cli/src/profile-boot.ts:122-129`):

1. `packages/bundle/base/cordis.patch.yml`
2. `packages/bundle/web-app/cordis.patch.yml`
3. profile user layer `$DSH_HOME/profiles/web/cordis.patch.yml`
4. home user layer `$DSH_HOME/cordis.patch.yml`
5. `--patch` overlays, then the telemetry patch

The programmatic composition entry is `boot()` from
`@deepseek-ai/dsh-app-boot`:

```ts
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context>
```

(`packages/boot/app-boot/src/index.ts:757-763`). Body: `new Context()`,
`ctx.provide('dshHomePath', dshHomePath)`, `ctx.plugin(Loader)`,
`prepare?.(ctx)`, `mountRootInclude(...)`, `await ctx.get('loader')?.await()`,
`assertEntriesActivated(...)` (`packages/boot/app-boot/src/index.ts:764-784`).
The public pieces `runProfile` reassembles from: `healProfilesModuleFallback`,
`loadProfile`, `loadOptionalPatches`, `loadOverlayPatches`, `composeEntries`,
`boot` (exports at `packages/boot/app-boot/src/index.ts:31-50`).

Name clarification (historical mismatch): `AppWebEntry`
(`packages/client/web/src/boot.ts:22`) is the browser-side boot kernel
consumed by `apps/web`; it is not what `dsh web` runs on the host.

DESKTOP-CONSUMPTION: consume unchanged — `boot()` + the exported profile
pieces are the programmatic entry; `runProfile`'s process glue (signals,
fail-loud, HMR watchers, `apps/cli/src/profile-boot.ts:216-225`) is
optional and replaceable by the desktop supervisor.

### 1.2 Composition vs HTTP serving (the separating symbols)

The API gateway is an ordinary Cordis service row with no HTTP: the
`api-gateway` row (`packages/bundle/web-app/cordis.patch.yml:105-106`)
mounts `@deepseek-ai/dsh-host-apiproxy` → `ApiProxyService`, which provides
`ctx.apiProxy` (`packages/host/apiproxy/src/index.ts:33-38, 69-126`).

HTTP serving is a separate row: `webserver`
(`packages/bundle/web-app/cordis.patch.yml:121-126`) mounting
`@deepseek-ai/dsh-host-webserver`; `WebServer` listens inside `Service.init`
(`packages/host/webserver/src/index.ts:231-239`). The rows that cannot
activate without it, verified stage 2:

- `web-runtime` (`cordis.patch.yml:137-144`, `inject: [webStartup]`):
  serves the dist, prints the URL line, provides `webRuntime`.
- `connection` (`cordis.patch.yml:164-171`, `inject: [webRuntime]`):
  binds the `/api` routes and the WebSocket downlinks.
- `modules` (`cordis.patch.yml:159-160`): `@deepseek-ai/dsh-client-modules`
  declares `static inject = ['webServer', 'loader']`
  (`packages/client/modules/src/index.ts:283`) and serves
  `/plugins/<id>/client.js` off it (`:340`).
- `client-hmr` (`cordis.patch.yml:150-151`): `@deepseek-ai/dsh-client-hmr`
  declares `inject = ['clientModules', 'webServer']`
  (`packages/client/hmr/src/index.ts:28`) and registers its reload route
  on the web server (`:166`).

An HTTP-free desktop host boots the same composition with a patch overlay
disabling those five rows (the `disabled: true` patch mechanism the
bundles themselves use, `packages/bundle/web-app/cordis.patch.yml:22-23`)
and re-targets the directory picker: the `directory-picker` row
(`cordis.patch.yml:96-97`) mounts the `auto` variant, which resolves the
web bind host (`inject = ['webServer', 'loader']`,
`packages/host/directory-picker-auto/src/index.ts:29`). The overlay
disables that row and inserts
`@deepseek-ai/dsh-host-directory-picker-native` — the same "mount -native
in an overlay" treatment the web composition documents for deployments
pinning the picker. The API gateway's `directoryPicker` hard requirement
(`packages/host/apiproxy/src/index.ts:71`) then resolves without a web
server. A `PatchOptions` row `name` is a verification guard, not a
re-target, so the picker swap is a disable plus insert, not a name
override. `api-gateway` composes standalone otherwise: its remaining hard
requirements are `ApiProxyService`'s inject list
(`packages/host/apiproxy/src/index.ts:70-73`), none of which involve
`webServer`.

DESKTOP-CONSUMPTION: consume unchanged — row disabling plus a disable/insert
re-target via a `--patch`-style overlay is the existing seam; no upstream
edit.

### 1.3 Readiness / settled semantics

Settled = `boot()`'s return: "the root context once every entry has
started" (`packages/boot/app-boot/src/index.ts:751-752`). Mechanically:

- `await ctx.get('loader')?.await()` (`packages/boot/app-boot/src/index.ts:782`)
  → `EntryTree.await()` (`vendor/loader/src/config/tree.ts:46-64`): loop
  until pending import/lifecycle tasks are empty, settle every entry's
  fiber; a settled fiber failure is rethrown (`:56-60`).
- `assertEntriesActivated(ctx, binName)`
  (`packages/boot/app-boot/src/index.ts:692-725`): every enabled entry must
  be `FiberState.ACTIVE` (`vendor/cordis/src/fiber.ts:147-154`); `FAILED`
  fibers are awaited to recover the original rejection; `PENDING` entries
  are reported with their missing services.

There is no separate "ready" event or promise. Awaitable symbols:
`boot()`'s returned `Promise<Context>`, `ctx.get('loader').await()`,
`fiber.await()`. The web surface's own readiness gate is "announce only
after Loader settlement" (`packages/bundle/web-app/src/index.ts:278-289`).

DESKTOP-CONSUMPTION: consume unchanged — await `boot()` as the settled
signal; the desktop `runtime.ready` is emitted after it resolves.

### 1.4 Environment and configuration

- `DSH_HOME`: `packages/util/home-paths/src/index.ts:18`
  (`DSH_HOME_ENV = 'DSH_HOME'`), default `~/.dsh` (`:12, 61-63`), precedence
  explicit config > `$DSH_HOME` > `~/.dsh` (`:87-91`).
- Settings document: `$DSH_HOME/settings.yaml`
  (`packages/settings/settings-file/src/index.ts:55-67`).
- `DSH_TELEMETRY_DISABLED` — any non-empty value disables the telemetry
  row (`apps/cli/src/profile-boot.ts:57, 80-83, 168`).
- `DSH_TOOLS_MODE` — read by the web bundle's `tools` row
  (`packages/bundle/web-app/cordis.patch.yml:41`).
- `DSH_SNAPSHOT` — `'replay'` swaps the config basename to
  `cordis.snapshot.yml` (`packages/boot/app-boot/src/index.ts:56-69`).
- `.env` layering: cwd `.env` then `$DSH_HOME/.env` without overriding
  inherited values (`packages/boot/app-boot/src/index.ts:177-198`); names
  with the `DSH_` prefix may not be set from a discovered `.env`
  (`BOOTSTRAP_PREFIXES` at `:117`, enforced `:155-162`). Model credentials
  (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`) come via ambient environment or
  `.env` (root `AGENTS.md`, "Secrets / .env").

Note: `DSH_DESKTOP` does not exist in upstream at this SHA; it is a
desktop-runtime convention from the SPEC, not an upstream contract item.

DESKTOP-CONSUMPTION: consume unchanged — the desktop supervisor supplies
`DSH_HOME` (an app-owned dir) and ambient credentials to the child.

### 1.5 Shutdown / disposal

- Whole-tree disposal = `ctx.fiber.dispose()`
  (`vendor/cordis/src/fiber.ts:196`); cleanup failures are contained per
  observer; repeated calls return the settled single-shot result.
- CLI termination wiring: `createProcessShutdown`
  (`apps/cli/src/process-shutdown.ts:22-77`), grace
  `PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000` (`:4`); `SIGTERM`/`SIGINT` handlers
  (`apps/cli/src/profile-boot.ts:221-222`); `installFailLoud`
  (`apps/cli/src/profile-boot.ts:223-225`,
  `packages/boot/app-boot/src/index.ts:609-649`).
- HTTP server close is a fiber effect of `WebServer`
  (`packages/host/webserver/src/index.ts:243-253`): `server.close` +
  `closeAllConnections` + destroy of tracked upgraded sockets, all awaited.
  Disposal is the only close path.

A desktop supervisor can await `ctx.fiber.dispose()`'s promise (the
quiescence signal) in the child, and/or SIGTERM + process-exit when
spawning a bin.

DESKTOP-CONSUMPTION: consume unchanged — `ctx.fiber.dispose()` is the
awaited disposal primitive; the runtime child mirrors the CLI's
`createProcessShutdown` grace pattern (its own copy, since the bin glue is
not an importable module), and the Electron supervisor adds the parent-side
grace period plus forced process-group kill.

---

## 2. Host communication plane (apiproxy)

Package: `packages/host/apiproxy` = `@deepseek-ai/dsh-host-apiproxy`.
"Transport-agnostic by design: this package registers no routes"
(`packages/host/apiproxy/src/index.ts:2-8`).

### 2.1 Contract surface

- Root contract `ApiProxy`: domain groups `sessions, subagents, host,
  workspace, skills, agentPresets, events, goals, settings, credentials,
  llm, downloads` plus `respond(message: ClientResponse): Promise<RpcReceipt>`
  (`packages/host/apiproxy/src/api/index.ts:22-42`).
- Implementation is a closure factory: `createApiProxy(ctx: Context,
  defaults: ApiProxyDefaults): ApiProxy`
  (`packages/host/apiproxy/src/api-proxy.ts:1047`); defaults
  (`:577-611`) require `defaultModelSelection` (re-read per access) and
  `cwd`, optional `openPath` / `openTextFile` / `canOpenPath` /
  `sessionExportCompressionLevel` / `coldBlankProbeMaxBytes`.
- Gateway plugin `ApiProxyService` (`packages/host/apiproxy/src/index.ts:69`),
  `static inject = ['agentDefaultModel', 'agents', 'attachments',
  'directoryPicker', 'llm', 'sessions', 'subagents', 'sessionQuery',
  'tools', 'userQuestions', 'workspaceRegistry']` (`:70-73`), provided as
  `ctx.apiProxy` (`:33-38`). Optional services are read via `ctx.get` and
  degrade their domain when absent (`agentPresets`, `settings`,
  `credentials`, `skills`, `approval`, `sessionPersistence`, ...).

DESKTOP-CONSUMPTION: consume unchanged.

### 2.2 The fetch carrier pair (in-process seam)

`toFetchHandler` — the in-process seam:

```ts
export function toFetchHandler(api: ApiProxy): { fetch: typeof fetch }
```

(`packages/host/apiproxy/src/fetch/handler.ts:243-247`). Takes the
`ApiProxy` contract object (e.g. `ctx.apiProxy`), returns an object whose
`fetch` matches global fetch's `(RequestInfo | URL, RequestInit?) =>
Promise<Response>`, normalizing both call forms to a `Request`
(`:248-249`). The documented isomorphic point:
"an in-process subclass whose `doFetch` is `toFetchHandler(api).fetch`
never touches the network" (`packages/host/apiproxy/src/fetch/client.ts:241-242,
515-518`). Current production consumers: `InProcessApiClient`
(`packages/host/apiproxy/src/fetch/client.ts:520-541`) and the web
carrier's fallback (`packages/client/connection/src/index.ts:156-158`).

Client side: `AbstractApiClient`
(`packages/host/apiproxy/src/fetch/client.ts:244`) with the transport
virtuals:

| Virtual | Signature | Location |
| --- | --- | --- |
| `doFetch` (abstract) | `(input: URL, init?: RequestInit) => Promise<Response>` | `fetch/client.ts:254` |
| `onEnvelope` | `(message: RpcMessage) => void` | `:271-290` |
| `callUnary` | `<K>(method, payload, signal?, timeoutPolicy?) => Promise<RpcResponse<...>>` | `:333-350` |
| `openMux` | `(payload, signal, onOpen?) => AsyncIterable<RpcRequest<MuxFrame>>` | `:353-355` |
| `openHost` | `(payload, signal, onOpen?) => AsyncIterable<RpcRequest<HostFrame>>` | `:358-360` |
| `readSse` | `(path, signal, frameSchema, onOpen?) => AsyncGenerator<RpcRequest<F>>` | `:369-408` |

The base `openMux`/`openHost` implementations are SSE over the fetch
carrier (`readSse`); `WebApiClient` overrides both with WebSockets.
Precedent subclasses: `InProcessApiClient` (injected `handler.fetch`),
`WebApiClient` (`packages/client/connection/src/client/web-api-client.ts:13`),
`FixtureApiClient` (`packages/client/connection/src/client/fixture.ts:3233`,
test carrier, also selectable via the `?fixture` query param,
`packages/client/connection/src/client/index.ts:111-114`).

Client consumption interface `IApiClient`
(`packages/host/apiproxy/src/fetch/client.ts:87-166`): payload-direct
domain methods, `events.mux/host(payload, signal, onOpen?)`, `respond`.

DESKTOP-CONSUMPTION: consume unchanged — the desktop runtime calls
`toFetchHandler(ctx.apiProxy).fetch` with reconstructed Requests; the
desktop renderer supplies one `AbstractApiClient` subclass (or an object
satisfying `IApiClient`) over the two IPC primitives.

### 2.3 Request/response path

Routing inside `toFetchHandler` (`packages/host/apiproxy/src/fetch/handler.ts`):

- `GET /api/events.mux` / `GET /api/events.host` → SSE responses
  (`:254-259`, `sseResponse` `:203-236`, frames `data: <ServerRequest JSON>`).
- `GET|HEAD /api/session.export?sessionId=...` → streamed ZIP
  (`:260-271`, `api-proxy.ts:3575-3590`).
- `/api` fence: non-POST or non-`/api/` → 404 (`:273-275`); non-JSON
  media type → 415 (`:283-286`); non-JSON body → 400 (`:288-294`).
- `POST /api/respond` → `api.respond` (`:296-300`).
- Otherwise the method table (`UNARY_ROUTES`, `:83-143`, compiler-locked to
  `RpcMethodMap`); unknown method → 404; the path must equal the envelope
  method (`:314-316`); `handleUnary` (`:178-192`) parses the payload with
  per-method zod schemas, invokes with the carrier `req.signal`, maps
  business errors to 200 + `ServerResponse` (`:164-167`) and crashes to 500
  (`:188-191`).

The browser-trust fences are NOT in `toFetchHandler`; they live in the HTTP
carrier (`@deepseek-ai/dsh-client-connection` node half):
`isTrustedApiRequest` (Host fence, DNS-rebinding defense,
`sec-fetch-site: cross-site` refusal, Origin==Host check,
`packages/client/connection/src/api-request-trust.ts:96-123`), applied to
the `/api` prefix route (`packages/client/connection/src/index.ts:161-173`);
privileged methods additionally pinned to loopback
(`PRIVILEGED_METHODS` at `packages/client/connection/src/index.ts:89-119`,
check at `:145-149`); buffered body cap 300 MiB
(`packages/client/connection/src/index.ts:60-67`). A desktop transport
calling `toFetchHandler` in-process bypasses both fences by construction.

Request constraints a desktop transport must honor: POST-only envelopes,
`/api/` prefix, `content-type: application/json`, path == envelope method;
response bodies include real streamed `Response`s (SSE, ZIP), so the
transport must forward bodies chunk-wise.

DESKTOP-CONSUMPTION: consume unchanged — the fence question is a policy
decision at the desktop's own boundary; the `toFetchHandler` contract is
transport-neutral.

### 2.4 Cancellation

- The Request's `AbortSignal` enters at the seam and is passed to `sseResponse`
  (`handler.ts:255, 258`), `downloads.sessionLog` (`:267`), and `handleUnary`
  (`:317`) → `route.invoke(api, {...}, signal)` (`:187`). Only routes whose
  contract declares a signal forward it (`handler.ts:80-82`); e.g.
  `session.prompt` is fire-and-forget with no signal (`:99`) — an active turn
  is cancelled later via `session.cancel` (`api-proxy.ts:2518`).
- Stream propagation: `FrameQueue.iterate(signal, cleanup)`
  (`api-proxy.ts:371-385`) — abort ends the queue, the generator returns,
  `finally` removes listeners and runs cleanup (mux `:3426-3429`, host
  `:3533`), which closes the stream (`handler.ts:226-230`).
- Unary propagation into host operations: `ctx.subagents.followup(..., {
  signal })` (`api-proxy.ts:2671-2679`), `capability.pick(signal)` / abort →
  `cancelled` (`:2852-2861`), `capability.list(path, signal)` (`:2880-2888`),
  `ctx.llm.discoverModels(..., { signal })` (`:3305-3311`), plus
  `signal?.throwIfAborted()` checkpoints throughout.
- Abort outcome: business error code `cancelled`
  (`packages/host/apiproxy/src/api/rpc.ts:34`); streams simply end (client
  gap detection covers lost frames, `fetch/client.ts:363-367`).
- Client side: bounded unary calls merge a 30 s `AbortSignal.timeout` with
  the caller signal via `AbortSignal.any` (`fetch/client.ts:228, 307-326`);
  `InProcessApiClient.doFetch` rejects on abort even against a hung handler
  (`:525-540`).

DESKTOP-CONSUMPTION: consume unchanged — propagate the desktop IPC
cancellation as the `AbortSignal` on the reconstructed `Request`.

### 2.5 Host context required

`createApiProxy` needs a Cordis `Context` with the host spine and workspace
registry mounted (`packages/host/apiproxy/src/api-proxy.ts:1041-1047`) plus
`ApiProxyDefaults`. Hard requirements come from `ApiProxyService.static
inject` (`packages/host/apiproxy/src/index.ts:70-73`); it is activated by
the Loader as the `api-gateway` row and consumed lazily per request.

DESKTOP-CONSUMPTION: consume unchanged — mounting the web-profile
composition (rows per 1.2) provides the full context.

---

## 3. Downlink / stream plane

### 3.1 The WebSocket downlinks at this SHA

Host-side carrier: `WebSocketDownlinks`
(`packages/client/connection/src/websocket-downlink.ts:51`) — flagged
mismatch: it lives in the *client* package's node half, owned by the
`client-connection` plugin, instantiated at
`packages/client/connection/src/index.ts:176` and disposed at `:192`. The
apiproxy package registers no routes; "physical carriers wrap
`ctx.apiProxy` themselves" (`packages/host/apiproxy/src/index.ts:7-8`).

- `handleMux(req, socket, head)` (`websocket-downlink.ts:64-69`): upgrades
  the socket and pumps `api.events.mux({ rpcId, payload: {} }, signal)`.
- `handleHost(req, socket, head)` (`:77-82`): same for `api.events.host`.
- `close()` (`:88-97`): terminates all owned sockets, closes the
  `WebSocketServer`, awaits the frame pumps.
- Untrusted upgrade → `HTTP/1.1 403 Forbidden` (`:144-153`).
- Upgrade routes registered at `packages/client/connection/src/index.ts:193-194`
  via `webServer.registerUpgrade` (`:181-190`).

Browser-side consumer: `WebApiClient`
(`packages/client/connection/src/client/web-api-client.ts:13`):
`openMux`/`openHost` (`:18-32`) delegate to `readWebSocket` (`:34-90`) —
lazy open (generator connects on first iteration; `IApiClient` JSDoc
`packages/host/apiproxy/src/fetch/client.ts:79-82`), `new WebSocket(url)`
(`:42`), `onOpen` on the socket `open` event (`:50, 69`), each `message`
parsed as `ServerRequest` envelope + frame schema (`:51-64`), `AbortSignal`
closes the socket (`:72`), socket close ends the generator (`:65, 83-89`).

Paths: `API_PATH = '/api'`, `MUX_EVENTS_PATH = '/api/events.mux'`,
`HOST_EVENTS_PATH = '/api/events.host'`
(`packages/client/connection/src/api-path.ts:8-14`); the browser rewrites
the page origin to `ws:`/`wss:` (`web-api-client.ts:40-42`).

The 426 fence: the `client-connection` plugin answers GET event paths with
426 `upgrade required` (`packages/client/connection/src/index.ts:150-155`),
suppressing the SSE fallback that `toFetchHandler` would otherwise serve
(`packages/host/apiproxy/src/fetch/handler.ts:254-259`).

DESKTOP-CONSUMPTION: consume unchanged for semantics; the physical
WebSocket half is replaced at the carrier boundary (3.5).

### 3.2 Direction: strictly server→client at this SHA

Downlinks are one-way. "Client messages are a protocol violation: upstream
traffic remains on HTTP" (`websocket-downlink.ts:46-50`); the host closes
on any client message: `websocket.close(1008, 'downlink only')`
(`websocket-downlink.ts:109-111`). The browser half contains no client
send code at all (full-file read of `web-api-client.ts`).

All client→server traffic is unary fetch:

- unary RPC: `POST /api/<method>` (`fetch/client.ts:307-326, 341`)
- interaction answers: `POST /api/respond` (`fetch/client.ts:508-512`)
- generic Typert channels: `POST /api/<channel>/<endpoint>`
  (`packages/client/connection/src/client/rpc.ts:23-53`)

SPEC/ARCHITECTURE framing check: the SPEC's stream primitive is specified
as bidirectional (the transport "carries either direction without
distinguishing them"). At this SHA DSH uses only the server→client
direction over the stream plane; the bidirectional capability is a strict
superset and is retained by design (a future DSH stream may use either
direction). This is a clarification, not a contradiction: the transport
still "moves Harness protocols; it does not define them".

DESKTOP-CONSUMPTION: consume unchanged — the stream carrier is used
server→client for the pinned SHA; the transport stays direction-agnostic.

### 3.3 Mux / host stream semantics and fan-out

`createApiProxy` owns the fan-out
(`packages/host/apiproxy/src/api-proxy.ts`):

- Connection registry: `muxQueues = new Set<FrameQueue<...>>()` (`:1073`);
  `FrameQueue` (`:354-386`) = push/end/iterate with abort.
- `events.mux` (`:3328-3430`): per-connection queue; on open it pushes a
  `session/subscribed { sessionId, lastSeq: session.seq - 1 }` baseline per
  attached session (`:3331-3333`, helper `:420-423`), then replays
  still-pending question/approval requested frames with their stable
  rpcIds (`:3334-3345`), queue and jobs baselines (`:3349-3367`). Live
  fan-in: `ctx.on('session/event')` pushes frames for all sessions
  (`:3373-3392`); `session/created` re-subscribes mid-stream
  (`:3393-3403`); `broadcast(payload)` pushes one envelope to every queue
  (`:1214-1218`); cleanup removes queue + disposers on end (`:3426-3429`).
- `events.host` (`:3432-3534`): host-level frames (`host/session-added`,
  `host/session-removed`, `host/session-status`, `host/agent-error`,
  workspace domain changes, allowlisted remote events).

There is no per-session subscribe call: one mux connection receives all
sessions; per-session routing is client-side by `sessionId`.

Frame vocabulary: `MuxFrame` (`api/events.ts:69-108`; wire schema
`api/events.schema.ts:43-67`) = `session/event`, `session/subscribed`,
`approval/requested|resolved`, `question/requested|resolved`,
`session/queue`, `session/jobs`, `session/projection`, `stream/error`.
`HostFrame` (`api/events.ts:127-155`; schema `:70-93`). On the WebSocket
each frame is serialized as `JSON.stringify(serverRequest(frame))`
(`websocket-downlink.ts:29`).

DESKTOP-CONSUMPTION: consume unchanged — the host process keeps this code
as-is; the desktop stream carrier carries the same JSON frames opaquely.

### 3.4 Reconnection strategy (no cursor in v1)

Documented contract: "reconnection = reopen the stream + refetch history";
`since` is a resume hook, unimplemented in v1 (ignored if passed)
(`packages/host/apiproxy/src/api/events.ts:48-56`).

Client pump owner: `ConnectionController`
(`packages/client/connection/src/client/connection.ts:61`): start/stop
(`:78-89`), per-generation `AbortController` loop (`:107-169`), pumps both
streams (`:128-129`), breaks on `stream/error` frames (`:185`),
exponential-backoff reconnect (`:91-95, 161-168`); the open handshake races
`onOpen` against `host.describe` with a 3 s timeout (`:12-16, 118-155`).

DESKTOP-CONSUMPTION: consume unchanged — a desktop stream that ends or
throws drives the existing reconnect loop; no new semantics.

### 3.5 The seam for the generic IPC stream carrier

An existing injection point exists; no new one is needed.

Page-global transport hook `ClientTransportHooks`
(`packages/client/connection/src/client/index.ts:62-76`):

```ts
export interface ClientTransportHooks {
  createApiClient(): IApiClient
  fetch: RpcFetch
  loadBundle?(url: string): Promise<void>
}
```

Read from `globalThis.__DSH_TRANSPORT__` before client boot: selection at
`packages/client/connection/src/client/index.ts:113-115`
(`fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()`;
`createWebConnectionRpc(transport?.fetch)` at `:115`). Documented purpose:
"a shell that owns a different physical transport ... provides both halves
here instead of forking this plugin" (`:56-61`). The module shell reads
`transport?.loadBundle` for bundle bytes
(`packages/client/web/src/boot.ts:55-66`).

What the desktop must provide so existing client code works unchanged:

1. `doFetch` over IPC primitive A: POST JSON `ClientRequest` bodies to
   `/api/<method>`, `/api/respond`, `/api/<channel>/<endpoint>`; expect
   JSON `RpcResponse`/`RpcReceipt` bodies (non-2xx only as transport
   failure, `fetch/client.ts:324`).
2. `openMux`/`openHost` over IPC primitive B: `AsyncIterable<
   RpcRequest<MuxFrame>>` / `<RpcRequest<HostFrame>>` whose frames parse
   to the host's exact JSON `ServerRequest` envelope; `onOpen` fires once
   the physical stream is readable; abort ends the stream; end/throw drives
   reconnect.
3. Set `__DSH_TRANSPORT__` before the `connection` entry's `apply` runs.

Stage 3 delivered the physical carrier behind items 1-2: the runtime
serves both primitives over its process port, the main broker relays the
frames to the renderer, and `window.dshDesktop.openTransport()` is the
renderer entry point (Agent Note `2026-08-23-desktop-ipc-transport`).
Stage 4 implements the desktop `AbstractApiClient` subclass and sets
`__DSH_TRANSPORT__` on top of it.

DESKTOP-CONSUMPTION: minimal generic extension in the sense of one new
desktop-owned platform subclass of `AbstractApiClient`; zero upstream
source edits. Narrowest existing boundary:
`__DSH_TRANSPORT__` + the `doFetch`/`openMux`/`openHost` virtuals
(`fetch/client.ts:254, 353, 358`).

---

## 4. Renderer / client boot

### 4.1 Entry

`apps/web/src/main.ts` (10 lines) finds `#root` and runs
`new AppWebEntry(el).run()`; everything else lives in
`@deepseek-ai/dsh-client-web` (`packages/client/web/src/boot.ts:22`;
export `packages/client/web/src/index.ts:8`). Constructor
`constructor(container: HTMLElement, seams?: BootSeams)` (`boot.ts:35-39`) —
`BootSeams` is a documented test seam, not a production knob (`:18-19`).
`run()` (`boot.ts:46-78`) reads from `window`: `__ModuleLoader__`
(required, `:48-52`), `__DSH_TRANSPORT__?.loadBundle` (`:55-60`),
`__DSH_BOOT__` (`:61-66`).

DESKTOP-CONSUMPTION: consume unchanged.

### 4.2 Boot graph mount order and transport selection

Inside `AppWebEntry.run` (`packages/client/web/src/boot.ts`):

1. `moduleLoader.create({ boot, staticModules, loadBundle? })`
   (`boot.ts:61-66`) — the module system is built before any Cordis exists
   ("bootstrap exception", `packages/client/modules/src/client/index.ts:3-11`);
   `createClientModuleSystem` (`:38-51`).
2. Static seed table: react, cordis, `ui-slots`, `ui-primitives`
   (`packages/client/web/src/seed.ts:22-34`, `platform.ts:8-17`).
3. `new Context()` + `ctx.plugin(Loader)`; every manifest row becomes a
   Loader entry (`boot.ts:70-72, 124-131`); `loader.await()`; activation
   audit (`boot.ts:133-135, 138-158`).
4. Mount: `scope.uiRenderer.mount(this.container)` (`boot.ts:89-94`).

There is no separate client-side composition bundle: the client entry graph
is `window.__DSH_BOOT__`, composed host-side by `ClientModuleRegistry`
(`packages/client/modules/src/index.ts:282-346`), which scans the host
Loader entries for packages declaring `dsh.client`
(`resolveMeta`, `:429-463`). The roster is declared by the web-app bundle
patch (`packages/bundle/web-app/cordis.patch.yml:153-295`) and pinned as
dependencies (`packages/bundle/web-app/package.json:45-92`).

Other carrier read points (verified exhaustively over
`packages/client/*/src`):

- Default bundle transport: same-origin classic `<script>` append
  (`packages/client/modules/src/client/system.ts:14-27`), only when no
  `loadBundle` override (`:75`).
- Generic Typert RPC channel: `createWebConnectionRpc` falls back to
  `globalThis.fetch` (`packages/client/connection/src/client/rpc.ts:23-24`);
  the gateway client face calls it
  (`packages/api/gateway/src/client/index.ts:408`) — covered by
  `transport?.fetch`.
- NOT covered by the hook: the client HMR driver opens
  `new EventSource('/plugins/events')`
  (`packages/client/hmr/src/client/index.ts:167`;
  `packages/client/hmr/src/events.ts:16`). `client-hmr` is an active row in
  the shipped composition (`packages/bundle/web-app/cordis.patch.yml:150-151`);
  desktop disables that row in its composition overlay (no source edit).
- `location` reads: `isLoopback` from `location.hostname`
  (`packages/client/connection/src/client/index.ts:110-111, 132`;
  classifier `packages/client/connection/src/loopback-hostname.ts:14-20`);
  RPC/API base from `location.origin` with `http://dsh.internal` fallback
  (`rpc.ts:11, 56-59`; `fetch/client.ts:293-296`).

Pitfall: with a scheme-only origin (a bare `dsh-app://` host),
`location.hostname` is `''` and `isLoopback` is `false`; UI gates that AND
on it — e.g. `canOpenPath = isLoopback && hostCanOpenPath`
(`packages/client/ui-deliverables/src/client/ProducedFiles.tsx:76-77`) —
would hide native-open affordances unless the packaged page URL carries a
loopback hostname.

DESKTOP-CONSUMPTION: consume unchanged — the `__DSH_TRANSPORT__` hook plus
disabling the `client-hmr` row covers all carrier traffic; no source edit.

### 4.3 The module loader (`window.__ModuleLoader__`)

Generated server-side at every index render, not a built asset:
`bootInjections(graph)` emits the inline head script facade
(`packages/client/modules/src/index.ts:241-273`; IIFE `:243-264`), pushed
as an index-injection row via the `webserver/index-inject` event
(`:343-345`) and spliced into the dist `index.html` by
`renderIndexInjections` (`packages/host/webserver/src/injections.ts:45-59,
82-104`) during `webServer.renderIndex`
(`packages/host/webserver/src/index.ts:298-300`).

- `create(options)` materializes the preloaded `dsh-client-modules`
  registration and delegates to `createClientModuleSystem`
  (`packages/client/modules/src/index.ts:249-262`).
- Parser preloads `PARSER_PRELOAD_IDS = ['@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-runtime']` as parser-blocking classic scripts
  (`:228-229, 265-267`), then the `__DSH_BOOT__` global row (`:271`).
- Bundle arrival = `loadBundle(url)` (`packages/client/modules/src/client/system.ts:113-125`);
  registration contract `load({ id, factory })`
  (`packages/client/modules/src/client/manifest.ts:190-200`);
  materialization is a synchronous memoized `require`
  (`system.ts:147-187`).
- Bundle URLs: graph row `url = /plugins/<id>/client.js?rev=<rev>`
  (`packages/client/modules/src/index.ts:167-176`).
- No base concept: resolution is against the document origin
  (`system.ts:17`). Remap paths: (a) serve the document itself from the
  target origin so relative URLs (including the two preload script tags,
  which never pass through `loadBundle`) resolve there; (b) the
  `loadBundle` override for all non-preloaded rows.

DESKTOP-CONSUMPTION: consume unchanged.

### 4.4 Smallest clean injection set (verdict)

1. `__DSH_TRANSPORT__ = { createApiClient, fetch, loadBundle? }` — the
   complete carrier override (§3.5, §4.2).
2. Bundle bytes reachable at the graph URLs — via app-protocol origin
   remap (document served from a loopback host under `dsh-app://`) and/or
   `loadBundle`.
3. `window.__DSH_BOOT__` present before the shell runs
   (`packages/client/web/src/boot.ts:61-66`). It is materialized only by
   the host's index render (§4.3); the composed graph also exists
   in-process as `ClientModuleRegistry.graph()`
   (`packages/client/modules/src/index.ts:352-354`) but no route or IPC
   surface exports it standalone. A renderer whose `fetch` shim hits the
   host webserver over IPC can obtain it by fetching `/` and reading the
   rendered global — zero upstream change.
4. A loopback hostname for the packaged document (§4.2 pitfall).

DESKTOP-CONSUMPTION: consume unchanged for (1), (2), (4); item (3) is
category D (Extension Surface D1) — conditional narrowest boundary:
`ClientModuleRegistry` in `packages/client/modules/src/index.ts`.

---

## 5. Plugin / UI boot

### 5.1 `__DSH_BOOT__` generation and shape

Generated at serve time, per index render: dist `index.html` →
`renderIndex` (`packages/host/frontend-static/src/index.ts:107-108`) →
`renderIndexInjections` (`packages/host/webserver/src/index.ts:298-300`) →
`webserver/index-inject` emit (`:286-290`) → `ClientModuleRegistry` pushes
`bootInjections(this.composed)` (`packages/client/modules/src/index.ts:343-345`).
The graph row is `{ kind: 'global', name: '__DSH_BOOT__', value: graph }`
(`:271`), rendered as
`<script>globalThis["__DSH_BOOT__"] = <JSON></script>`
(`packages/host/webserver/src/injections.ts:47-55`).

Wire shape (`packages/client/modules/src/client/manifest.ts`):

```ts
WebBootGraph { rev: string; entries: WebBootEntry[] }        // :67-76
WebBootEntry { id: string; url: string; rev: string;
               inject?: string[]; immediately?: boolean;
               external?: string[] }                          // :51-64
```

- graph `rev` = 12-hex sha1 over serialized entries
  (`packages/client/modules/src/index.ts:161-164, 412-415`)
- row `rev` = sha1 of the built bundle bytes (`:472-479`)
- entries ordered in module-graph order (`orderByModuleGraph`, `:188-220`)
- client-side validation: `parseBootManifest`
  (`packages/client/modules/src/client/manifest.ts:147-188`)

DESKTOP-CONSUMPTION: consume unchanged — the desktop ships byte-identical
dist and produces the same graph semantics; the graph's physical delivery
point is item 4.4(3).

### 5.2 Manifest contents and discovery

Per plugin: `id` (= package name / module-table key), `url`, `rev`,
optional `inject` (package-name edges, informational only — "preflight
display / HMR diffing", `manifest.ts:58-59`), optional `immediately`
(stage-one prefetch, `:60-61`), optional `external` (module-graph edges,
`:62-63`).

Data source: the host Loader tree, not a static catalog.
`ClientModuleRegistry` reads each package's `package.json` `dsh.client`
declaration (`platform: 'web'`, `inject`/`external`/`immediately` —
`parseDshClient`, `packages/client/modules/src/index.ts:126-146`) and its
`exports["./client"]` path (`:149-159, 429-463`); incremental via
`internal/plugin` events (`:316-326`); re-hash on rebuild via `rebuilt()`
(`:371-389`).

Client discovery: none beyond the manifest — every manifest row becomes a
Loader entry (`packages/client/web/src/boot.ts:124-131`).

DESKTOP-CONSUMPTION: consume unchanged.

### 5.3 Bundle serving, CSS, staging

- Route: prefix `/plugins` —
  `ctx.webServer.register({ kind: 'prefix', path: '/plugins', handler:
  this.serveBundle })` (`packages/client/modules/src/index.ts:339-342`);
  `serveBundle` (`:529-565`) answers `GET /plugins/<id>/client.js` as
  `text/javascript`, `cache-control: no-cache` (`:553-559`), and
  `/plugins/<id>/client.js.map` as `application/json`.
- HMR dev channel: exact route `/plugins/events` (SSE), frames
  `{type:'graph'}` / `{type:'rebuilt', id, rev}`
  (`packages/client/hmr/src/index.ts:165-179`;
  `packages/client/hmr/src/events.ts:10-16`).
- CSS: no separate CSS endpoint. The client build preset compiles each
  plugin's CSS into the bundle and emits a style-injection module that
  inserts a tagged `<style data-plugin-css=...>` element at factory
  materialization (`packages/client/tsdown.client.ts:33-47`); the module
  system inventories/claims the tags (`claimStyles`,
  `packages/client/modules/src/client/system.ts:34-44`).
- Staged activation: one tier flag, `immediately` (declared by 7 packages,
  e.g. `packages/client/connection/package.json:36`); boot prefetches those
  rows and skips prefetch entirely when a transport owns bundle bytes
  (`packages/client/web/src/boot.ts:97-110`). Activation order is Cordis
  service-waiting, not manifest order.

DESKTOP-CONSUMPTION: consume unchanged — serve the same bundle bytes from
`dsh-app://` at the same path convention; CSS arrives inside each bundle.

### 5.4 Identical vs re-mappable bytes (dsh-app://)

Must be byte-identical:

- the shell dist files (`packages/host/frontend-static/src/index.ts:64-97`;
  dist resolved from `@deepseek-ai/dsh-web-frontend/dist`,
  `packages/bundle/web-app/src/index.ts:163-171`);
- each plugin bundle's bytes (row `rev` is the sha1 of exactly those bytes,
  `packages/client/modules/src/index.ts:472-479`);
- the `__DSH_BOOT__` wire shape/semantics (`manifest.ts:51-76, 147-188`);
- the head injection groups (loader facade script + preload script tags +
  graph global) in that order
  (`packages/client/modules/src/index.ts:241-273`).

Re-mappable: host/port and the document origin (everything is page-relative;
`resolveBase` = `location.origin`, `packages/host/apiproxy/src/fetch/client.ts:293-296`);
the `dsh-app://` scheme. Not independently choosable: `rev` values
(derived), the `/plugins/<id>/client.js` path convention.

DESKTOP-CONSUMPTION: consume unchanged.

---

## 6. Native / privileged capabilities

### 6.1 Directory picker

Service Definition: abstract `DirectoryPicker` service, registered as
`ctx.directoryPicker`, one implementation per context
(`packages/host/directory-picker/src/index.ts:131-141`, name at `:133`).
Discriminated capability: `native { pick(signal): Promise<string|null> }`
(`:17-25`) vs `browse { list(path?, signal?), createDirectory(path, name) }`
(`:63-87`).

Providers (exact packages):

- `@deepseek-ai/dsh-host-directory-picker-native` — OS choosers: macOS
  `osascript`, Linux Zenity/KDialog, Windows `IFileOpenDialog`
  (`packages/host/directory-picker-native/src/index.ts:1-10, 20-34`).
- `@deepseek-ai/dsh-host-directory-picker-browse` — in-app browser
  (`packages/host/directory-picker-browse/src/index.ts:187-324`).
- `@deepseek-ai/dsh-host-directory-picker-auto` — adaptive chooser
  (loopback + non-SSH + display ⇒ `native`, else `browse`;
  `packages/host/directory-picker-auto/src/index.ts:62-97`,
  `resolve.ts:47-53`).

Consumers: `host.pickDirectory` requires the `native` capability
(`packages/host/apiproxy/src/api-proxy.ts:2842-2869`);
`host.listDirectory`/`host.createDirectory` require `browse`
(`:2870-2908`); wire contracts `packages/host/apiproxy/src/api/host.ts:36-98`.

How the browser UI satisfies a pick today: whichever interaction is
composed, the client surface drives the wire — the native occupant calls
`pick()` → `ctx.workspaces.pickDirectory()` → `api.host.pickDirectory({})`
(`packages/client/ui-directory-picker-native/src/client/index.ts:26-39`,
`flow.ts:25-64`; runtime leg
`packages/client/runtime/src/client/workspaces/service.ts:209-216`), and
the OS dialog opens on the host display; the browse variant renders an
in-app modal driving list/create one level at a time
(`packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx:262,
332-344, 608`).

Electron slot-in point: a new `DirectoryPicker` subclass loaded as a plugin
(service seat `packages/host/directory-picker/src/index.ts:132-134`), with
the composition `directory-picker` row
(`packages/bundle/web-app/cordis.patch.yml:96-97`) overridden by the
desktop overlay. Documented intent: "an Electron shell would provide the
`native` interaction through its own dialog API"
(`.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md:28, 47`).
Related openers: `ApiProxyDefaults.openPath` / `openTextFile`
(`packages/host/apiproxy/src/api-proxy.ts:596-601, 1840-1856`).

DESKTOP-CONSUMPTION: desktop-only — stage 2 mounted the existing `-native`
provider via a disable/insert overlay (§1.2); stage 5 replaces that
overlay's insert with the desktop provider.

Stage 5 resolution: the desktop composition
(`apps/desktop-runtime/src/composition.ts`) disables the web `auto`
`directory-picker` row and inserts the desktop provider module
(`apps/desktop-runtime/src/directory-picker.ts`, `DesktopDirectoryPicker`,
built to `dist/directory-picker.js` beside the runtime entry and loaded by
file URL). It is the same native seat — `capability()` returns one stable
`{ kind: 'native', pick }` object — but `pick` delegates to the runtime
child's native bridge (`apps/desktop-runtime/src/native-bridge.ts`), which
crosses to Electron main's `dialog.showOpenDialog` over the native
capability channel (§6.4). The child therefore never spawns
osascript/Zenity/KDialog/COM choosers. An operator cancel is the
capability's `null`; a caller abort terminates the pick (`host.pickDirectory`
maps it to the `cancelled` business code, `api-proxy.ts:2842-2869`); Electron
offers no API to close an already-visible dialog, so a late chooser result
is dropped as a terminal no-op.

The stage 2 `-native` provider remains in the pinned source for the
browser/host surfaces; desktop simply no longer mounts it.

### 6.2 openDocument flows

`PRIVILEGED_METHODS` (loopback-pinned set; applied with an empty trust
list, `packages/client/connection/src/index.ts:145-149`): `agentPreset.read`,
`agentPreset.copy`, `agentPreset.openDocument` (`:106`),
`agentPreset.remove`, `host.pickDirectory`, `host.openPath` (`:109`),
`settings.describe`, `settings.openDocument` (`:111`), `settings.update`,
`settings.replace`, `settings.mutate`, `credentials.describe/set/unset`,
`llm.discoverModels` (`packages/client/connection/src/index.ts:89-119`).
There is no bare `openDocument` method; general open is `host.openPath`.

1. General — `host.openPath` (wire `api/host.ts:94-97`; impl
   `api-proxy.ts:2909-2911` → `openTarget` `:1816-1837` →
   `defaults.openPath ?? openNativePath` `:1840-1846`; platform openers
   `packages/host/apiproxy/src/native-path-opener.ts:119-153, 181-187`).
   "Document" = a host filesystem path (workspace-relative paths resolved
   client-side, `packages/client/ui-conversation/src/client/apply.ts:400-403`).
   Client result handling: busy/error state on the chat view, no
   download/blob (`packages/client/ui-conversation/src/client/chat/ChatView.tsx:181-201`).
2. Settings — `settings.openDocument` (wire
   `api/settings.schema.ts:39-45`, response `{ opened: true }`; impl
   `api-proxy.ts:3171-3200`): materializes the settings file via
   `settings.prepareDocument()` (`packages/settings/settings-file/src/index.ts:153-168`)
   and opens it in a text editor via `openTextFile`
   (`api-proxy.ts:1849-1856`). Client tracks in-flight/error state only
   (`packages/client/ui-settings-general/src/client/settings-document-store.ts:58-73,
   81-99`).
3. Agent preset — `agentPreset.openDocument` (wire
   `api/agent-presets.schema.ts:70-79`, response union
   `{opened:true} | {opened:false, path}`; impl `api-proxy.ts:3070-3095`):
   "document" = the preset's directory for a `trust === 'user'` preset;
   opened via the `openPath` leg, or returned as a plain path when
   `!canOpenPaths()`. Client reveals the path as text on `opened:false`
   (`packages/client/ui-agent-preset/src/client/section-store.ts:275-295`).

For desktop: all three are wire-driven; the host-side openers already
resolve to the OS where the host runs. `defaults.openPath` / `openTextFile`
/ `canOpenPath` (`api-proxy.ts:596-601`) are the injection seam if the
desktop host prefers Electron-native opening.

DESKTOP-CONSUMPTION: consume unchanged (wire flows); stage 5 uses the
seam through the M4 `nativeOpeners` service.

Stage 5 resolution (M4): `ApiProxyService` reads an optional provided
service `nativeOpeners` (`{ openPath?, openTextFile? }`) and forwards the
present members as its `ApiProxyDefaults` openers
(`packages/host/apiproxy/src/index.ts`, `src/api/native-openers.ts`). By
absence the package's own native openers and `canOpenNativePath()`
detection stand unchanged (web app unaffected). The desktop runtime
provides `nativeOpeners.openPath`, bridged to Electron `shell.openPath`
over the native channel; `canOpenPaths()` therefore reports the desktop as
able to open. `openTextFile` is deliberately NOT bridged: the pinned
Electron `shell.openPath` takes no options and has no text-editor intent
(`electron.d.ts` `shell.openPath(path): Promise<string>`), so
`settings.openDocument` keeps the DSH native text opener (subprocess
`open -t` on macOS, `native-path-opener.ts:134`), where a text editor is
actually requested.

### 6.3 Other native needs

- External URL opening: no capability seam. External links are plain
  anchors (`target="_blank"`, `packages/client/ui-primitives/src/WebBlock.tsx:121`;
  `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:1111-1112`).
- OS notifications: absent (no `Notification` usage in any client or host
  package; the only "Notification" identifiers are JSON-RPC SDK concepts).
- File picker: absent — no `<input type="file">` in any client package; the
  only picker seam is the directory picker.

DESKTOP-CONSUMPTION: desktop-only (all three; no existing seam to extend).
Deferred at stage 5: all three stay absent — the pinned source has no
consumer, and the stage 5 method set is closed to what exists.

### 6.4 The desktop native capability channel (stage 5)

The private runtime↔main channel for OS capability calls. It rides the
supervisor's fork IPC (never the renderer, never the stage 3 transport
port, never localhost) and is separate from it: the supervisor demuxes
`native.request` off the child channel before the transport relay
(`apps/desktop/src/main/runtime.ts`), and the runtime child's bridge
demuxes the reverse direction the same way
(`apps/desktop-runtime/src/transport-process.ts` ignores it by the
transport discriminant).

Closed wire contract (`apps/desktop-runtime/src/native.ts`, shipped as the
`@deepseek-ai/dsh-desktop-runtime/native` subpath; the main face imports
it, the runtime face imports it, and nothing else may):

- `native.request { requestId, method: 'directory.pick' }` /
  `{ requestId, method: 'path.open', path }` — child→main. The method set
  is closed and schema-validated (`parseNativeRequest`): a malformed
  request is a protocol refusal, never an OS call. Paths are non-empty,
  NUL-free, and ≤ 32768 characters.
- `native.response { requestId, ok: true, path?: string | null }` /
  `{ requestId, ok: false, code, message }` — main→child. The failure
  vocabulary is closed: `unknown-method`, `malformed-request`,
  `dialog-failed`, `open-failed`, `cancelled`. Messages carry no DSH
  business vocabulary; `message` is bounded (512 chars).
- `native.cancel { requestId, reason }` — main→child, sent on generation
  teardown for every still-pending request.

Roles:

- Main side: `createNativeChannel`
  (`apps/desktop/src/main/native-channel.ts`) validates each request,
  dispatches onto `createNativeCapabilities`
  (`apps/desktop/src/main/native-capabilities.ts`) —
  `dialog.showOpenDialog({ properties: ['openDirectory'] })` and
  `shell.openPath(path)` over an injectable port — and settles each
  request with exactly one response (a success, a closed-code failure, or
  a teardown cancel). Duplicate in-flight ids settle once; a torn-down
  generation drops late results.
- Runtime side: `createNativeBridge`
  (`apps/desktop-runtime/src/native-bridge.ts`) issues unique request ids,
  holds the caller's `AbortSignal` for the operation's whole lifetime
  (abort ⇒ `AbortError` terminal, operation terminal, late messages
  ignored), and settles every pending operation with `channel-closed` on
  dispose or supervisor disconnect. `NativeError` codes map onto DSH
  business codes at the seam: abort ⇒ `cancelled`, anything else ⇒
  `internal` (`api-proxy.ts` `openTarget`/`pickDirectory` mapping).

Vocabulary boundary: Electron main may know the OS capability names
(`directory.pick`, `path.open`) and nothing about DSH; the runtime child
may know the DSH seats (`ctx.directoryPicker`, `nativeOpeners`) and
nothing about Electron. The renderer has no native protocol knowledge at
all (boundary spec `apps/desktop/tests/boundary.spec.ts` pins both sides
plus the renderer's ignorance).

Acceptance: `apps/desktop-runtime/tests/native-boot.spec.ts` forks the
built runtime, plays the main side over the child IPC, and pins
`host.describe.canOpenPath`, pick success/cancel, open success/failure,
the main-issued cancel mapping, client-abort termination with the late
result dropped, and healthy reuse after the abort.

---

## 7. Answerable runtime interactions

### 7.1 Approvals

- Service: `ApprovalService` (`packages/interaction/user-approval/src/index.ts:192`);
  `request(req)` (`:257-276`) requires an open turn, mints
  `ApprovalRequestId` (branded UUID, `types.ts:14, 21-23`), appends
  `approval/asked` (`:267-272`), dispatches the `approval/request` waterfall
  (`:304-344`, fail-closed default `'unavailable'`), appends
  `approval/decided` (`:274`).
- Id scheme: the durable event id is `ApprovalRequestId` (pairs asked ↔
  decided); the answerable wire id is the mux frame's `rpcId`
  (`RpcId`, branded UUID), minted per pending entry
  (`packages/host/apiproxy/src/api-proxy.ts:1416`). The client keys pending
  approvals by `a:<approvalId>`
  (`packages/client/runtime/src/client/sessions/pending.ts:25, 38, 60`;
  `manager.ts:83`).
- Pending registry (host, in-memory): `pendingApprovals =
  new Map<RpcId, PendingApproval>()` (`api-proxy.ts:1072`; entry shape
  `:620-628`). Registered in the `ctx.on('approval/request')` waterfall
  (`:1363-1429`): pairs the request to its newest undecided
  `approval/asked` (`:1375-1395`), creates the entry (`:1415-1424`), pushes
  the `approval/requested` frame to every mux queue (`:1426-1427`); teardown
  settles everything as `'cancelled'` (`:1360-1362`).
- SessionEvent types (`packages/interaction/user-approval/src/index.ts:34-73`):
  `approval/asked` (`:44-49`), `approval/decided` (`:55-58`),
  `approval/policy` (`:67-71`). Live wire frames (not session events):
  `approval/requested` / `approval/resolved` (`api/events.ts:72-73`).
- Response path: `IApiClient.respond(message: ClientResponse, signal?)`
  (`packages/host/apiproxy/src/fetch/client.ts:165, 508-512`) →
  `POST /api/respond` → `ApiProxy.respond` (`api-proxy.ts:3594-3640`);
  approval branch (`:3597-3608`): routes by `message.rpcId`, validates
  `approvalResponsePayloadSchema` + `approvalId`/`sessionId` match
  (`:3600-3605`), then `approval.resolve(outcome)` deletes the entry,
  broadcasts `approval/resolved` (`:1408`), and resolves the
  `ctx.approval.request()` promise; the service appends
  `approval/decided`. UI face: `ApprovalWait.answer(outcome:
  'allowed-once' | 'rejected')`
  (`packages/client/ui-conversation/src/client/contract/slots.ts:714-722`)
  → `PendingWait.respond` backfills the requested frame's `rpcId`
  (`packages/client/runtime/src/client/sessions/pending.ts:73-76`).
  Receipt: `RpcReceipt = { accepted: true } | { accepted: false; reason:
  'not-pending' | 'bad-response' }` (`api/rpc.ts:187`); the final outcome
  arrives in the `approval/resolved` frame, not the receipt.

DESKTOP-CONSUMPTION: consume unchanged — pending state lives in the host
process; the client touchpoint is `IApiClient.respond` over primitive A.

### 7.2 Questions (ask-user / requested)

- Capability: `UserQuestionService` (`ctx.userQuestions`),
  `packages/interaction/user-questions/src/index.ts:51-141`; one active UI
  provider via `registerProvider` (`:64-75`); `ask()` (`:92-140`) validates
  (empty questions, caller-not-live, delegated caller, intent, no provider)
  and delegates.
- Raised by the model tool `ask_user_question`
  (`packages/interaction/tool-ask-user/src/index.ts:19-100`, `execute`
  `:80-99`) → `ctx.userQuestions.ask(...)`.
- The web provider is registered by the gateway
  (`packages/host/apiproxy/src/api-proxy.ts:1310-1338`): mints a stable
  `rpcId` (`:1318`), stores `PendingQuestion` in `pendingQuestions`
  (`:1071`; shape `:646-654`), pushes `question/requested` to all mux
  queues (`:1331-1335`). There is no `question/*` session event — the
  question content rides in the `tool/call` arguments; settlement is a
  `tool/result`.
- Answered: same respond carrier (`fetch/client.ts:508-512`). Host
  validation `matchesQuestions` (per-index id match, no duplicate
  selections, single-select rules, labels must exist,
  `api-proxy.ts:657-674`); `claimQuestion` (`:1298-1308`) broadcasts
  `question/resolved`; `pending.resolve(answer)` resolves the `ask()`
  promise the tool awaits. UI face
  (`packages/client/ui-user-questions/src/client/contract/slots.ts:114-121`).
- Skip semantics are UI-local: a skipped question is encoded as an empty
  answer item (`QuestionComposer.tsx:189-199`); the host accepts empty
  `selected`. Whole-batch cancel sends
  `{ ok: false, error: { code: 'cancelled' } }`
  (`slots.ts:124-132`) → `question/resolved(outcome: 'cancelled')` +
  `ASK_CANCELED` (`api-proxy.ts:3611-3618`).

DESKTOP-CONSUMPTION: consume unchanged — one respond RPC; skip/cancel are
already wire-encoded results.

### 7.3 Client receive/answer path

- Receive (downlink push, not fetch): `ConnectionController` pumps the mux
  (`packages/client/connection/src/client/connection.ts:128`) →
  `Session.handleMuxEnvelope`
  (`packages/client/runtime/src/client/sessions/session.ts:471-519`):
  `approval/requested` mints `PendingWait('approval', rpcId, ..., m =>
  this.api.respond(m))` (`:491-496`); `question/requested` likewise
  (`:504-509`); `*/resolved` settle by stable identity (`:497-503, 510-515`).
  `PendingWait` (`pending.ts:34-82`); the pending list is exposed on the
  session snapshot (`session.ts:736-750`). For never-instantiated sessions
  the manager buffers answerable frames by stable identity
  (`manager.ts:108-116`).
- Answer: `PendingWait.respond` → `IApiClient.respond` → `POST /api/respond`.
  Panel removal is frame-driven (the broadcast `resolved` frame settles the
  wait).

DESKTOP-CONSUMPTION: consume unchanged — push on primitive B, answers on
primitive A.

### 7.4 Persistence / reconnect implications

- Client reload / reconnect (same host): re-surfaced via pending-registry
  replay, not log replay. Mux-open replays still-pending requested frames
  with the same stable `rpcId` ("Refresh recovery", `api-proxy.ts:3334-3345`,
  registry note `:1348-1354`); the client `resync()` clears its pending map
  expecting the baseline replay (`session.ts:434-437`); instantiating a
  session replays its `pendingBuffers` (`manager.ts:108-116`).
- Durable audit: approvals only — `approval/asked`/`approval/decided` are
  session-log events (`user-approval/src/index.ts:267-274`), so a settled
  approval survives a host restart in the transcript; pending state itself
  is never logged.
- Host process restart: NOT re-surfaced. Both registries are in-memory
  `Map`s inside the `createApiProxy` closure (`api-proxy.ts:1071-1072`); no
  disk-backed pending state exists (verified by search). On reload, an
  interrupted in-flight turn is durably closed with synthetic tool errors
  (`packages/session/session-persistence/src/index.ts:171-183`); question
  content is reconstructable only from `tool/call` arguments.

Desktop consequence: a desktop "runtime failed → restart" screen must not
pretend a pending approval/question survived; the recovered state comes
from the persisted log (per SPEC stage 9). The mechanism above works
identically over primitive B as long as the stream reopens.

DESKTOP-CONSUMPTION: consume unchanged.

---

## 8. Session / event persistence

### 8.1 Authoritative event log

- Format version: `SESSION_FORMAT_VERSION = 0`
  (`packages/core/session/src/types.ts:56`; pinned pre-release with no
  compatibility promise, bump policy `:33-55`); enforced on write
  (`packages/core/session/src/index.ts:152`) and load
  (`packages/session/session-persistence-jsonl/src/format.ts:240-247`;
  coordinator `packages/session/session-persistence/src/coordinator.ts:78-80`).
- On-disk layout (JSONL backend `@deepseek-ai/dsh-session-persistence-jsonl`):
  first record = `HeaderLine` (`format.ts:33-44`), then one JSON record per
  line with chunk packing (`:221-224`; `index.ts:37`) and default `zstd`
  encoding (`.jsonl.zstd`, `index.ts:38`, `format.ts:24-26`).
- Location: backend root = `dshHomePath('sessions')`
  (`packages/bundle/base/cordis.patch.yml:98-100`);
  `logPath(root, cwd, id, compression)` (`format.ts:201-208`) →
  `<root>/<projectKey(cwd) or _no-cwd>/<encodeSegment(id)>/session.jsonl[.zstd]`.
- Authoritative location API: `SessionPersistence.locate(meta):
  SessionLocation` — "a location hint, never an authorization token"
  (`packages/session/session-persistence/src/index.ts:71-76`, abstract
  `:96`; JSONL impl `packages/session/session-persistence-jsonl/src/index.ts:172-174`).

DESKTOP-CONSUMPTION: consume unchanged — the renderer never parses logs;
"where is this session's file" is host-side data behind `locate`.

### 8.2 Historical load

- Client: `IApiClient.sessions.history(payload, signal?)`
  (`packages/host/apiproxy/src/fetch/client.ts:92, 416`) → unary
  `POST /api/session.history`. Web client call sites: `Session.history()`
  (`packages/client/runtime/src/client/sessions/session.ts:775-783`), first
  open `doOpen` (`:618-648`, page size `PAGE_MESSAGES = 50`, `:32`),
  page-up `loadOlder` (`:381-414`).
- Host: `SessionsApi.history` (`packages/host/apiproxy/src/api/sessions.ts:286-287`;
  response `{ events: HistoryEntry[]; hasMore; projections? }`,
  `HistoryEntry = { event, view? }` `:68-71`; value schema
  `api/sessions.schema.ts:239-243`); impl `api-proxy.ts:2154-2182` →
  `historySourceFor` (`:1474-1479`: attached live session, else detached
  inspection via `sessionPersistence.inspect`) → `historyCutOf`
  (`:1504-1515`, synchronous single cut) → message-boundary pagination
  backwards from the tail with a `beforeSeq` cursor (`:228-254, 746-761`).
- Durable read primitives: `load` (balanced view + cold recovery,
  `session-persistence/src/index.ts:183`), `inspect` (`:200`),
  `readFrom(id, fromSeq)` (`:220-221`), `list` (`:228`).

DESKTOP-CONSUMPTION: consume unchanged — history rides primitive A as an
ordinary unary RPC.

### 8.3 Live attachment, ordering, reconnection

- Live attach: no per-session subscribe call. The single mux downlink
  (opened once per connection generation) carries every attached session;
  on open the host pushes `session/subscribed { sessionId, lastSeq:
  session.seq - 1 }` per attached session
  (`api-proxy.ts:420-423, 3331-3333`), then all `session/event` frames;
  sessions created later subscribe mid-stream via `session/created`
  (`:3393-3403`).
- No cursor/resume in v1: "reconnection = reopen the stream + refetch
  history" (`api/events.ts:48-56`).
- Coded ordering guarantees:
  - `seq` contiguity: "always the log length (the `seq = log.length`
    contiguity contract)" (`packages/core/session/src/index.ts:564-567`);
    every `SessionEvent` carries `seq` + `time`
    (`packages/core/session/src/types.ts:411-414`).
  - Append-only persistence: the first event's `seq` must equal the stored
    next-seq (`session-persistence/src/index.ts:135-143`); the JSONL scanner
    rejects committed-region seq gaps and computes a safe truncation offset
    for torn tails (`format.ts:329-344, 362-373`).
  - Client join of history + live is by seq comparison + log refetch:
    `subscribedLastSeq` baseline (`session.ts:108-109, 482-489`); if the
    baseline is ahead of the window tail, re-pull the tail page once
    (`doOpen` `:631-637`); events arriving while loading buffer into
    `liveBuffer` and stitch after install (`:657-669, 688-692`); overlap
    dedup (`appendLive` `:672-675`); a gap `seq > tailSeq + 1` buffers the
    event and triggers `repairGap` (repull + restitch, `:694-699, 712-728`);
    older-page continuity asserted in `loadOlder` (`:394-399`).
- Documented vs coded: documented = baseline frame + pending replay +
  reopen/refetch strategy; coded = the contiguity invariants and the
  client's dedup/gap-repair loops. NOT guaranteed/documented: atomicity
  between the `session.history` read and the `session/subscribed` baseline
  (two independent calls on different carriers) — the seq comparison loop
  is the actual guarantee. `session/projection` frames carry their own seq
  watermark with a higher-seq-wins client rule (`api/events.ts:99-107`;
  `api/sessions.ts:83-88`).

Desktop consequence: the IPC transport must deliver stream frames in order
(per stream) and must not coalesce or reorder; the existing reconciliation
logic is reused as-is and tolerates the history/live skew by design.

DESKTOP-CONSUMPTION: consume unchanged.

---

## 9. External subagents

### 9.1 Codex

- Package: `@deepseek-ai/dsh-subagent-codex`
  (`packages/subagent/subagent-codex`); `CodexProvider`
  (`src/index.ts:60`), `inject = ['subagents', 'subprocess']` (`:30-31`),
  registration `ctx.subagents.registerProvider(...)` (`:130-134`).
- Spawn: `[process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']`
  (`src/run.ts:132-134`); the bin is resolved from the pinned
  `@openai/codex` package (`run.ts:43-52`, `package.json:52`) — not a bare
  PATH lookup.
- Lifecycle: per-task spawn, no pool ("Every accepted run starts a fresh
  official package-local Codex wrapper", `src/index.ts:2-4`); spawn through
  the shared subprocess seam (`src/index.ts:97`, `run.ts:236-242`); teardown
  `disposeCodexChild` (close wire, `child.terminate()`, `waitForExit`,
  `child.done`; `run.ts:185-217`) registered as the run's `teardown`
  (`run.ts:431-438`); cancel → `wire.interrupt()` (`run.ts:306-313`).
- Tree-kill authority is the subprocess seam: `LocalSubprocessRuntime` keeps
  live handles and sweeps on fiber dispose + synchronous host exit
  (`packages/subprocess/subprocess-local/src/index.ts:47-59, 62-77, 79-102`);
  escalation SIGTERM → grace → SIGKILL
  (`packages/subprocess/subprocess-local/src/spawn.ts:439-457`).
- Config: `providerName` (default `codex`), `env`, `permissionMode`
  (`never` / `approve-for-me` / `dangerously-bypass-approvals-and-sandbox`,
  default `never`), `disposeGraceMs` (default 3000) (`src/index.ts:36-56`;
  modes `run.ts:54-68`). Off by default: presets install the tool row
  `disabled: true` (`apps/cli/config/agent-presets/standard/agent.cordis.yml:192-222`).

DESKTOP-CONSUMPTION: consume unchanged — the desktop-runtime host composes
the plugin; no client/UI owns the child.

### 9.2 Claude Code

- Package: `@deepseek-ai/dsh-subagent-claude-code`
  (`packages/subagent/subagent-claude-code`); registration pattern identical
  (`src/index.ts:30-31, 146-150`).
- No direct CLI spawn: it invokes the official Agent SDK `query()`
  (`src/run.ts:11, 423-431`; pinned `@anthropic-ai/claude-agent-sdk 0.3.220`,
  `package.json:51`) and intercepts the SDK's process creation
  (`src/run.ts:362-365`; `claudeSpawnSpec` from the SDK's own spawn request,
  `src/process.ts:46-61`).
- Lifecycle: one-shot per start (`src/index.ts:2-4`); teardown
  `disposeClaudeCodeChild` (`query.close()` + terminate + wait,
  `run.ts:268-299`) as run `teardown` (`run.ts:578-593`). Unattended
  policy: `persistSession: false`, tool permissions denied, dialogs
  cancelled (`run.ts:318-361`). Config: `providerName`, `env`,
  `permissionMode` (`dontAsk`/`acceptEdits`/`auto`/`plan`/`bypassPermissions`,
  default `dontAsk`), `disposeGraceMs` (`src/index.ts:38-63`).

DESKTOP-CONSUMPTION: consume unchanged.

### 9.3 Generic ACP (OpenCode feasibility)

A generic ACP subagent provider EXISTS: `@deepseek-ai/dsh-subagent-acp`
(`packages/subagent/subagent-acp`). The agent command is plain config:

```ts
Config: z.object({
  providerName: z.string().default('acp'),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  ...
```

(`src/index.ts:66-75`, documented `:27-33`). Spawn is
`[command, ...args]` over the shared subprocess seam (`src/run.ts:209-215`);
the child is driven as an ACP client via `ClientSideConnection` +
`ndJsonStream` on stdio (`src/run.ts:24, 266-272`). An arbitrary ACP agent
(e.g. `opencode acp`) is servable by setting `command`/`args` in the plugin
config (worked example:
`examples/acp-agent/tests/fixtures/subagent/subagent-acp/cordis.yml:17-26`).

Distinction: `packages/acp` is dsh's own automation-only ACP *server*;
`subagent-acp` is "the matching out-of-process subagent *client* ...
because it implements the subagent provider interface"
(`packages/acp/README.md:5-9`).

If a dedicated provider is ever preferred, the registration pattern is
established: a cordis plugin with `name`/`inject`/`Config`/`apply(ctx,
config)` ending in `ctx.subagents.registerProvider(new XProvider(...))`
(`subagent-codex/src/index.ts:113-135`; `subagent-acp/src/index.ts:173-189`);
model-facing delegation selects it by name (`agent.cordis.yml:185-222`).

DESKTOP-CONSUMPTION: consume unchanged — arbitrary ACP delegation is
config-only and host-side.

### 9.4 Ownership confirmation

The registry and dispatch live in the subagent Service Definition package
`@deepseek-ai/dsh-subagent`, class `SubagentRuntime extends Service`,
service name `'subagents'` (`packages/subagent/subagent/src/index.ts:171-184`):
`registerProvider` (duplicate-name rejection, effect-scoped, emits
`subagent/provider-added|removed`, `:385-401`); dispatch `start(name,
request)` (`:430-442`). Run ownership: `SubagentRun.dispose()` — "Cancel
remaining work, reach child quiescence" (`packages/subagent/subagent/src/types.ts:256-282`);
out-of-process handles carry memoized idempotent `dispose()`
(`packages/subagent/subagent/src/out-of-process.ts:236-249`). Providers
register only from host-plane compositions; client/UI surfaces only observe
lifecycle events (`src/index.ts:129-168`). Nothing in any client/UI package
spawns or kills external agent processes; `ctx.subprocess` in the host
process is the single kill path.

DESKTOP-CONSUMPTION: consume unchanged — the desktop-runtime host process
is a Host assembly and owns `ctx.subagents` exactly as `apps/cli` does.

---

## 10. Repository integration contract

### 10.1 Workspace membership

`pnpm-workspace.yaml:1-20` includes `vendor/*`, `packages/*/*`,
`native/landlock-run{,/packages/*}`, `apps/*` (`:9`), `website`,
`examples`, `python/sdk-runtime`. `apps/desktop` and
`apps/desktop-runtime` are auto-included once they carry a `package.json`;
no workspace edit needed. Workspace references must use the `workspace:`
protocol (`scripts/check-workspace-constraints.ts:455-467`; examples in
`apps/cli/package.json:23-84`). Flag: root `package.json:11-18` carries a
legacy `workspaces` array mirroring the same globs; `pnpm-workspace.yaml`
is authoritative.

DESKTOP-CONSUMPTION: consume unchanged.

### 10.2 TypeScript solution aggregation

- Root `tsconfig.json` is a program-less solution referencing only
  `tsconfig.host.json` and `tsconfig.client.json`; "NEVER add
  include/files entries, and NEVER flatten this solution"
  (`tsconfig.json:2-14`).
- Aggregation is an explicit per-package reference list (no wildcards —
  "TS project references have no wildcard form",
  `tsconfig.base.json:164-166`): `tsconfig.host.json:116-311`
  (`apps/cli` at `:310`), `tsconfig.client.json:40-100` (`apps/web` at
  `:99`). Test trees are included by glob, e.g. `apps/cli/tests/**/*.ts`
  (`tsconfig.host.json:91`).
- A new package ships a per-package `tsconfig.json` extending
  `tsconfig.base.json` (client packages: `tsconfig.base.client.json`),
  `rootDir: src`, `outDir: lib/types`, references to its workspace deps,
  and registers in exactly one face aggregate
  (`packages/AGENTS.md`, "Package tsconfig"; root `AGENTS.md`,
  "Keep compiler faces explicit").
- Two-face projects register in both aggregates, face by face:
  `api/remotes` at `tsconfig.host.json:142` + `tsconfig.client.json:60`,
  and the stage 4 `apps/desktop` split (Electron main/preload in
  `tsconfig.host.json`, the DSH renderer in `tsconfig.client.json`) at
  `tsconfig.host.json:311` + `tsconfig.client.json:100`. Face isolation is
  enforced by `collectProjectReferenceFaceViolations`
  (`scripts/project-reference-faces.ts:24-67`, invoked from
  `scripts/check-workspace-constraints.ts:482`).
- `DSH_BUILD_FACE` (host/client) is a tsdown env flag set by the root
  scripts (`package.json:23-24`); it gates the bundle pass
  (`tsdown.config.ts:4-8, 10-29`; client preset
  `packages/client/tsdown.client.ts:113, 192`).

DESKTOP-CONSUMPTION: minimal generic extension (mechanical) — one explicit
reference entry per new app in the face aggregate it belongs to, plus each
app's own `tsconfig.json` (Extension Surface B2).

### 10.3 Build

- `scripts/build.ts` runs: remove client build record → `build:lib` →
  `build:web` → `writeClientBuildRecord` (`scripts/build.ts:44-50`).
- Package discovery for the bundle pass is a tsdown workspace glob:
  `workspace: ['vendor/*', 'packages/*/*', 'apps/cli']`
  (`tsdown.config.ts:19`) — apps are NOT auto-built; only `apps/cli` is in
  the glob.
- Existing app build owners: `apps/cli` via the tsdown workspace
  (`apps/cli/tsdown.config.ts:9-10`); `apps/web` via root `build:web`
  (`package.json:25`) → its own `"build": "vite build"`
  (`apps/web/package.json:22-26`).
- Client build record `.dsh-build/client-build-environment.json`
  (`scripts/client-build-environment.ts:29`): `formatVersion` + public
  `DSH_CLIENT_*` environment + sha256 over artifacts matching
  `['apps/web/dist/**/*', 'packages/*/*/lib/client.js',
  'packages/*/*/lib/client.js.map']` (`:32-36, 84-92, 197-210`). It covers
  the web frontend dist and package browser bundles only;
  `apps/desktop` needs no record of its own (extension point if it ever
  embeds `DSH_CLIENT_*` values: the artifact pattern list).

DESKTOP-CONSUMPTION: consume unchanged for the convention (each app owns
its build path, `apps/web` precedent); conditional B4 for opting into the
root tsdown workspace.

### 10.4 Gates relevant to a new app package

- `scripts/check-workspace-constraints.ts` (`pnpm run constraints`):
  walks `apps` at depth 1 and only counts directories with a `package.json`
  (`:109-140`) — a docs-only `apps/desktop` (no `package.json`) is invisible
  to the gate (verified by a gate run for this document). Once
  `apps/desktop/package.json` exists, the release-member rules apply:
  `releaseMemberDirectory` classifies every `apps/*` as a published member
  (`:56`), so `"private": true` is rejected (`:289-291`),
  `publishConfig.access: "public"` is required (`:292-294`), and the
  repository field must be the upstream URL with a `directory`
  (`:295-299`). Private desktop apps therefore require a fork-level gate
  amendment (Extension Surface B1). App packages also need an
  `appPackageFiles` publication-files policy entry (`:59-64, 317-324`).
- knip: apps are scanned; `knip.json` carries per-workspace config for
  `apps/web` (`:608-628`) and `apps/cli` (`:629-642`); new apps are scanned
  by default detection unless an override is added.
- publint: `packages/*/*/package.json` only (`scripts/publint-all.ts:53`) —
  apps excluded.
- hygiene composition: `rescope-vendor:check`, knip, publint,
  constraints, license/package invariants, node-next types,
  optional-dependency imports, client packages, cordis config, runtime
  closure, vendored links (`scripts/run-gates.ts:254-260, 620-639`).
- duplication (jscpd): `packages scripts` only (`package.json:34`) — apps
  out of scope.
- lint (oxlint): applies to apps — strict overrides include
  `apps/*/src/**` and `apps/*/tests/**` (`.oxlintrc.json:38-39, 146, 193,
  212, 234`); app `*.config.ts` files are exempt (`:14-31`).
- tests: apps carry vitest suites (unit include `apps/*/tests/**/*.spec.ts`,
  `vitest.config.ts:90-95`); e2e discovery is
  `packages/*/*/tests/**/*.e2e.ts`, `apps/cli/tests/**/*.e2e.ts`,
  `examples/*/tests/**/*.e2e.ts` (`vitest.e2e.config.ts:43-45`) — a new app
  needs a config edit for its own e2e; the web lane is separate
  (`vitest.web.config.ts:26-28`). Per-file 100% coverage applies only to
  `packages/*/*/src` (`vitest.config.ts:177, 284-292`).
- CI: `ci.yml` triggers on every PR and runs the gate set
  (`.github/workflows/ci.yml:1-6, 89, 151, 236, 455`); `e2e.yml` runs
  `build:official` + `test:e2e` (`:106-120`); `expected-filenames.yml`
  triggers only on `*golden*` paths; `ci-master.yml` mirrors on master.

DESKTOP-CONSUMPTION: minimal generic extension — B1 (gate) + per-app
boilerplate; a docs-only `apps/desktop` breaks no gate.

### 10.5 Package conventions

- `apps/cli/package.json`: `name: "@deepseek-ai/dsh"` (owns the `dsh` bin),
  version locked to root, no `private`, `publishConfig.access: "public"`,
  `repository.directory: "apps/cli"`, `"type": "module"`, `bin`,
  `files: ["lib/*.js", "config"]`, deps `workspace:^` + `commander` /
  `js-yaml`; no `engines` (root-only floor, root `package.json:8-10`); no
  `scripts` block (built by the root tsdown workspace).
- `apps/web/package.json`: `name: "@deepseek-ai/dsh-web-frontend"`,
  `"type": "module"`, `exports: { "./dist/*": "./dist/*" }`,
  `files: ["dist", "!dist/**/*.map"]`, own build scripts (`vite build`),
  deps `workspace:^` + `vite`/`react`/`playwright`/`vitest`.
- Rules a new app must follow: `@deepseek-ai/dsh-<name>` naming (root
  `AGENTS.md`, "Conventions"); ESM everywhere (`"type": "module"`);
  `workspace:` protocol for internal deps; version locked to the root
  release version.

DESKTOP-CONSUMPTION: consume unchanged as convention; the private-vs-
publication conflict is B1.

---

## Desktop Extension Surface

Classification of every anticipated desktop need:

- A — existing seam, consume unchanged
- B — small generic upstream extension likely required (need + narrowest
  existing boundary only; no API designed)
- C — desktop-only implementation
- D — unknown, requires proof during implementation

### A. Existing seam — consume unchanged

| # | Need | Boundary |
| --- | --- | --- |
| A1 | Programmatic host boot without HTTP | `boot()` + profile pieces + row-disabling overlay (`packages/boot/app-boot/src/index.ts:757`; `packages/bundle/web-app/cordis.patch.yml:105-171`) |
| A2 | Settled/readiness signal | `boot()` promise / `loader.await()` (`packages/boot/app-boot/src/index.ts:751-782`) |
| A3 | In-process Request servicing | `toFetchHandler(ctx.apiProxy)` (`packages/host/apiproxy/src/fetch/handler.ts:243`) |
| A4 | Renderer API carrier (unary + respond + Typert) | `__DSH_TRANSPORT__.createApiClient` / `.fetch` (`packages/client/connection/src/client/index.ts:62-76, 113-115`) |
| A5 | Stream carrier for live events | `openMux`/`openHost` virtuals (`packages/host/apiproxy/src/fetch/client.ts:353-360`) over primitive B |
| A6 | Cancellation | `AbortSignal` on reconstructed `Request` (`packages/host/apiproxy/src/fetch/handler.ts:255-317`) |
| A7 | Approvals + user questions (push + answer) | mux frames + `POST /api/respond` (`packages/host/apiproxy/src/api-proxy.ts:1363-1429, 3594-3640`) |
| A8 | History + reconciliation | `session.history` + seq join/repair (`packages/client/runtime/src/client/sessions/session.ts:631-728`) |
| A9 | Plugin/UI boot graph + bundles | `__DSH_BOOT__` + `/plugins/<id>/client.js` bytes (`packages/client/modules/src/index.ts:241-273, 339-342`) |
| A10 | openDocument flows (general/settings/agentPreset) | wire methods + `defaults.openPath/openTextFile` (`packages/host/apiproxy/src/api-proxy.ts:596-601, 2909-2911, 3070-3095, 3171-3200`) |
| A11 | External subagents (Codex/Claude/ACP incl. OpenCode) | provider registry + config (`packages/subagent/subagent/src/index.ts:385-442`; `packages/subagent/subagent-acp/src/index.ts:66-75`) |
| A12 | Shutdown/disposal | `ctx.fiber.dispose()` (`vendor/cordis/src/fiber.ts:196`) |

### B. Small generic upstream extension likely required

| # | Need | Narrowest existing boundary |
| --- | --- | --- |
| B1 | Private desktop app packages (`apps/desktop`, `apps/desktop-runtime`) vs the release-member publication gate | fork-level amendment in `scripts/check-workspace-constraints.ts` (`releaseMemberDirectory` at `:56`; private/access/repository rules at `:289-299`; `appPackageFiles` at `:59-64`) — done when the app `package.json` files land (stage 1) |
| B2 | Typecheck aggregation for the two new apps | one explicit reference entry per app in `tsconfig.host.json` / `tsconfig.client.json` + per-app `tsconfig.json` (mechanical; faces are explicit by design, `tsconfig.base.json:164-166`) |
| B3 | (Conditional) `__DSH_BOOT__` graph provisioning with an HTTP-free host | `ClientModuleRegistry` (`packages/client/modules/src/index.ts:343-354`) — only if the renderer cannot obtain the rendered index over the transport fetch |
| B4 | (Conditional) root-workspace bundling for desktop apps | `tsdown.config.ts:19` workspace list — only if the `apps/web` "own build script" convention (A, 10.3) is not used |

### C. Desktop-only implementation

| # | Need |
| --- | --- |
| C1 | Electron shell: window, `dsh-app://` protocol, CSP, sender validation, new-window denial (stage 1) |
| C2 | Process supervisor: state machine, bundled Node spawn, `DSH_HOME` ownership, restart-on-failure, bounded shutdown (stage 2) |
| C3 | IPC transport bridge: fetch/stream wire protocol, runtime adapter, dumb main broker, renderer client (stage 3), and the desktop `AbstractApiClient` subclass (`doFetch`/`openMux`/`openHost`) (stage 4) |
| C4 | Electron `DirectoryPicker` provider package + composition override of the `directory-picker` row (stage 5) |
| C5 | `external.open`, OS notifications, file picker (no upstream seams; stages 5-7) |
| C6 | Menus, shortcuts, updater, diagnostics UI, packaging, signing (stages 7-14) |

### D. Unknown / requires proof during implementation

| # | Question | Where proven |
| --- | --- | --- |
| D1 | `__DSH_BOOT__` provisioning mode: fetch rendered index over transport vs in-process graph export (decides B3) | resolved in stage 4: the graph is the in-process export (B3), published over the child IPC before `runtime.ready`; the bundle bytes stay on the transport fetch channel (Agent Note `2026-08-25-desktop-dsh-client-boot`) |
| D2 | Backpressure/credit behavior of the process-IPC frame protocol under sustained token-rate streams (transport-internal; no upstream dependency) | resolved in stage 3: credit signaling with per-direction 256 KiB windows (Agent Note `2026-08-23-desktop-ipc-transport`) |
| D3 | `isLoopback`-gated affordances under a `dsh-app://` URL with a loopback hostname (`packages/client/connection/src/loopback-hostname.ts:14-20`) | resolved in stages 1/4: the protocol host is `127.0.0.1`, loopback to the unmodified pinned classification (Agent Note `2026-08-25-desktop-dsh-client-boot`) |
| D4 | Native-module ABI compatibility of the DSH dependency graph against the bundled standalone Node (mandatory packaging test, root `AGENTS.md` + SPEC stage 11) | stage 9/11 |

### Applied local modifications (stage 4)

The pinned source is modified in exactly three places, each guarded so the
web app's HTTP behavior is untouched (rationale in Agent Note
`2026-08-25-desktop-dsh-client-boot`):

| # | File | Change |
| --- | --- | --- |
| M1 | `packages/client/modules/src/index.ts` | `ClientModuleRegistry` injects `['loader']` only; the `/plugins` bundle route and the `webserver/index-inject` rows register only when `ctx.get('webServer')` is present — the composed graph and bundle table serve non-HTTP carriers |
| M2 | `packages/client/connection/src/index.ts` | `inject = []`; the `/api` route and the WebSocket downlinks register only when a webserver is present; the `HostConnectionService` and `createSharedFetchHandler` (in-process RPC dispatch) are provided unconditionally |
| M3 | `packages/client/connection/src/rpc-host.ts` | `register()` returns a no-op disposer when no webserver exists: a channel on a non-HTTP host is unreachable over HTTP, not an error |

---

## Stage 0 exit-criteria answers

The SPEC's stage 0 exit criteria, answered from the pinned source:

1. **How is DSH booted programmatically?**
   `boot(binName, absoluteConfigPath, patches?, prepare?)` from
   `@deepseek-ai/dsh-app-boot` (`packages/boot/app-boot/src/index.ts:757`),
   fed by `loadProfile` + the patch stack of section 1.1. The web profile is
   `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`; desktop disables
   the `webserver`/`web-runtime`/`connection` rows via an overlay and keeps
   `api-gateway`.

2. **How do client unary calls reach the host?**
   `IApiClient` domain method → `callUnary` → `doFetch(url, init)` (carrier
   — browser `globalThis.fetch`, desktop IPC) → `toFetchHandler(api).fetch`
   (in-process, `packages/host/apiproxy/src/fetch/handler.ts:243`) → method
   table → `ApiProxy` closure method. In a single process the pair is
   `new InProcessApiClient(toFetchHandler(ctx.apiProxy))`
   (`packages/host/apiproxy/src/fetch/client.ts:515-541`).

3. **How do live events reach the client?**
   `createApiProxy` pushes frames into per-connection `FrameQueue`s
   (`packages/host/apiproxy/src/api-proxy.ts:3328-3534`); the carrier
   serializes them (JSON `ServerRequest` envelopes) to the client's
   `openMux`/`openHost` generators; `ConnectionController` pumps them into
   `SessionManager`/`Session`.

4. **How are live event streams opened and carried to the client in the
   pinned source?**
   Client-side: `WebApiClient.openMux/openHost` → `readWebSocket` opens
   `ws(s)://<origin>/api/events.mux` or `/api/events.host` lazily on first
   generator iteration (`packages/client/connection/src/client/web-api-client.ts:34-90`).
   Host-side: the `client-connection` plugin upgrades the socket and pumps
   the `ApiProxy.events.*` iterable (`packages/client/connection/src/index.ts:176,
   193-194`; `packages/client/connection/src/websocket-downlink.ts:64-82`).
   GET fallbacks answer 426 (`packages/client/connection/src/index.ts:150-155`).
   Streams are strictly server→client; reconnect = reopen + refetch history
   (no cursor in v1).

5. **Which object can service a Request in-process?**
   `toFetchHandler(ctx.apiProxy).fetch` — a fetch-compatible function
   (`packages/host/apiproxy/src/fetch/handler.ts:243-247`), where
   `ctx.apiProxy` is provided by the `api-gateway` service
   (`packages/host/apiproxy/src/index.ts:33-38`) after boot settles.

6. **How does the web client obtain its plugin boot manifest and plugin
   bundles?**
   The manifest is `window.__DSH_BOOT__`, injected into the served
   `index.html` at render time by `bootInjections(graph)`
   (`packages/client/modules/src/index.ts:241-273, 343-345`); the composed
   graph is built by `ClientModuleRegistry` from the host Loader entries'
   `dsh.client` declarations (`:282-346, 429-463`). Bundles are served at
   `GET /plugins/<id>/client.js[.map]` (`:339-342, 529-565`) with CSS
   inlined per bundle (`packages/client/tsdown.client.ts:33-47`).

7. **How is shutdown awaited?**
   `await ctx.fiber.dispose()` — the root-fiber disposal promise
   (`vendor/cordis/src/fiber.ts:196`) — which also closes the webserver
   (`packages/host/webserver/src/index.ts:243-253`) and sweeps subprocess
   children (`packages/subprocess/subprocess-local/src/index.ts:47-102`).
   The CLI wraps it with a 5 s bounded `createProcessShutdown`
   (`apps/cli/src/process-shutdown.ts:22-77`).

---

## Current-vs-historical mismatches (collected)

1. `.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`
   describes an assembly package `dsh-host-runtime` and per-app
   `apps/cli/src/web.ts`; neither exists at this SHA. Assembly moved to
   bundle-based profile composition. A stale reference also survives in a
   comment: `packages/bundle/web-app/cordis.patch.yml:308`.
2. The WebSocket downlink manager lives in `packages/client/connection`
   (node half), not in `packages/host` or `packages/api`
   (`packages/host/apiproxy/src/index.ts:7-8` states apiproxy registers no
   routes).
3. Downlink direction: the SPEC/ARCHITECTURE stream framing is
   bidirectional; at this SHA DSH uses only the server→client direction
   (client messages are a protocol violation, closed with
   `1008 'downlink only'`, `packages/client/connection/src/websocket-downlink.ts:109-111`).
   The bidirectional transport capability is retained as a strict superset
   (section 3.2); no architecture change.
4. Root `package.json:11-18` duplicates the workspace globs under a legacy
   `workspaces` array; `pnpm-workspace.yaml` is authoritative.
5. `apps/*` release-member publication rules
   (`scripts/check-workspace-constraints.ts:56, 289-299`) predate private
   desktop apps; the fork amends them when the app packages land (B1).
6. `DSH_DESKTOP` (SPEC) does not exist upstream; the desktop-runtime
   introduces it as its own convention (section 1.4 note).
7. `apps/cli` carries no `engines` field; the Node floor is root-only
   (root `package.json:8-10`).
8. `pnpm run rescope-vendor:check` (part of `pnpm run hygiene`) fails at the
   pin itself, with two stale `EXACT_EDITS` in `scripts/rescope-vendor.ts`
   (`knip-logger-console` pointing at a knip.json block for the long-gone
   `packages/util/home` package, and `vendoring-cookbook-name-invariant-zh`
    pointing at a moved docs/cookbook block). Verified by running the check
    in a clean detached worktree of the pin. Pre-existing upstream defect
    in a gate the stage 0.2 pass did not exercise; out of desktop scope,
    fork-level fix deferred.
