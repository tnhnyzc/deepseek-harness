# @deepseek-ai/dsh-desktop-runtime

English | [中文](README.zh.md)

Standalone DeepSeek Harness runtime process for the desktop app. Electron's
supervisor forks this entry under the packaged Node; it boots the `web`
profile composition programmatically — the same Harness the browser surface
runs — with the HTTP serving rows removed, reports readiness over the fork
IPC channel, and disposes the whole Cordis tree on shutdown. It never
starts a web server and never parses its own stdout. See `SPEC.md` #7 and
the [upstream contract](../desktop/docs/upstream-contract.md) for scope and
seams.

## Build

Run from the repository root (the entry bundles with the host face):

```sh
pnpm run build          # tsc -b + root tsdown emits apps/desktop-runtime/dist/index.js
```

## Run

Do not run it directly; the desktop supervisor launches it as:

```text
<bundled-node> <this package>/dist/index.js
```

with an IPC channel, `DSH_DESKTOP=1`, and `DSH_HOME=<desktop-managed-home>`.
The IPC protocol is one message each way: `runtime.ready` up (versions plus
capability flags), `runtime.shutdown` down (dispose and exit).

## Test

Run from the repository root:

```sh
pnpm test apps/desktop-runtime
```

`boot.spec.ts` boots the real composition under a temporary `DSH_HOME` and
self-skips when `dist/index.js` has not been built.

## Layout

- `src/index.ts` — the forked entry: IPC protocol, boot, disposal.
- `src/composition.ts` — the desktop patch stack (HTTP-free overlays).
- `src/shutdown.ts` — the bounded process-exit controller.
- `config/agent-presets/` — the shipped preset roster (same convention as
  `apps/cli/config`).
