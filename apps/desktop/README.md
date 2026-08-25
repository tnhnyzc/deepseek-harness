# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

Private Electron shell of the DeepSeek Harness desktop app. Stage 1 ships
the hardened window, the private `dsh-app://` renderer protocol, and a thin
renderer entry; stage 2 adds the runtime supervisor: the main process forks
the standalone Harness runtime (`apps/desktop-runtime`) under the pinned
bundled Node, drives its `stopped/starting/ready/stopping/failed` lifecycle
over fork IPC, and stops it through the normal DSH disposal path on quit.
Stage 3 adds the IPC transport: the runtime serves a fetch-compatible
request/response primitive and an opaque ordered stream over the fork IPC,
a dumb broker in main relays the frames to the renderer, and the renderer
 reaches both through `window.dshDesktop.openTransport()`. Stage 4 boots
the pinned DSH client/UI tree from this renderer over that transport: the
runtime publishes the client boot graph before it reports ready, the
renderer installs the `__DSH_TRANSPORT__` carrier seam, and `AppWebEntry`
takes over the single application root — no second UI. Stage 5 adds the
native capability boundary: DSH-owned OS operations (the directory chooser,
default-application path open) cross a closed runtime↔main channel over the
fork IPC to Electron's `dialog`/`shell`, with the renderer never calling
Electron for them. See `SPEC.md`
#6-#11, `ARCHITECTURE.md`, and the
[upstream contract](./docs/upstream-contract.md) for scope, seams, the
applied local modifications, and the open D4 question (D1, D2, and D3
resolved in stages 3-4).

## Build

```sh
pnpm install
pnpm run build          # tsdown -> dist/main, vite -> dist/renderer
pnpm run bundle:node    # download + sha256-verify the pinned Node into node/
```

The runtime itself is a workspace package: from the repository root,
`pnpm run build` bundles `apps/desktop-runtime/dist/index.js`. The desktop
`pnpm run build` builds the runtime first, then bundles main and renderer.

## Run

```sh
pnpm start              # electron . from the package root (dev)
```

Development needs both build artifacts: the runtime bundle and the bundled
Node for this platform (`pnpm run bundle:node`). The runtime's home is
`<Electron user-data>/harness` — an app-owned `DSH_HOME`; the CLI's
`~/.dsh` is never reused.

## Test

Run from the repository root (monorepo convention):

```sh
pnpm test apps/desktop  # supervisor, smoke, and protocol tests
```

- `tests/runtime.spec.ts` always runs: the supervisor against a fixture
  runtime over real fork IPC (state machine, death, exactly-one auto-retry
  before ready, graceful and forced process-tree shutdown, restart).
- `tests/desktop-transport.spec.ts` always runs: the renderer client
  against fake ports (response assembly, streaming request bodies, credit on
  every data path, sequence validation, the full abort lifecycle, and the
  open/closed stream lifecycle).
- `tests/transport-broker.spec.ts` always runs: the main broker against
  fakes (the wire gate's drops and synthesized size refusals, bidirectional
  relay, readiness denial, channel replacement, teardown).
- `tests/native-capabilities.spec.ts` and `tests/native-channel.spec.ts`
  always run: the OS capability registry and the main-side channel against
  injected fakes (the closed success/cancel/failure mapping, the bounded
  diagnostics, duplicate refusal, malformed-request classification, the
  teardown cancel of every pending request, and the caller-abort
  termination that drops the late OS result).
- `tests/native-integration.spec.ts` self-skips without the runtime
  bundle: it forks the built runtime and answers it with the REAL
  main-side channel over a controllable OS port — the pick settles, a
  caller abort empties the main-side pending set immediately and the late
  dialog completion emits nothing, and the channel stays healthy for the
  next request.
- `tests/security.spec.ts` and `tests/boundary.spec.ts` always run: the
  IPC sender trust rule, and the SPEC §31 architectural boundary scans
  (no DSH product imports in main, the renderer's DSH imports limited to
  the boot set, no business literals in the transport or the native
  capability layers, no native protocol knowledge in the renderer or
  preload, no HTTP listeners).
- `tests/dsh-carrier.spec.ts` always runs: the `__DSH_TRANSPORT__` carrier
  against a scripted fake (the seam shape, event-path vs fetch routing in
  the API client, and the bundle loader's fetch + classic-script
  execution).
- `tests/shell.spec.ts` self-skips without the build artifacts (the
  end-to-end runtime block additionally needs the runtime bundle and the
  bundled Node) or without a GUI session; its runtime smoke asserts the
  stage 4 handoff (the DSH globals installed, the shell state gone) and
  round-trips a fetch through the app's own carrier. `protocol.spec.ts`
  always runs.

## Package

`forge.config.ts` is the packaging specification (asar +
`extraResource: dist/renderer` and `node` -> `Resources/`). The Forge 7 CLI
cannot run its system check in this monorepo's isolated pnpm layout; stage 1
verifies bundle assembly with `@electron/packager` (see the stage 1 Agent
Note). Tooling settles in stage 11.

## Layout

- `src/main/` — Electron main process: window, `dsh-app://` protocol,
  session hardening, the runtime supervisor (`runtime.ts`,
  `runtime-paths.ts`), the dumb transport broker (`transport-broker.ts`),
  and the native capability boundary (`native-capabilities.ts`,
  `native-channel.ts`: the closed OS registry and the per-generation
  request/response channel over the supervisor's fork IPC, where a caller
  abort logically terminates its request and the late OS completion is
  dropped). No Node APIs reach the renderer.
- `src/preload/index.cjs` — checked-in CJS supervision bridge (a sandboxed
  preload cannot load ESM); state view, state events, restart, and
  `openTransport()` handing the renderer the live transport port.
- `src/shared/runtime-state.ts` — state and transport types shared by
  main, preload, and renderer.
- `src/renderer/` — packaged renderer entry (CSP-strict, no `file://`);
  projects the runtime lifecycle and a recoverable failure screen, carries
  the renderer transport client (`transport.ts`), and — from stage 4 —
  installs the DSH carrier (`dsh-carrier.ts`) and hands the single root to
  the pinned `AppWebEntry` at ready; `node-module-stub.ts` stands in for
  the loader's browser-inert `node:module` require.
- `scripts/bundle-node.ts`, `node-versions.json` — build-time download and
  sha256 verification of the pinned Node per target.
- `tests/` — supervisor, smoke, protocol, renderer client, broker, native
  capability, and end-to-end tests.
