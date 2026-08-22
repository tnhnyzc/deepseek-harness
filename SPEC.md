# DeepSeek Harness Desktop — Implementation Specification

## 0. Mission

Build a production-quality cross-platform desktop application for DeepSeek Harness.

The application MUST be a **desktop client and host environment for DeepSeek Harness**, not a new agent harness.

DeepSeek Harness remains authoritative for:

- agent execution
- model adapters
- tools
- skills
- sessions
- session event logs
- approval semantics
- sandboxing
- subagents
- credentials/configuration
- cancellation
- persistence
- plugin lifecycle

The desktop application owns only:

- application/window lifecycle
- desktop process supervision
- renderer delivery
- IPC transport
- operating-system capabilities
- native menus/shortcuts
- updater/release integration
- desktop-specific UX extensions

### Architectural invariant

There must be exactly **one owner of agent semantics: DeepSeek Harness**.

Do not recreate DSH entities as desktop-specific equivalents.

In particular, DO NOT create parallel abstractions such as:

- `DesktopSession`
- `DesktopAgent`
- `DesktopTool`
- `DesktopApproval`
- `DesktopModel`
- `DesktopConversation`

Use DSH's existing client and host interfaces directly.

---

# 1. Technology decision

Use:

- Electron for the desktop shell.
- Existing DeepSeek web/client packages for the renderer.
- A separately bundled, standalone Node.js runtime for the DSH host process.
- DeepSeek's existing Cordis/plugin architecture.
- DeepSeek's current client/host communication plane interfaces. In the
  current pinned revision this is the apiproxy/host communication plane;
  upstream terminology (Remote, Typert, Gateway) may evolve. The upstream
  contract document must identify the actual source implementation.
- IPC as a generic transport layer between renderer and DSH host, with two
  primitives: a Fetch-compatible request/response transport and an opaque
  bidirectional stream transport.
- Electron main process as a narrow broker and OS-integration process.

Do NOT use:

- OpenCode as the primary runtime.
- Codex app-server as the primary runtime.
- an additional generic agent framework.
- a bespoke REST API.
- a desktop-owned agent protocol.
- a localhost HTTP server in the final product.
- Electron's renderer-side Node integration.
- Electron itself as the Node executable used to host DSH.

---

# 2. Why the Node runtime is separate

Do not execute the Harness host directly inside the Electron main process.

Do not rely on Electron's `process.execPath` as if it were an ordinary Node executable.

Package a normal Node runtime matching the Node version required by the pinned DeepSeek Harness revision.

The topology shall be:

```text
Electron renderer
      │
      │ MessagePort
      ▼
Electron main
      │
      │ child_process IPC
      ▼
standalone Node
      │
      ▼
DeepSeek Harness
```

Reasons:

1. DSH and its ecosystem can contain Node-native dependencies.
2. Agent tools may require ordinary Node runtime behavior.
3. DSH subagent providers can launch Node-based wrappers.
4. Electron upgrades should not change the ABI/runtime used by the Harness.
5. A DSH crash must not crash the Electron main process.
6. Desktop releases need an independently pinnable:
   - Electron version
   - Node version
   - DSH revision

The Electron main process is therefore a **supervisor**, not the Harness runtime.

---

# 3. Repository strategy

## Decision: the repository is a fork

The desktop application repository is a fork of
`deepseek-ai/deepseek-harness`.

The desktop application develops inside the Harness monorepo. Do not build
the application as an unrelated repository which imports random internal
package paths from the npm release.

## Fork model

```text
upstream remote   deepseek-ai/deepseek-harness
desktop fork      this repository
pinned commits    the exact Harness commits each desktop build consumes
```

- The upstream remote tracks `deepseek-ai/deepseek-harness`.
- Desktop work lands in the fork. The desktop delta is the diff between
  the pinned upstream commit and the desktop release commit.
- Each release pins an exact upstream commit (see #4).
- The upstream observation workflow is defined in #30.

## Rejected: standalone repository with a submodule

A standalone desktop repository that embeds the monorepo as a submodule or
vendored checkout is rejected. The desktop application needs full workspace
membership (package resolution, TypeScript program roots, repository
gates), and submodule bookkeeping would duplicate the pinning that the fork
already records.

## Structure

```text
deepseek-harness/          # desktop fork
├── apps/
│   ├── cli/
│   ├── web/
│   ├── desktop/
│   │   ├── package.json
│   │   ├── forge.config.ts
│   │   ├── src/
│   │   │   ├── main/
│   │   │   │   ├── index.ts
│   │   │   │   ├── window.ts
│   │   │   │   ├── supervisor.ts
│   │   │   │   ├── runtime-channel.ts
│   │   │   │   ├── native-capabilities.ts
│   │   │   │   ├── protocol.ts
│   │   │   │   ├── updater.ts
│   │   │   │   └── security.ts
│   │   │   ├── preload/
│   │   │   │   └── index.ts
│   │   │   └── renderer/
│   │   │       ├── main.ts
│   │   │       ├── desktop-transport.ts
│   │   │       └── desktop-environment.ts
│   │   └── resources/
│   │
│   └── desktop-runtime/
│       ├── package.json
│       └── src/
│           ├── main.ts
│           ├── boot.ts
│           ├── ipc-fetch-handler.ts
│           ├── ipc-stream-bridge.ts
│           ├── native-provider.ts
│           └── shutdown.ts
│
└── ...
```

## Repository integration requirements

Because the desktop develops inside the monorepo, every desktop change
must continue passing the repository's existing gates:

```text
- pnpm workspace checks
- TypeScript solution builds (host and client aggregates)
- lint
- typecheck
- unit tests
- GUI tests
- hygiene checks
```

A desktop stage is not complete while it leaves any of these red.

Do not initially extract desktop IPC into reusable `packages/*`.

Keep desktop-specific carrier code application-private while DSH's API/Connection migration is still changing rapidly.

Only extract it into a package after:

1. the implementation works;
2. transport seams are stable;
3. duplication appears;
4. or upstream explicitly wants the carrier as a reusable package.

---

# 4. Version pinning and build identity

Every desktop release MUST contain a build manifest.

Example conceptual shape:

```ts
interface DesktopBuildIdentity {
  desktopVersion: string
  deepseekHarnessCommit: string
  deepseekHarnessVersion: string
  nodeVersion: string
  electronVersion: string
  desktopProtocolVersion: number
  platform: string
  arch: string
}
```

Expose this information in:

**Settings → About → Runtime Details**

Do not resolve DeepSeek Harness dynamically at application startup.

Do not run:

```text
npx @deepseek-ai/dsh@latest
```

from the packaged application.

The runtime dependency closure must be part of the application release.

---

# 5. Stage 0 — Freeze and understand the upstream contract

## Task 0.1 — Pin upstream

Select one exact DeepSeek Harness commit.

Record:

- commit SHA
- package versions
- Node engine requirement
- pnpm version
- existing test status

Commit a file:

```text
UPSTREAM.md
```

containing:

- upstream repository
- upstream SHA
- date pinned
- desktop patches, if any
- known incompatibilities

## Task 0.2 — Establish untouched baseline

Before adding desktop code:

1. install dependencies;
2. build the repository;
3. run upstream tests;
4. launch the existing `dsh web`;
5. create a session;
6. select a workspace;
7. submit a prompt;
8. verify streaming;
9. exercise a tool;
10. exercise an approval and answer it;
11. exercise a user-question prompt (question/requested) and answer it;
12. cancel an active turn;
13. restart DSH;
14. reopen the session.

Store this as the baseline integration test.

## Task 0.3 — Locate the current official seams

At the pinned SHA, identify and document:

- application/profile boot entry point;
- settled/ready condition;
- Host Context;
- client Connection implementation;
- FetchHandler/API route handler;
- the actual client communication plane implementation (the
  apiproxy/host plane in the current pinned source; upstream
  terminology such as Remote or Typert may not name it);
- session event transport: how live event streams are opened and
  carried to the client in the pinned source (websocket-style
  downlinks in the current revision);
- web client startup entry;
- UI plugin loader;
- plugin boot artifacts: how `__DSH_BOOT__` is generated, how
  plugin manifests are discovered, and how plugin bundles are
  served;
- directory picker capability;
- document-opening flows (openDocument, settings documents,
  agent preset documents);
- shutdown/disposal API.

Do not rely on historical architecture notes when current source differs.

Create:

```text
apps/desktop/docs/upstream-contract.md
```

with direct source paths and exported symbols.

The contract document must identify the actual source implementation of
each seam. It must not rely on the names that historical architecture
notes or upstream terminology use for them.

### Stage 0 exit criteria

Desktop implementation does not begin until the agent can state exactly:

```text
How is DSH booted programmatically?
How do client unary calls reach the host?
How do live events reach the client?
How are live event streams opened and carried to the client in
the pinned source?
Which object can service a Request in-process?
How does the web client obtain its plugin boot manifest and plugin
bundles?
How is shutdown awaited?
```

---

# 6. Stage 1 — Electron shell

Implement the Electron application without agent-specific functionality.

## Task 1.1 — Main process

Create one `BrowserWindow`.

Required security properties:

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
webSecurity = true
```

Do not expose Electron APIs directly.

Disable arbitrary navigation.

Reject new-window requests by default.

External URLs may be opened only after validating that:

```text
protocol === "https:" || protocol === "http:"
```

Never pass arbitrary strings directly to `shell.openExternal()`.

## Task 1.2 — Application protocol

Register:

```text
dsh-app://
```

as the application's private frontend protocol.

Serve only files underneath the packaged renderer distribution directory.

Prevent:

- `..` traversal;
- absolute filesystem paths;
- access outside renderer dist;
- arbitrary local file reads.

The main application page should be something equivalent to:

```text
dsh-app://app/index.html
```

Relative frontend assets must work.

Do not use `file://` in the released application.

## Task 1.3 — Renderer

The renderer entry must remain thin.

Its job is to start the existing DSH client application tree using the same client packages as the browser Web UI.

Do not copy Web UI components into `apps/desktop`.

Do not fork conversation UI, sidebar UI, trajectory UI, etc.

Desktop-specific presentation changes must later be introduced through existing UI slots/plugins where possible.

### Stage 1 exit criteria

The application launches to a local packaged renderer with:

- no network dependency;
- no Node in the renderer;
- no Harness runtime yet;
- valid CSP;
- no Electron security warnings caused by application configuration.

---

# 7. Stage 2 — Standalone Harness runtime

Implement `apps/desktop-runtime`.

## Task 2.1 — Bundle Node

Read the pinned DSH revision's actual Node requirement.

Download/build against one exact compatible Node release for each target:

```text
darwin-arm64
darwin-x64
win32-x64
linux-x64
```

Add other architectures only when explicitly supported.

The Node executable is a packaged resource.

At build time verify its checksum.

Do not download Node on first application launch.

## Task 2.2 — Spawn runtime

Electron main launches:

```text
<bundled-node> <desktop-runtime-entry>
```

Use an IPC-capable `child_process` configuration.

Electron main supplies only required environment variables.

Include:

```text
DSH_DESKTOP=1
DSH_HOME=<desktop-managed-home>
```

Do not pass secrets through command-line arguments.

## Task 2.3 — DSH home

Default desktop Harness state to an application-owned directory, for example conceptually:

```text
<AppUserData>/harness/
```

Do not automatically reuse an existing CLI `~/.dsh` directory.

Reasons:

- desktop releases pin specific Harness versions;
- CLI and Desktop may otherwise run different schema revisions;
- concurrent access semantics must not be assumed;
- desktop upgrades must be reversible.

Later provide:

**Settings → Harness Data → Import Existing Harness Configuration**

and optionally an advanced setting:

**Use external DSH_HOME**

with a warning.

Workspace directories themselves remain the user's real directories and are never copied into DSH_HOME.

## Task 2.4 — Programmatic DSH startup

Boot DSH through its programmatic application/profile composition.

Do NOT launch `dsh web`.

Do NOT start the web server.

Do NOT parse stdout looking for:

```text
Listening on ...
```

Do NOT consider the runtime ready merely because a TCP port opened.

Wait until the actual Cordis/DSH boot operation has settled successfully.

Then emit:

```ts
{
  type: "runtime.ready",
  runtimeVersion: ...,
  dshVersion: ...,
  capabilities: ...
}
```

over process IPC.

## Task 2.5 — Runtime state machine

Electron main owns:

```text
stopped
starting
ready
stopping
failed
```

Transitions must be explicit.

Illegal transitions throw during development.

The BrowserWindow may exist while runtime state is `starting`.

The UI must show a proper startup state rather than freezing.

## Task 2.6 — Runtime failure

If the child exits unexpectedly:

1. mark runtime `failed`;
2. terminate any communication channels;
3. reject all pending client requests;
4. retain recent stderr/log diagnostics;
5. present a recoverable error screen;
6. offer `Restart Harness`.

Do not silently restart an active Harness repeatedly.

One automatic retry is acceptable only if the runtime fails before reaching `ready`.

## Task 2.7 — Shutdown

On application quit:

1. stop accepting renderer requests;
2. send `runtime.shutdown`;
3. invoke the normal DSH/Cordis shutdown path;
4. await disposal;
5. wait for child exit;
6. if child refuses graceful shutdown, terminate it;
7. ensure descendants are not left running.

Test this specifically with Codex/Claude/subagent processes and shell tools.

### Stage 2 exit criteria

Electron can:

- launch the standalone Harness runtime;
- identify true readiness;
- stop it cleanly;
- detect runtime death;
- restart after failure.

There is still no localhost web server.

---

# 8. Stage 3 — The IPC transport layer (Fetch + Stream)

This is the central architectural task.

Do not create desktop methods like:

```text
sessionCreate
sessionPrompt
listModels
approveTool
```

Instead create a **generic IPC transport layer** with two primitives.

## Primitive A — Fetch-compatible request/response transport

Carries normal API calls: configuration, commands, queries, and
responses (including streamed response bodies).

The existing DSH client code should believe it is making normal
Fetch-compatible requests.

## Primitive B — Opaque bidirectional stream transport

Carries live event streams, realtime updates, websocket-style
communication, and future streaming APIs.

The pinned DSH revision serves its live downlinks as websocket-style
streams, not Fetch responses, so this primitive is required for
functional equivalence.

It transports generic ordered frames:

```text
stream.open(streamId)
stream.frame(streamId, bytes)
stream.close(streamId)
```

The stream transport MUST remain business-logic agnostic. It must not
expose concepts such as:

```text
session stream
approval stream
tool stream
agent stream
```

Stream identifiers and frame bytes are opaque to every desktop layer.
Which streams exist and what their frames mean is decided entirely by
the DSH client and the DSH runtime.

## Desired flow

```text
primitive A: fetch
DSH client package
       │
       │ Request
       ▼
desktopFetch()
       │
       │ desktop IPC frames
       ▼
Electron main
       │
       │ transparent relay
       ▼
desktop-runtime
       │
       │ reconstruct Request
       ▼
DSH fetch handler / host communication plane
       │
       │ Response
       ▼
desktop-runtime
       │
       │ response IPC frames
       ▼
Electron main
       │
       ▼
desktopFetch()
       │
       ▼
DSH client package

primitive B: stream
DSH client package
       │
       │ stream.open(streamId)
       ▼
Electron main
       │
       │ transparent relay
       ▼
desktop-runtime
       │
       │ attach stream to a host event downlink
       ▼
DSH event downlink pushes frames
       │
       │ stream.frame(streamId, bytes)  (server to client)
       ▼
Electron main
       │
       ▼
DSH client package
```

The transport MUST NOT understand:

- sessions;
- agents;
- models;
- tools;
- approvals or user questions;
- host communication plane methods;
- command names;
- stream semantics.

If a new DSH host-plane method or a new event stream is added upstream,
the desktop transport should require **zero changes**.

That is the most important acceptance test for this layer.

The desktop transport moves Harness protocols; it does not define
Harness protocols.

---

# 9. Desktop transport protocol

Define one private transport protocol with two message families: the
Fetch request/response family (primitive A) and the opaque bidirectional
stream family (primitive B).

Example:

```ts
type DesktopTransportMessage =
  | FetchOpen
  | FetchRequestChunk
  | FetchRequestEnd
  | FetchAbort
  | FetchResponseHead
  | FetchResponseChunk
  | FetchResponseEnd
  | FetchError
  | StreamOpen
  | StreamOpenAck
  | StreamFrame
  | StreamClose
  | StreamError
```

Every fetch request has a unique `requestId`.
Every stream has a unique `streamId`, minted by the opener.

## Request start

```ts
interface FetchOpen {
  type: "fetch.open"
  requestId: string
  url: string
  method: string
  headers: Array<[string, string]>
}
```

## Request streaming

```ts
interface FetchRequestChunk {
  type: "fetch.request.chunk"
  requestId: string
  sequence: number
  data: Uint8Array
}

interface FetchRequestEnd {
  type: "fetch.request.end"
  requestId: string
}
```

## Cancellation

```ts
interface FetchAbort {
  type: "fetch.abort"
  requestId: string
  reason?: string
}
```

The renderer's `AbortSignal` MUST propagate to DSH.

Cancellation is not optional.

## Response start

```ts
interface FetchResponseHead {
  type: "fetch.response.head"
  requestId: string
  status: number
  statusText: string
  headers: Array<[string, string]>
}
```

## Response body

```ts
interface FetchResponseChunk {
  type: "fetch.response.chunk"
  requestId: string
  sequence: number
  data: Uint8Array
}

interface FetchResponseEnd {
  type: "fetch.response.end"
  requestId: string
}
```

## Error

```ts
interface FetchError {
  type: "fetch.error"
  requestId: string
  code: string
  message: string
}
```

Do not serialize stack traces to the renderer by default in production.

## Stream open

```ts
interface StreamOpen {
  type: "stream.open"
  streamId: string
  url: string
}

interface StreamOpenAck {
  type: "stream.open.ack"
  streamId: string
  ok: boolean
  reason?: string
}
```

`url` identifies the stream endpoint as the DSH client names it. The
transport does not parse it.

## Stream frames

```ts
interface StreamFrame {
  type: "stream.frame"
  streamId: string
  sequence: number
  data: Uint8Array
}
```

`sequence` increases monotonically per stream. Frame bytes are opaque.
Reordering is forbidden. Frames flow in both directions between a DSH
client and a DSH runtime; the transport carries either direction without
distinguishing them.

## Stream close

```ts
interface StreamClose {
  type: "stream.close"
  streamId: string
  reason?: string
}
```

Closes the stream after in-flight frames settle.

## Stream error

```ts
interface StreamError {
  type: "stream.error"
  streamId: string
  code: string
  message: string
}
```

Do not serialize stack traces to the renderer by default in production.

## Stream agnosticism

The stream vocabulary above is the entirety of what the transport knows
about streams. No message names or constrains stream semantics. A new DSH
stream is transported without any desktop change.

---

# 10. Streaming requirements

The IPC transport must support indefinitely long streaming on both
carriers.

The stream carrier is required for:

- session events;
- token streams;
- host events;
- future streaming APIs.

The Fetch carrier is required for long-lived streamed response bodies
(session-artifact downloads and any future streamed unary response).

Do not buffer an entire Response, or an entire stream, before delivering
it.

`desktopFetch()` must construct a real browser `Response` whose body is backed by a `ReadableStream`.

Conceptually:

```text
fetch.response.head
    ↓
new Response(readableStream, metadata)
    ↓
fetch.response.chunk
    ↓
controller.enqueue(...)
    ↓
fetch.response.end
    ↓
controller.close()
```

Implement bounded buffering.

Do not permit an unbounded array of token chunks in Electron main.

Use:

- fixed maximum chunk size;
- a per-request and per-stream high-water mark;
- process IPC send backpressure;
- pause/resume or credit signaling if required.

Target transport semantics, not maximum throughput.

Agent token streams are low-bandwidth enough that correctness matters more than micro-optimization.

---

# 11. Electron main must be a dumb broker

For DSH Fetch traffic, Electron main must not:

- decode JSON business payloads;
- inspect host communication plane method names;
- alter SessionEvents;
- interpret approval events;
- know model IDs;
- cache Harness responses.

It may inspect only transport metadata necessary for:

- routing;
- lifecycle;
- size limits;
- cancellation;
- diagnostics.

This ensures:

```text
renderer/client API changes
         ≠
desktop main changes
```

---

# 12. Stage 4 — Connect the real DSH renderer

Replace the Web client's browser carrier with the desktop transport:
`desktopFetch()` for request/response and the stream carrier for live
downlinks.

Do this at the lowest intended transport seam in the current pinned DSH
client communication plane (Connection package).

Do not monkey-patch `window.fetch` globally unless the upstream client gives no injection seam.

Preferred order:

1. inject a Fetch-compatible transport and stream carrier into the
   client Connection;
2. create a desktop Connection transport/provider;
3. minimally extend the upstream Connection carrier abstraction;
4. global fetch interception only as a temporary diagnostic fallback.

If an upstream modification is required, make the smallest generic change possible:

```text
Connection accepts a Fetch-compatible transport and a stream carrier
```

rather than:

```text
Connection understands Electron
```

Electron knowledge belongs only in the desktop app.

---

# 13. Renderer boot

When renderer starts:

```text
1. renderer initializes
2. receive desktop transport port
3. wait for runtime.ready
4. instantiate desktop transport adapters (fetch + stream)
5. initialize DSH client Connection
6. initialize Cordis client/plugin tree
7. render normal DSH application
```

Do not mount a fake UI while DSH initializes and then replace the entire React tree.

Maintain one application root.

Startup states should be regular application states:

```text
booting desktop
starting Harness
loading client plugins
ready
runtime failed
```

---

# 14. Stage 5 — Native desktop capabilities

Native behavior must follow the same rule as everything else:

**provide a capability; do not bypass Harness.**

## Directory picker

DSH already has a host directory-picker capability seam.

Implement an Electron-backed provider.

Flow:

```text
DSH host asks directory-picker provider
        ↓
desktop-runtime sends native.request
        ↓
Electron main
        ↓
dialog.showOpenDialog()
        ↓
native.response
        ↓
DSH provider resolves result
```

The renderer must NOT directly call Electron's directory picker and then mutate Harness state behind its back.

The Harness owns the operation.

## Allowed native capability registry

Start with an explicit closed set such as:

```ts
type NativeMethod =
  | "directory.pick"
  | "file.pick"
  | "path.reveal"
  | "external.open"
  | "notification.show"
  | "document.open"
  | "settings.document.open"
  | "agentPreset.document.open"
```

The document-opening flows mirror the privileged `*openDocument` flows in
the pinned DSH (settings documents and agent preset documents). They enter
through this registry, never through arbitrary renderer calls. They are
required, not speculative: the pinned DSH client surfaces them as part of
settings and agent preset management.

Every native method has:

- validated request schema;
- validated response schema;
- cancellation behavior;
- explicit permissions.

Do not create:

```ts
native.call(method: string, payload: any)
```

with arbitrary method access from the renderer.

## Credentials

Do not create a second API-key database in Electron.

DSH credential/configuration services remain authoritative.

If OS Keychain integration is later desired, implement it as a DSH credential-store provider/plugin so that CLI semantics and desktop semantics remain coherent.

---

# 15. Stage 6 — Preserve DSH's existing user experience first

For the first functional version, use the existing DSH UI substantially unchanged.

Required functionality:

- session list;
- new session;
- session rename;
- workspace selection;
- conversation rendering;
- streaming responses;
- trajectory/tool rendering;
- approval and user-question handling (both are answerable runtime
  interaction events);
- cancellation;
- model/provider settings;
- profile/settings access;
- session recovery after restart.

Do not immediately redesign the interface.

First demonstrate that Desktop is semantically equivalent to `dsh web`.

Only then add desktop UX.

---

# 16. Stage 7 — Desktop UX

After functional equivalence, add desktop-specific value.

## Window chrome

Provide:

- native title bar strategy appropriate to each OS;
- native close/minimize/maximize;
- macOS traffic-light integration;
- sensible Windows/Linux title-bar behavior.

Keep this separate from DSH content components.

## Native menu

Implement:

### File

```text
New Session
Open Workspace…
Close Window
```

### Edit

Use standard platform editing roles.

### View

```text
Toggle Sidebar
Zoom In
Zoom Out
Reset Zoom
Developer Tools [development builds only]
```

### Session

```text
New Session
Cancel Current Run
Rename Session
```

### Help

```text
DeepSeek Harness Documentation
View Runtime Logs
About
```

Actions that affect Harness state should dispatch to the existing DSH client service rather than another main-process API.

## Keyboard shortcuts

Use platform-native conventions:

```text
Cmd/Ctrl+N      new session
Cmd/Ctrl+O      open workspace
Cmd/Ctrl+K      command palette if supported
Cmd/Ctrl+,      settings
Cmd/Ctrl+\      toggle sidebar
Esc             cancel/dismiss according to existing UI semantics
```

Do not make global keyboard shortcuts unless genuinely needed.

---

# 17. Runtime diagnostics UI

Add a developer-oriented runtime page.

Display:

```text
Desktop version
Electron version
Node runtime version
DSH version
DSH commit
runtime PID
runtime state
DSH_HOME
active workspace
renderer/client status
IPC transport status
```

Offer:

```text
Open Runtime Logs
Copy Diagnostics
Restart Harness
Open Data Directory
```

Never include credentials or API keys in copied diagnostics.

---

# 18. Logging architecture

Create three clearly identified streams:

```text
desktop-main
desktop-runtime
dsh
```

Every entry should include:

```text
timestamp
component
level
message
```

Transport diagnostics may include:

```text
requestId
streamId
duration
response status
bytes transferred
cancelled?
```

Do NOT log:

- prompts by default;
- API keys;
- Authorization headers;
- environment secrets;
- model responses;
- attachment contents.

Development builds may support an explicitly enabled verbose protocol logger.

---

# 19. OpenCode decision

OpenCode is NOT a dependency of the desktop application.

Do not use:

```text
OpenCode server
       ↓
DeepSeek desktop
       ↓
DeepSeek Harness
```

and do not use:

```text
DeepSeek UI
       ↓
OpenCode SDK
       ↓
OpenCode agent
```

as the normal runtime.

This creates two competing harnesses.

## Optional future OpenCode integration

OpenCode supports ACP.

Therefore, if OpenCode interoperability is desired later, implement it as a **subagent provider**.

Conceptually:

```text
DeepSeek Harness
      │
      │ subagent
      ▼
OpenCode ACP provider
      │
      ▼
opencode acp
```

Requirements:

- DSH remains parent run owner;
- DSH selects cwd;
- DSH controls cancellation;
- provider owns child process lifecycle;
- child produces one delegated result;
- OpenCode does not become parent session persistence;
- no OpenCode frontend is embedded;
- no OpenCode server is exposed to the renderer.

First investigate whether DSH's existing generic ACP subagent facility can spawn OpenCode directly.

Only write a dedicated:

```text
dsh-subagent-opencode
```

provider if generic ACP cannot express the required lifecycle cleanly.

---

# 20. Codex decision

Do not add a desktop-specific Codex backend.

DeepSeek Harness already contains its own Codex subagent backend using:

```text
codex app-server --stdio
```

The Desktop app merely exposes/configures that existing Harness feature.

Do not establish a second persistent Codex app-server managed by Electron main.

Do not make the renderer speak the Codex Thread/Turn protocol.

The path is:

```text
Desktop UI
    ↓
DeepSeek Harness
    ↓
DSH subagent registry
    ↓
dsh-subagent-codex
    ↓
Codex app-server
```

This guarantees there is still one orchestration owner.

---

# 21. Claude Code and future external agents

Apply the same rule.

Every external agent should appear behind a DSH provider/plugin boundary.

The desktop application must not gain special cases such as:

```ts
if (engine === "codex") ...
if (engine === "claude-code") ...
if (engine === "opencode") ...
```

Those distinctions belong to DSH configuration.

The renderer should ask Harness:

```text
what providers/capabilities are available?
```

rather than maintaining its own provider registry.

---

# 22. Stage 8 — Session and event correctness

This requires dedicated testing because DSH is event-log based.

Interaction events — approval requests and question/requested user
prompts — are both answerable runtime interaction events. Both appear in
every stage of this spec wherever approvals are listed.

Verify:

1. existing session loads;
2. historical events fold into correct UI;
3. live stream attaches;
4. no event disappears between history fetch and subscription;
5. assistant streaming renders incrementally;
6. finalized messages replace partial state correctly;
7. disconnect/reconnect rebuilds state correctly;
8. pending state for approval and user-question interaction events survives renderer reload where Harness supports it;
9. cancelled run terminates streaming;
10. application restart correctly reconstructs persisted sessions.

The desktop transport must preserve exact event ordering on both carriers
(fetch streamed responses and stream frames).

Never coalesce semantically separate DSH events merely to improve rendering performance.

UI rendering may batch React updates, but the client state layer must observe events in order.

---

# 23. Stage 9 — Runtime crash recovery

Test a real runtime crash during:

- idle;
- model generation;
- tool execution;
- shell command;
- approval or user-question wait;
- subagent execution.

After a runtime failure:

```text
Renderer remains alive.
Current transport becomes disconnected.
All pending requests reject deterministically.
UI displays runtime failure.
Logs remain accessible.
User can restart runtime.
Client reconnects from persisted state.
```

Do not pretend an interrupted agent turn finished successfully.

Do not synthesize missing session events.

Let DSH's persisted log determine the recovered state.

---

# 24. Stage 10 — Security hardening

## Renderer

Must use:

```text
nodeIntegration: false
contextIsolation: true
sandbox: true
webSecurity: true
```

Use a strict CSP.

No remote JavaScript.

No arbitrary `eval`.

No unrestricted navigation.

No arbitrary `<webview>` usage.

## Preload

Expose the minimum possible surface.

Preferred renderer transport bootstrap:

```text
preload receives MessagePort
        ↓
preload transfers restricted port to trusted renderer
```

Do not expose:

```ts
window.electron = ipcRenderer
```

Do not expose generic:

```ts
window.send(channel, data)
```

## Electron main

Validate the sender of every renderer-initiated message: fetch requests,
stream opens, stream frames, and capability requests alike.

Validate every privileged argument.

Default-deny permission requests.

## Runtime

The DSH runtime is intentionally powerful—it operates on user workspaces and executes tools.

Do not confuse Chromium sandboxing with the Harness execution sandbox.

Do not replace or weaken DSH approval/sandbox policy.

## Final networking requirement

The normal desktop application must bind **zero TCP ports**.

The browser `dsh web` server remains an independent CLI capability and is not needed by Desktop.

---

# 25. Stage 11 — Packaging

A packaged application contains:

```text
Electron runtime
desktop main/preload/renderer
DSH frontend assets
desktop-runtime bundle
DeepSeek Harness runtime packages
standalone Node executable
required native modules/binaries
license notices
build manifest
```

The user must not need:

```text
Node
npm
pnpm
DeepSeek Harness CLI
OpenCode
Codex CLI
```

installed merely to start Desktop.

Optional external integrations may have their own rules, but first-party DSH packages that already bundle their dependencies should remain self-contained.

---

# 26. Native modules

Discover all native Node modules reachable from the actual DSH production dependency graph.

For each target platform:

1. build/install them against the standalone bundled Node ABI;
2. package the correct native artifact;
3. start DSH in packaged form in CI;
4. exercise at least one feature that loads each critical native module.

Do not assume a development-machine `node_modules` proves packaged compatibility.

This test is mandatory.

---

# 27. Release security

macOS:

- sign all binaries;
- sign bundled Node;
- sign helper/runtime files correctly;
- notarize final application;
- verify Gatekeeper behavior on a clean machine.

Windows:

- sign executables/installers;
- verify child Node process launches from installed path;
- verify process-tree cleanup.

Linux:

- produce chosen release formats;
- test under at least one clean mainstream distribution;
- verify executable resource permissions survive packaging.

---

# 28. Updater

Desktop updater owns only the **whole application release**.

Never update DSH independently inside an installed release.

A release moves atomically from:

```text
Desktop A
Electron A
Node A
DSH commit A
```

to:

```text
Desktop B
Electron B
Node B
DSH commit B
```

This preserves a tested compatibility matrix.

Before applying updates:

- preserve user data;
- do not touch workspaces;
- retain migration compatibility;
- allow a failed new runtime to present useful diagnostics.

---

# 29. Stage 12 — Test architecture

Create four layers of tests.

## A. Unit tests

Cover:

- supervisor state machine;
- transport request IDs and stream IDs;
- stream sequencing and ordering;
- response reconstruction;
- abort propagation;
- streaming (fetch responses and stream frames);
- IPC backpressure;
- malformed messages;
- native capability validation;
- path traversal prevention;
- external URL validation.

## B. Runtime integration tests

Boot the real pinned DSH runtime.

Test:

```text
boot
ready
basic host-plane call
session create
session history
prompt
stream
cancel
shutdown
```

Do not mock DSH in this tier.

## C. Desktop integration tests

Start Electron and real desktop-runtime.

Verify:

```text
renderer → IPC → DSH → IPC → renderer
```

No localhost server may exist.

## D. End-to-end tests

Use Playwright Electron support or equivalent.

Test the actual user path:

```text
launch application
→ configure model
→ choose workspace
→ create session
→ submit prompt
→ receive streaming response
→ run tool
→ handle an approval and answer a user prompt
→ cancel another run
→ quit
→ reopen
→ restore session
```

---

# 30. Upstream compatibility CI

Because DSH is changing rapidly, maintain two CI tracks.

## Release track

Build/test only against the pinned commit.

This is authoritative.

## Upstream observation track

Periodically test the desktop patch against current upstream `master`.

Failure here does NOT break the released desktop.

It reports:

```text
upstream-compatible
upstream-needs-adaptation
```

When updating DSH:

1. select new SHA;
2. inspect upstream architectural changes;
3. update `upstream-contract.md`;
4. run full test suite;
5. manually test agent/tool/approval flows;
6. then change the pinned SHA.

Never auto-merge an upstream Harness update into a desktop release.

---

# 31. Architectural boundary tests

Add tests whose sole purpose is preventing future architectural decay.

Fail CI if Electron main imports:

- DSH agent loop implementation;
- Session internals;
- model providers;
- tool implementation packages.

Fail CI if renderer imports:

- `electron`;
- Node built-ins;
- DSH host runtime packages.

Fail CI if desktop transport contains literals for business RPCs such as:

```text
session.prompt
session.create
approval...
question...
model...
tool...
```

Fail CI if the desktop transport names stream semantics — no
session/approval/tool/agent stream identifiers, no business names for
streams.

The transport is generic.

Fail CI if a localhost HTTP listener is created by Desktop production code.

---

# 32. Stage 13 — Performance targets

Desktop transport overhead should be essentially invisible compared with model latency.

Measure:

### Unary latency

For 10,000 small local round trips, record:

- p50
- p95
- p99

The objective is correctness first; local IPC should remain comfortably sub-human-perceptual.

### Streaming

Feed synthetic token events at rates substantially higher than realistic model output.

Verify:

- stable memory;
- no event reordering;
- no unbounded queue;
- no renderer starvation.

### Long-running session

Run a synthetic session with tens of thousands of events.

Verify:

- session loading;
- scrolling;
- memory;
- restart;
- live subscription.

Do not optimize transport by violating DSH event semantics.

---

# 33. Stage 14 — Product polish

Only after all core architecture stages pass:

Add:

- recent workspaces;
- dock/taskbar recent items;
- native notifications for long-running completed tasks;
- drag-and-drop workspace opening;
- OS-level file association if useful;
- application update UI;
- crash diagnostics;
- command palette enhancements;
- desktop-specific settings section.

Implement these as additive features.

Do not fork the basic DSH conversation engine/UI unless upstream limitations make it necessary.

---

# 34. What NOT to build

Explicitly reject the following architectural directions.

## Do not build a new backend API

Wrong:

```text
Electron → Express → custom SessionService → DeepSeek
```

Correct:

```text
DSH client → generic IPC transport (Fetch + Stream) → existing DSH host API
```

## Do not embed OpenCode underneath DSH

Wrong:

```text
DSH UI → OpenCode SDK → OpenCode → model
```

## Do not replace DSH with Codex app-server

Wrong:

```text
Desktop → Codex app-server
        → somehow call DSH tools
```

## Do not run the browser server forever

Wrong final architecture:

```text
Electron BrowserWindow
      ↓
http://127.0.0.1:random
      ↓
dsh web
```

This is acceptable only as a throwaway debugging proof if required.

It must not be the shipped architecture.

## Do not rewrite the Web UI

Reuse DSH client packages.

## Do not put DSH in the renderer

The renderer is sandboxed and unprivileged.

## Do not let Electron main become the harness

Main is lifecycle + native capabilities + transport broker.

---

# 35. Definition of MVP

The MVP is complete only when a clean machine can install the application and:

1. launch without Node installed;
2. boot bundled DSH;
3. configure a supported model/provider;
4. select a real local project directory;
5. create a DSH session;
6. send a prompt;
7. receive streaming output;
8. observe tool activity;
9. approve/deny a Harness approval and answer a user question;
10. cancel an active operation;
11. quit cleanly;
12. reopen the application;
13. reopen persisted session history;
14. run without an HTTP listener;
15. display matching DSH semantics compared with `dsh web`.

Do not call a BrowserWindow wrapping `dsh web` the finished MVP.

---

# 36. Definition of v1

v1 additionally requires:

- signed/notarized packages;
- updater;
- native menus;
- recent workspaces;
- diagnostics UI;
- robust runtime crash recovery;
- tested optional DSH Codex subagent;
- tested DSH Claude Code subagent where configured;
- installer-level integration tests;
- migration tests between at least two Desktop releases;
- upstream compatibility workflow;
- no known critical Electron security warnings.

Optional OpenCode ACP delegation is post-v1 unless it is specifically desired.

---

# 37. Implementation order

Implement strictly in this sequence:

```text
0. Pin and document DSH
          ↓
1. Secure Electron renderer shell
          ↓
2. Standalone Node/DSH runtime
          ↓
3. Runtime supervisor
          ↓
4. Generic IPC transport (Fetch + Stream)
          ↓
5. Existing DSH client UI over IPC
          ↓
6. Full session/event correctness
          ↓
7. Native capability providers
          ↓
8. Crash/restart/reconnect handling
          ↓
9. Packaging and native dependencies
          ↓
10. Security hardening
          ↓
11. E2E tests
          ↓
12. Desktop-specific UX
          ↓
13. Optional external subagent integrations
```

Do not begin substantial desktop UI redesign before step 8.

---

# 38. Required implementation discipline

For every stage:

1. inspect relevant existing DSH code first;
2. identify the existing capability/service;
3. extend through that capability;
4. avoid duplicate concepts;
5. add tests;
6. run upstream tests and the repository gates (workspace checks,
   TypeScript solution builds, lint, typecheck, GUI tests, hygiene)
   through the repository's own commands, matched to the change's
   surface; the aggregated CI matrix is exercised by CI, not by a local
   full-suite rerun, per the pinned repository's AGENTS.md;
7. document any unavoidable upstream modification.

When existing DSH code and this specification disagree because upstream has changed, preserve these higher-level invariants:

```text
DSH owns agent semantics.
Renderer uses DSH client abstractions.
Transport is generic.
Electron main is not an agent runtime.
No second harness.
No production HTTP server.
Native capabilities enter DSH through plugins/providers.
Runtime and client remain separately replaceable.
```

If satisfying one of those invariants requires adapting a package name or API call because upstream changed, adapt the implementation rather than violating the invariant.

---

# 39. Final architecture test

Before considering the project structurally complete, answer this question:

> If DeepSeek adds a new model, tool, session event, or host communication plane method tomorrow, does the Desktop application need to modify Electron main or its IPC protocol?

The correct answer is:

**No.**

If the answer is yes, the desktop boundary has been placed too high and must be redesigned.

The desktop transport should move DSH's protocol, not become DSH's protocol.

---

# 40. Final target

The resulting product should be conceptually equivalent to:

```text
DeepSeek Harness
+
an officially-shaped Electron client carrier
+
native desktop capabilities
+
a bundled reproducible runtime
```

rather than:

```text
a new coding agent
that happens to call DeepSeek Harness.
```

That distinction should govern every implementation decision.