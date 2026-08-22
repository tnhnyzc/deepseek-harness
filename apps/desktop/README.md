# @deepseek-ai/dsh-desktop

Private Electron shell of the DeepSeek Harness desktop app. Stage 1 ships
the hardened window, the private `dsh-app://` renderer protocol, and a thin
renderer entry; the DSH client application tree starts from this renderer in
stage 4, and the MessagePort bridge to the Harness runtime process arrives
in stage 3. See `SPEC.md` #6, `ARCHITECTURE.md`, and the
[upstream contract](./docs/upstream-contract.md) for scope, seams, and the
open D1-D4 questions.

## Build

```sh
pnpm install
pnpm run build          # tsdown -> dist/main, vite -> dist/renderer
```

## Run

```sh
pnpm start              # electron . from the package root (dev)
```

## Test

Run from the repository root (monorepo convention):

```sh
pnpm test apps/desktop  # playwright _electron smoke + protocol unit tests
```

`shell.spec.ts` self-skips when `dist/main/index.js` or `dist/renderer/`
is missing or no GUI session is available; `protocol.spec.ts` always runs.

## Package

`forge.config.ts` is the packaging specification (asar +
`extraResource: dist/renderer` -> `Resources/renderer`). The Forge 7 CLI
cannot run its system check in this monorepo's isolated pnpm layout; stage 1
verifies bundle assembly with `@electron/packager` (see the stage 1 Agent
Note). Tooling settles in stage 11.

## Layout

- `src/main/` — Electron main process (window, `dsh-app://` protocol,
  session hardening). No Node APIs reach the renderer.
- `src/renderer/` — packaged renderer entry (CSP-strict, no `file://`).
- `tests/` — shell smoke and protocol confinement tests.
