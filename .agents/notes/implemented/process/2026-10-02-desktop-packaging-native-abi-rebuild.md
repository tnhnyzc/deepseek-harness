# Agent Note: Desktop staging rebuilds the closure's ABI-fragile native packages against the bundled Node

Status: implemented

English | [中文](2026-10-02-desktop-packaging-native-abi-rebuild.zh.md)

## Problem

Closure staging copies the workspace's `node_modules` bytes verbatim, and gyp-compiled native packages in that tree carry the ABI of whatever Node ran `pnpm install` — on the CI runners, Node 24. The packaged runtime runs under the pinned bundled Node (`node-versions.json`: v22.23.2, `NODE_MODULE_VERSION 127`). A Node 24 addon (`NODE_MODULE_VERSION 137`) throws at `require` time, and the desktop boot smoke died at the first such import:

```
dsh-desktop-runtime: plugin tree failed to load: ... failed to import loader entry
session-persistence-jsonl (@deepseek-ai/dsh-session-persistence-jsonl): The module
.../runtime/node_modules/fs-ext/build/Release/fs_ext.node was compiled against a
different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js
requires NODE_MODULE_VERSION 127.
```

The re-pin is what made this reachable. Pre-re-pin, nothing in the closure imported `fs-ext` (verified at fork master `4327dc3368`: no reference under `packages/session/`); the alpha.1 candidate's `session-persistence-jsonl` `lease.ts` imports `flock` from `fs-ext`, so the candidate's closure carries it. Locally the mismatch was masked: this host's Node is 22.x, so the workspace `fs-ext` happened to match the bundled Node's ABI and the local rehearsal passed the boot smoke while every CI platform failed it.

`node-pty` is the closure's other ABI-fragile member: it ships N-API prebuilds (ABI-stable) but its install falls back to a source build (`node scripts/prebuild.js || node-gyp rebuild`), and on that path the staged binary carries the runner's ABI. `sharp` is not affected: `prebuild-install` supplies its N-API binary and its `binding.gyp` is not at the package root.

## Decision

`stageRelease` now rebuilds the closure's gyp-capable ABI-fragile native packages against the pinned bundled Node, before packaging. It scans every staged `node_modules` root (collision shadows included); a staged package with a root `binding.gyp` must be in `GYP_AT_INSTALL_PACKAGES` (currently `fs-ext` and `node-pty`) or staging fails, so a new ABI-fragile dependency is classified at staging time instead of being discovered by the boot smoke. Each listed package is rebuilt with node-gyp — a new `apps/desktop` devDependency, pinned to `12.4.0`, the version pnpm 11.7.0 runs for lifecycle builds — against `--target` set from `node-versions.json`, the same single source of truth the bundled binary is installed from.

## Alternatives considered

**Pin the CI desktop job's install Node to the bundled major.** A workflow env (`npm_config_target` or a Node 24 → 22 install step) would work on the runners, but it couples the workflow to the pin and still leaves the local rehearsal free to diverge (this host's Node is 22 today; a 24 host reproduces the CI failure silently). The packaging pipeline owns the bundled-Node contract, so the rebuild belongs in the pipeline, reading the pin from `node-versions.json` with no workflow knowledge.

**Rebuild the workspace packages before staging.** That would mutate the checkout's `node_modules` — the developer tooling's own binaries — for a packaging output. Staging is the packaging plane; the rebuild runs on the staged copies only.

## Consequences

Every packaged artifact now carries `fs-ext` (and `node-pty`) compiled against its own bundled Node, on every platform, locally and in CI. Staging gains one compile of each listed package (tens of seconds) and node-gyp's checksum-verified header download for the pinned version — the same network requirement the install step already carries. The guard converts a future silent ABI break into a loud staging failure naming the package.

Verification history, for the record: the desktop lane had not executed since the fork's `ci.yml` was manually disabled in the repository — the missing CI runs for the re-pin branch were first misdiagnosed as a GitHub Actions event-drop incident (a same-day report elsewhere matched the symptom, and close/reopen and fresh-head pushes did not produce a run), but the Actions UI showed the workflow simply disabled. `gh workflow enable ci.yml` plus one close/reopen produced the first run since; all four desktop jobs then failed the boot smoke with the ABI error above, and the re-enabled lane is the one validating this fix.
