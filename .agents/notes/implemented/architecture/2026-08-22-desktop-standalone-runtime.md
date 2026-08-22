# Agent Note: desktop stage 2 — standalone Harness runtime

Status: implemented

English | [中文](2026-08-22-desktop-standalone-runtime.zh.md)

## Problem

Stage 2 (SPEC #7) must establish the process boundary: the Electron shell supervises a standalone plain-Node Harness runtime that serves no HTTP at all. The upstream web composition was built for `dsh web`, where the `webserver` row listens on a port and four further rows can never activate without it; the SPEC forbids `dsh web`, port probes, and stdout-parsing readiness, requires an app-owned `DSH_HOME` (never `~/.dsh`), a pinned Node binary that is a packaged resource rather than a first-launch download, at most one automatic restart, and shutdown through the normal DSH disposal path with a forced kill that leaves no orphans.

## Decision

The runtime is a new private workspace package, `apps/desktop-runtime` (the carve-out named in stage 1). It is a single-file tsdown ESM bundle (`dist/index.js`, external workspace bare imports resolved at runtime) — the same convention as the `apps/cli` bundle — that imports the composition pieces `@deepseek-ai/dsh-app-boot` exports (`healProfilesModuleFallback`, `loadProfile`, `composeEntries`, `boot`) and reboots the CLI's `web` profile as its base, so the desktop hosts the same Harness the browser surface runs.

The HTTP-free overlay (a source-level refinement of contract §1.2) disables five rows: `webserver` (the HTTP listener), `web-runtime` (serves the dist, provides `webRuntime`), `connection` (binds the `/api` routes), and `modules` plus `client-hmr`, which the stage 0 contract did not list because their `webServer` dependence is declared in plugin injection lists, not in the bundle's row configs (`packages/client/modules/src/index.ts:283`, `packages/client/hmr/src/index.ts:28`). It also re-targets the directory picker: the `auto` variant resolves the web bind host and injects `webServer`, so the overlay disables that row and inserts the existing `@deepseek-ai/dsh-host-directory-picker-native` — the same "mount -native in an overlay" treatment the web composition documents for deployments pinning the picker. A `PatchOptions` row `name` is a verification guard, not a re-target, so the swap is a disable plus insert.

Readiness is the settled `boot()` `Promise<Context>`: no port, no stdout. The runtime then sends `runtime.ready` over fork IPC with `runtimeVersion` (its package version), `dshVersion` (`@deepseek-ai/dsh-base`), and `capabilities` (`apiProxy: true`, `httpServer: false`). Its home is the app-owned directory the shell creates under Electron's user-data path, passed as `DSH_HOME`; the child's `cwd` is the runtime package root so `.env` layering reads the app home. Telemetry keeps the CLI's any-non-empty-value `DSH_TELEMETRY_DISABLED` semantics.

Node is pinned in `apps/desktop/node-versions.json` at `v22.23.2` — the version that verified the pin — with a sha256 per target (darwin-arm64, darwin-x64, win32-x64, linux-x64); `scripts/bundle-node.ts` downloads, verifies, and installs `node/<target>/node` at build time, and the packaged app ships it as a resource. The supervisor forks that binary with an empty `execArgv` and a curated environment (`DSH_DESKTOP=1`, `DSH_HOME`, ambient credentials; nothing secret via argv).

The supervisor in Electron main (`src/main/runtime.ts`) is a `stopped/starting/ready/stopping/failed` machine whose illegal transitions throw. It forks `stdio: ignore/pipe/pipe/ipc` (`detached: true` on POSIX so a force kill hits the whole process group), keeps a bounded stdout+stderr diagnostic ring, and sends `runtime.shutdown` on stop; the child awaits `ctx.fiber.dispose()` under the CLI's 5 s grace pattern (mirrored, since the bin glue is not an importable module) and self-forces, while the parent force-kills the process group if the tree is still alive. There is at most one automatic retry, and only when the runtime fails before reaching ready — never on a spawn error, never after ready; the failure screen offers a manual restart.

The renderer gets a minimal CJS preload (a sandboxed preload cannot load ESM) exposing only supervision state: current view, state events, and restart. That is the stage 2 bridge; the stage 3 client transport (`__DSH_TRANSPORT__` and the MessagePort protocol) is deliberately not started. The renderer projects the lifecycle and a recoverable failure screen.

Verification: `apps/desktop/tests/runtime.spec.ts` drives the supervisor against a fixture runtime over real fork IPC (state machine, death after ready, exactly-one auto-retry before ready, no retry after ready, graceful tree shutdown, forced kill of a refusing tree, manual restart); `apps/desktop-runtime/tests/boot.spec.ts` boots the built runtime under a temporary `DSH_HOME` and asserts the ready facts, the absence of any HTTP listener, home confinement, and a clean exit 0 on shutdown; `apps/desktop/tests/shell.spec.ts` gains an end-to-end block that launches the built app and reaches `ready` through the bundled Node, then quits cleanly. All self-skip without their build artifacts.

## Consequences

- The desktop delta now touches one more repo-level gate file: the root `tsdown.config.ts` workspace list bundles the runtime in the repo build; `tsconfig.host.json`, `knip.json`, and `.gitignore` register the new private app. `apps/desktop` remains referenced by both TypeScript faces (main/preload are host code, the renderer is client code) — the stage 1 arrangement is confirmed, not revisited.
- Bookkeeping: the red `rescope-vendor:check` (two stale exact edits) is a pre-existing upstream defect in a gate the stage 0.2 pass did not exercise; it is recorded as such in `UPSTREAM.md` and the contract mismatch list.
- The overlay couples to the web profile's row ids: if upstream renames or restructures those rows, `DESKTOP_DISABLED_ROWS` and the picker re-target must be re-verified. The coupling is recorded in contract §1.2.
- D-category: no new D risk materialized. The desktop composition activates no native module under the bundled Node, so D4 stays open at its stage 9/11 scope; D3 and D1 are untouched (no DSH client code in the renderer yet).
- `forge.config.ts` `extraResource` now also stages `node`; the packaged runtime resource layout settles in stage 11.

## Alternatives considered

- **Supervise `dsh web` (or the CLI bin) as the runtime** — rejected by the SPEC: it would serve HTTP, and readiness would be a port or a printed URL line, both forbidden.
- **Load the Harness in-process in Electron main** — rejected by the ARCHITECTURE's process separation: a runtime crash must not take the shell down, and the Harness keeps its own plain-Node dependency surface.
- **A dedicated JSON-RPC or WebSocket channel between shell and runtime** — rejected: `child_process.fork` IPC is the native seam and carries no transport dependency; the stage 3 renderer transport is a different channel with its own design.
- **Retarget the picker row with a `name` override or a new Electron dialog provider package** — rejected: `name` is a verification guard, not a re-target, and the existing `-native` provider already opens OS dialogs on the host display; a shell-provided dialog provider can take the same slot later if needed.
- **Download the Node binary at first launch** — rejected by the SPEC: the Node executable is a packaged resource, checksum-verified at build time.
