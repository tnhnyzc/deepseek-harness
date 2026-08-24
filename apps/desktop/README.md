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
reaches both through `window.dshDesktop.openTransport()`. The DSH client
application tree starts from this renderer in stage 4. See `SPEC.md`
#6-#11, `ARCHITECTURE.md`, and the
[upstream contract](./docs/upstream-contract.md) for scope, seams, and the
open D1, D3, and D4 questions (D2 resolved in stage 3).

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
  against fake ports (response assembly, stream request bodies, credit in
  both directions, sequence validation, the full abort lifecycle, and the
  open/closed stream lifecycle).
- `tests/transport-broker.spec.ts` always runs: the main broker against
  fakes (the wire gate's drops and synthesized size refusals, bidirectional
  relay, readiness denial, channel replacement, teardown).
- `tests/security.spec.ts` and `tests/boundary.spec.ts` always run: the
  IPC sender trust rule, and the SPEC §31 architectural boundary scans
  (no DSH product imports in main, no electron/Node in the renderer, no
  business literals in the transport, no HTTP listeners).
- `tests/shell.spec.ts` self-skips without the build artifacts (the
  end-to-end runtime block additionally needs the runtime bundle and the
  bundled Node) or without a GUI session; its smoke block now also
  round-trips a fetch over the live transport. `protocol.spec.ts` always
  runs.

## Package

`forge.config.ts` is the packaging specification (asar +
`extraResource: dist/renderer` and `node` -> `Resources/`). The Forge 7 CLI
cannot run its system check in this monorepo's isolated pnpm layout; stage 1
verifies bundle assembly with `@electron/packager` (see the stage 1 Agent
Note). Tooling settles in stage 11.

## Layout

- `src/main/` — Electron main process: window, `dsh-app://` protocol,
  session hardening, the runtime supervisor (`runtime.ts`,
  `runtime-paths.ts`), and the dumb transport broker
  (`transport-broker.ts`). No Node APIs reach the renderer.
- `src/preload/index.cjs` — checked-in CJS supervision bridge (a sandboxed
  preload cannot load ESM); state view, state events, restart, and
  `openTransport()` handing the renderer the live transport port.
- `src/shared/runtime-state.ts` — state and transport types shared by
  main, preload, and renderer.
- `src/renderer/` — packaged renderer entry (CSP-strict, no `file://`);
  projects the runtime lifecycle and a recoverable failure screen, and
  carries the renderer transport client (`transport.ts`).
- `scripts/bundle-node.ts`, `node-versions.json` — build-time download and
  sha256 verification of the pinned Node per target.
- `tests/` — supervisor, smoke, protocol, renderer client, broker, and
  end-to-end tests.
