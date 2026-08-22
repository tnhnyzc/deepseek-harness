# Agent Note: desktop stage 1 — Electron shell

Status: implemented

English | [中文](2026-08-22-desktop-electron-shell.zh.md)

## Problem

The desktop fork must add an Electron application to the Harness monorepo, and every monorepo gate was designed for published release members: `scripts/check-workspace-constraints.ts` requires every `apps/*` package to be a public release member, the TypeScript solution is split into explicit host/client faces, and the pnpm supply-chain policy denies install scripts and git-hosted subdependencies by default. Electron and Electron Forge each collide with one of those rules, and the stage 1 shell (SPEC #6) must land inside all of them without redesigning the gates around the desktop.

## Decision

`apps/desktop` is a **private workspace member**, not a release member. The fork amends `scripts/check-workspace-constraints.ts` with a `privateAppDirectory` carve-out (`apps/desktop`, `apps/desktop-runtime`) that removes those directories from the release-member publication rules and the app publication-files policy; the generic branch then *requires* `private: true` for them. This is the B1 amendment from [the upstream contract](../../../../apps/desktop/docs/upstream-contract.md), applied now that the first app `package.json` lands.

The shell is one `BrowserWindow` with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and no preload in stage 1 (the MessagePort bridge is stage 3; the renderer is fully unprivileged until then). Navigation is confined to the app protocol, `setWindowOpenHandler` denies every new window (validated http/https URLs go to `shell.openExternal`, nothing else does), webviews are refused, and the session denies every permission request.

The renderer is served exclusively over the private `dsh-app://` scheme (registered `standard` + `secure` before app ready). The handler maps URL pathnames onto the packaged renderer distribution with normalize-plus-prefix confinement, rejects decoded `..` traversal, absolute paths, and null bytes, and re-checks the resolved file against the symlink-resolved root before reading bytes; the main page is `dsh-app://app/index.html` and `file://` is never used. The page carries a strict CSP (`script-src 'self'`, no `unsafe-inline`).

The renderer entry is deliberately thin: a single `#root` in its startup state, built by Vite. Stage 4 starts the existing DSH client application tree from this same root using the same client packages as the Web UI; how the renderer obtains `__DSH_BOOT__` without a booted host is the open D1 question and is not decided here.

**Forge is declared but not runnable in this monorepo at this stage.** Forge 7.11.2's CLI system check demands a hoisted pnpm layout (or a custom hoist pattern), which the monorepo cannot take; `skipSystemCheck` no longer exists in Forge 7 (only an undocumented home-dir flag file). `forge.config.ts` stays as the packaging specification (asar plus `extraResource: 'dist/renderer'` → `Resources/renderer`, the directory the packaged `dsh-app://` handler serves), and the bundle assembly was verified with `@electron/packager` 18.4.4 — the assembler Forge uses internally — which passes with `prune: false` (the app has zero production dependencies) and a `node_modules` ignore (its prod-dep walker cannot traverse the isolated pnpm layout). The packaging tooling settles in stage 11.

pnpm policy carries two desktop entries in `pnpm-workspace.yaml`: `allowBuilds.electron: true` (the pinned binary download) and an override pinning `@electron/rebuild` to 4.2.0, because the Forge packages' 3.x rebuild sub-dependency resolves node-gyp from a git repository, which `blockExoticSubdeps` rejects; rebuild 4.x uses the npm-published node-gyp, and the Electron shell has no native modules to rebuild anyway (the Harness runtime is a separate plain-Node process from stage 2).

Verification is two-tier: `tests/protocol.spec.ts` unit-tests the path-confinement and URL-validation functions directly, and `tests/shell.spec.ts` boots the built app through Playwright's Electron driver and asserts the stage 1 exit criteria (dsh-app:// URL, boot state, CSP present, no `require`/`process` in the renderer, traversal 404, zero requests outside the app protocol, zero Electron security warnings); it self-skips without a build or a GUI session.

## Consequences

- The desktop delta touches repo-level gates: the constraints carve-out, both tsconfig aggregates (`apps/desktop` is referenced by the host face and the client face — a neutral single-config project: the one package holds host code, its main process and preload, and client code, its renderer, so both faces must typecheck it; the arrangement is carried into stage 2 and later stages), `knip.json`, `pnpm-workspace.yaml`, and `.gitignore`.
- The carve-out names `apps/desktop-runtime` before that package exists (stage 2), so the gate is ready when the second app lands.
- `pnpm run hygiene` is red at the pin itself: `rescope-vendor:check` fails with two stale exact edits unrelated to desktop (verified in a clean worktree of the pin). Recorded in the contract's mismatch list; the fork-level fix is deferred.
- D3 (`isLoopback` affordances under `dsh-app://`) is untouched: no DSH client code runs in the stage 1 renderer.
- `THIRD_PARTY_NOTICES.md` is regenerated by the pre-commit hook for the new Electron/Forge dependencies.

## Alternatives considered

- **`node-linker=hoisted` (or a hoist pattern) to satisfy Forge's system check** — rejected: it relayouts the entire monorepo's `node_modules` for a tool whose rebuild path the shell never uses.
- **`file://` or a loopback HTTP server for the renderer** — rejected by the SPEC: no `file://` in the released application, no localhost HTTP server in the final product.
- **A stage 1 preload bridge** — rejected: stage 1 has no IPC to carry; the renderer stays maximally unprivileged until stage 3 defines the MessagePort protocol.
- **Dropping Electron Forge entirely** — rejected: the SPEC structure declares `forge.config.ts`; the constraint is environmental, so the config stays as the stage 11 packaging specification rather than being deleted.
- **Serving the real DSH client tree already in stage 1** — rejected: that would force the D1 `__DSH_BOOT__` provisioning decision and the stage 4 transport work ahead of their stages; the exit criteria explicitly allow "no Harness runtime yet".
