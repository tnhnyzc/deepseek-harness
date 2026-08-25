# @deepseek-ai/dsh-desktop-runtime

English | [中文](README.zh.md)

Standalone DeepSeek Harness runtime process for the desktop app. Electron's
supervisor forks this entry under the packaged Node; it boots the `web`
profile composition programmatically — the same Harness the browser surface
runs — with the HTTP serving rows removed, reports readiness over the fork
IPC channel, and disposes the whole Cordis tree on shutdown. It never
starts a web server and never parses its own stdout. Since stage 3 it also
serves the desktop transport over the same channel: a fetch-compatible
request/response primitive and an opaque ordered stream, back-pressured by
per-direction credit windows. Since stage 5 it also carries the native
capability channel: the DSH directory-picker seat and the gateway's
default-application opener cross this channel to Electron main's
`dialog`/`shell`, and the runtime provides the desktop `DirectoryPicker`
plugin instead of the host-native subprocess choosers. See `SPEC.md`
#7-#11 and the [upstream
contract](../desktop/docs/upstream-contract.md) for scope and seams.

## Build

Run from the repository root (the entry bundles with the host face):

```sh
pnpm run build          # tsc -b + root tsdown emits the four dist entries
```

The entries are `dist/index.js` (the forked runtime), `dist/transport.js`
(the transport protocol subpath), `dist/native.js` (the native capability
protocol subpath), and `dist/directory-picker.js` (the desktop directory-
picker plugin, loaded by the composition by file URL).

## Run

Do not run it directly; the desktop supervisor launches it as:

```text
<bundled-node> <this package>/dist/index.js
```

with an IPC channel, `DSH_DESKTOP=1`, and `DSH_HOME=<desktop-managed-home>`.
The control protocol is `runtime.ready` up (versions plus capability
flags), `runtime.shutdown` down (dispose and exit), and
`runtime.transport-closed` up (a transport channel generation ended). The
same channel also carries the stage 3 transport frames — fetch and stream
messages, demultiplexed from the control messages by their type tag — and
the stage 5 native capability family: `native.request`/`native.abort` up
(a closed OS capability call; the caller's abandonment of an in-flight
request), `native.response`/`native.cancel` down.

## Test

Run from the repository root:

```sh
pnpm test apps/desktop-runtime
```

`boot.spec.ts` boots the real composition under a temporary `DSH_HOME` and
self-skips when `dist/index.js` has not been built. `transport.spec.ts`
drives the protocol and the runtime adapter against a fake `ApiProxy`;
`transport-boot.spec.ts` drives the built bundle through a real forked
child over fork IPC and self-skips the same way. `native-protocol.spec.ts`
pins the closed wire contract; `native-bridge.spec.ts` the child's
request/response client (ids, the whole-lifetime abort terminal, stale and
duplicate refusal, teardown settlement); `directory-picker.spec.ts` the
provider; `native-boot.spec.ts` plays the Electron main side against the
built runtime over real fork IPC (pick success/cancel, open
success/failure, cancel mapping, in-flight pick and open aborts each
crossing a real `native.abort` with the late result dropped) and
self-skips the same way.

## Layout

- `src/index.ts` — the forked entry: IPC protocol, boot, transport attach,
  disposal.
- `src/transport.ts` — the wire protocol (message types, parser, credit
  window, port surface), also exported as the `./transport` subpath.
- `src/transport-runtime.ts` — the runtime adapter over the in-process
  fetch carrier (`toFetchHandler`): fetch traffic as-is, streams as carrier
  GETs pumped into ordered, credit-gated frames.
- `src/transport-process.ts` — the fork-IPC `TransportPort` adapter.
- `src/native.ts` — the native capability protocol (closed message set,
  strict parsers), also exported as the `./native` subpath.
- `src/native-bridge.ts` — the child's native capability client over fork
  IPC (request ids, whole-lifetime abort, teardown settlement).
- `src/directory-picker.ts` — the desktop `DirectoryPicker` provider: the
  native seat whose chooser crosses to Electron main.
- `src/composition.ts` — the desktop patch stack (HTTP-free overlays,
  including the picker-provider swap).
- `src/shutdown.ts` — the bounded process-exit controller.
- `config/agent-presets/` — the shipped preset roster (same convention as
  `apps/cli/config`).
