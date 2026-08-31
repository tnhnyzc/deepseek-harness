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
Electron for them. Stage 6 proves the desktop is semantically equivalent to
`dsh web` for the normal user workflow (the eleven-surface parity suite in
`tests/dsh-parity.spec.ts`). Stage 7 adds the desktop UX: the content-sized
native window (1280×800, minimum 1024×600) and the native application menu,
whose actions drive the pinned client through a closed six-member command
vocabulary with the platform accelerators — the carrier never mutates
Harness state. Stage 8 proves the event-log semantics end to end: a burst
fold, a cancelled run, and a renderer reload mid-stream each keep the
durable log and the transcript in exact agreement, and pending approvals
and questions survive a renderer reload (the five-property suite in
`tests/dsh-event-correctness.spec.ts`); the stage 6 findings are resolved
at DSH seams — a bounded close-deferral contract for draining owners, the
inspect manifest armed at the connection readiness seam, and the
proven-safe channel replacement — with no carrier changes. Stage 9 proves
crash recovery: a killed runtime (kill -9) leaves the renderer alive with
a failure screen carrying the death reason and retained diagnostics, a
user-requested restart boots a new generation, and the client
reconstructs the sessions from the persisted log, with an interrupted
turn durably closed `interrupted` — never `completed` — by the pinned
persistence repair (the nine-property suite in
`tests/dsh-crash-recovery.spec.ts`), again with no carrier changes.
Stage 10 is the security-hardening pass: every trust boundary between the
renderer, preload, main, and runtime is now bounded and pinned — the
transport wire bounds all metadata and caps concurrent operations, the
native channel bounds ids and response paths, the BrowserWindow surface
is pinned in source, the permission policy is default-deny with the
single source-proven clipboard-write exception, the preload bridge is
main-frame-only, the CSP is a pinned minimized policy whose 'unsafe-eval'
and image blob URLs are justified at the pinned client's source, and
production code creates no network listeners (Agent Note
`2026-08-27-desktop-stage10-security`). Stage 11 is the packaging pass: a
reproducible, self-contained, per-platform release unit. `pnpm run package`
builds the app and runtime, stages a lockfile-pinned dependency closure plus
the checksum-verified bundled Node, packages with `@electron/packager`
(asar + integrity), flips all nine Electron fuses, signs (ad-hoc locally;
Developer ID + notarization, or the Windows certificate, when credentials
exist), verifies the artifact layout (33 checks), runs the four execution
smokes (the packaged runtime booting under the artifact's own Node with a
fresh `DSH_HOME` and minimal `PATH`; the staged closure's resolution edges
under the bundled Node; `sharp`/`koffi` executing under the bundled Node;
and the real packaged Electron binary driving the real DSH UI, including a
bounded carrier round trip and the crash/restart drill, over the browser
DevTools endpoint), and produces the distributable archive with its sha256
sidecar. DSH runs under the bundled standalone Node, never under Electron;
D4 (the Windows Job Object with `KILL_ON_JOB_CLOSE`, pinned to the
SDK-verified struct layout) is the process-containment guarantee, executed
on a real Windows kernel in CI against the dev runtime and the packaged
artifact. CI packages all four targets, each runner its own platform
(darwin-arm64, darwin-x64, win32-x64, linux-x64) and uploads each lane's
archive as the run evidence (Agent Note
`2026-08-29-desktop-stage11-packaging`). See `SPEC.md` #6-#11,
`ARCHITECTURE.md`, and the [upstream
contract](./docs/upstream-contract.md) for scope, seams, the applied
local modifications, and the D4 containment (D1, D2, and D3 resolved in
stages 3-4; D4 resolved in stage 11).

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

`pnpm run package` (orchestrator: `scripts/packaging/package.ts`) builds the
release unit for the **current** platform — cross-host packaging is rejected
because the closure's native prebuilds are host-specific:

```sh
pnpm run package                 # build -> stage -> package -> fuses -> sign -> verify -> smokes -> archive
pnpm run package -- --skip-build # reuse an existing build (re-stage, re-package, re-verify)
pnpm run package -- --skip-smoke # skip the execution smokes
```

The pipeline, in order: clean `out/`; build (runtime, main, renderer, and
`bundle:node` unless `--skip-build`); stage the lockfile-pinned dependency
closure plus the checksum-verified bundled Node and `build-manifest.json`
(`scripts/packaging/{closure-audit,closure,staging,build-manifest}.ts`);
package with `@electron/packager` (asar + integrity, resources unpacked
under `Resources/`); flip all nine Electron fuses
(`scripts/packaging/fuses.ts`); sign (ad-hoc locally; Developer ID +
notarization on macOS and the Windows certificate when the `CSC_*`/
`APPLE_*` credentials are present — `package-report.json` records
configured-versus-executed); verify the artifact layout (33 checks,
`scripts/packaging/verify-layout.ts`); run the execution smokes — the
clean-copy boot smoke (`smoke-runtime.ts`, the packaged runtime under the
artifact's own Node, fresh `DSH_HOME`, minimal `PATH`), the resolution smoke
(`smoke-resolution.ts`, the staged closure's resolution edges resolved and
executed under the bundled Node), the native-module execution smoke
(`smoke-native-modules.ts`, `sharp` and `koffi` executing under the bundled
Node), and the packaged-app smoke (`scripts/smoke-packaged-app.ts`, the real
Electron executable driving the real DSH UI — boot, the security baseline,
a bounded carrier round trip against a scripted 127.0.0.1 provider, the
crash/restart drill — over the browser DevTools endpoint, because the Node
inspector is fused off in the release binary; self-skips without a GUI
session); and create the distributable archive with its sha256 sidecar
(macOS/Windows zip, Linux tar.gz; `scripts/packaging/release-format.ts`).
The pipeline snapshots the repository root manifest and lockfile at the
start and verifies them before writing the report, so packaging can never
silently rewrite repository files.

The output is `out/DeepSeek Harness Desktop-<platform>-<arch>/` (the product
name's spaces are preserved) plus the archive. D4's Windows execution test
is the `desktop-windows` CI job (`scripts/d4-acceptance.ts`, dev and
`--packaged` modes, plus the Win32 ABI probe
`apps/desktop-runtime/scripts/check-windows-job-abi.ts`), not a local step.

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
- `scripts/packaging/` — the stage 11 release pipeline: `package.ts`
  (orchestrator), `closure-audit.ts` (production-only resolution walk:
  edges, collisions, graph fingerprint), `closure.ts` (lockfile-pinned store
  copy: one root copy per non-colliding instance, per-consumer shadows for
  colliding ones), `staging.ts` (staged tree + `extraResources`),
  `build-manifest.ts` (release identity + closure fingerprint),
  `fuses.ts` (the nine-fuse pin), `verify-layout.ts` (33-check artifact
  scan), `smoke-runtime.ts` (clean-copy boot proof), `smoke-resolution.ts`
  (staged-graph resolution under the bundled Node),
  `smoke-native-modules.ts` (sharp/koffi execution under the bundled Node),
  `release-format.ts` (per-platform archive + sha256 sidecar); plus
  `scripts/smoke-packaged-app.ts` (the real-binary UI smoke).
- `scripts/d4-acceptance.ts`, `scripts/d4-acceptance-child.ts` — the D4
  Windows Job Object acceptance (dev and `--packaged` modes; runs on a real
  Windows kernel in CI).
- `tests/` — supervisor, smoke, protocol, renderer client, broker, native
  capability, closure audit, packaging, packaged-app, and end-to-end tests.
