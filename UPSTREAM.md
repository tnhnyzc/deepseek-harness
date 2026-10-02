# Upstream Pin

This repository is the desktop fork of
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(fork: [tnhnyzc/deepseek-harness](https://github.com/tnhnyzc/deepseek-harness)).
The desktop delta is the diff between the pinned SHA below and the desktop
release commit. See `ARCHITECTURE.md` and `SPEC.md`.

## Pinned revision

- Upstream repository: `https://github.com/deepseek-ai/deepseek-harness`
- Upstream SHA: `d347e703908d0406b7a7ef80e3a0e594d86b2215`
- Release tag: `dsh-v0.1.3-alpha.1` (the tag's commit is the pinned SHA;
  verified with `git ls-remote`)
- Pinned: 2026-10-03
- Previous pin: `dsh-v0.1.1-rc.2`
  (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, 2026-08-22), replaced by the
  2026-10-02 re-pin, which validated the new SHA before flipping this file per
  the procedure in `apps/desktop/docs/upstream-contract.md`.

## Toolchain at pin

| Item | Value |
| --- | --- |
| Root package | `@deepseek-ai/dsh-root@0.1.3-alpha.1` |
| Node engine requirement | `^22.19.0 \|\| >=24.0.0` |
| Node used for pin verification | `v22.23.2` |
| pnpm pin (`packageManager`) | `pnpm@11.7.0` |
| pnpm used for pin verification | `11.7.0` |

## Re-pin validation (2026-10-02 → 2026-10-03)

The re-pin ran the contract's procedure — upstream change inspection,
contract re-verification, the full authoritative suite against the new SHA,
and flow testing — before this file changed. The new SHA moves the session
format to v2 (v0/v1 remain readable through the adjacent migrations), the
client tree to the Lexical composer and turn-process rendering, and the
connection/module registries to the credential-wired, optional-webserver
shape; the delta audit (which rc.2 patch was retained, replaced, or
reclassified) is in `apps/desktop/docs/upstream-contract.md`.

| Gate | Evidence |
| --- | --- |
| Full desktop Layer C/D suite | 25 files / 229 tests green, including the event-correctness (5) and crash-recovery (9) suites re-expressed to the v2 durable semantics (no `assistant/chunk` records; settled `assistant/message` blocks, `interrupted` partials on graceful cancel, no fabricated partial on SIGKILL) |
| Genuine A→B cross-artifact migration | `session-migration.spec.ts` (3) green: release A (`dsh-v0.1.1-rc.2`, built at `4327dc33`) creates a real v0 profile; release B (this tree) migrates v0→v1→v2 on reopen, restores the session `cwd`, and drives the production native-opener seam (`shell.openPath`) through the rendered "Show in folder" affordance |
| Local package pipeline | exit 0: build, closure staging (ABI-fragile native packages rebuilt against the bundled Node v22.23.2), Electron packaging, fuses, ad-hoc signing, boot smoke, resolution smoke (78/78 edges), native-module smoke, packaged-app smoke |
| Four-platform CI desktop jobs | run `37057856641` (head `91489b15`): `desktop / macos package (arm64)` (job `111006866311`), `desktop / macos package (x64)`, `desktop / linux package`, `desktop / windows package + D4 containment` — all success; the CI log confirms the staging rebuild path (`rebuilding fs-ext against the bundled Node 22.23.2`). darwin-arm64 zip SHA256 `ad3758dc778a9932e3085a33c913fe2de2fb0ff76186094868aa583b12424cc7` |
| Typecheck + doc gates | `pnpm run typecheck` (host + client `tsc -b`) pass; `pnpm run test:docs` pass; `pnpm run rescope-vendor:check` pass (this re-pin removed two pre-rescope prose tokens from the fork's cordis agent preset) |

Known fork-infra failures at the pin (not pin defects): the `Issue lifecycle`
and `Issue policy` jobs stay red because the fork does not set
`DSH_ISSUE_APP_CLIENT_ID`.

## Desktop patches

Root-level fork patches (the package-level M/U delta against the pinned SHA
is accounted in `apps/desktop/docs/upstream-contract.md`, sections "Applied
local modifications (stage 4)" and "Shared upstream-generic modifications
(stage 8)"):

| File | Change | Stage |
| --- | --- | --- |
| `scripts/check-workspace-constraints.ts` | `privateAppDirectory` carve-out: `apps/desktop` and `apps/desktop-runtime` are private workspace members, exempt from the release-member publication rules and the app publication-files policy (fork-level gate amendment B1 from the upstream contract) | 1 |
| `pnpm-workspace.yaml` | `allowBuilds.electron: true` (pinned Electron binary download); override pinning `@electron/rebuild` to 4.2.0 because the Forge packages' 3.x rebuild sub-dependency resolves node-gyp from a git repository, which `blockExoticSubdeps` rejects | 1 |
| `tsdown.config.ts` | repo build workspace now includes `apps/desktop-runtime`, so the runtime's `dist/index.js` bundle is produced by `pnpm run build` (registration of the new private app; the app itself is fork-only) | 2 |
| `tsconfig.host.json`, `tsconfig.client.json`, `knip.json`, `.gitignore` | workspace registration for the two private apps (host/client face references, knip entries, build-output ignores) | 2 |
| six package manifests (`fs-local`, `directory-picker-native`, `sandbox-windows-acl`, `session-persistence-jsonl`, `subprocess-local`, `win32-process`) | `koffi` pinned `^3.1.0` → `3.1.1`: the 3.1.1 prebuild is the ABI-verified one for the bundled Node target (D4) | 11 |
| `apps/desktop-runtime/config/agent-presets/cordis/agent.cordis.yml` | preset content migrated to the alpha.1 tool vocabulary; two pre-rescope prose tokens removed so `rescope-vendor:check` passes at the new pin | re-pin |

## Known incompatibilities

- `pnpm run rescope-vendor:check` is green at this pin. At the previous pin
  it was red with two stale exact edits in `scripts/rescope-vendor.ts`
  (pre-existing upstream defect, fixed upstream by this pin); at this pin it
  briefly tripped on pre-rescope prose tokens in the fork's cordis agent
  preset, removed in the re-pin (table above).
- Electron Forge 7.11.2's CLI system check requires a hoisted pnpm layout
  (or a custom hoist pattern), which this monorepo does not use;
  `skipSystemCheck` no longer exists in Forge 7. Stage 1 therefore verifies
  bundle assembly with `@electron/packager` 18.4.4 (the assembler Forge uses
  internally) and keeps `forge.config.ts` as the stage 11 packaging
  specification.
