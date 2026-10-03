# Agent Note: Re-pin to dsh-v0.1.3-alpha.1 — closure report

Status: implemented

English | [中文](2026-10-02-desktop-repin-0.1.3-alpha.1-closure.zh.md)

## Problem

The desktop fork was pinned to `dsh-v0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, 2026-08-22), and the upstream release line had advanced to `dsh-v0.1.3-alpha.1`: the session format moved to v2, the client tree moved to the Lexical composer and turn-process rendering, and the connection/module registries moved to the credential-wired, optional-webserver shape. The fork's pinned-source delta, its durable-expectation suites, and its packaging assumptions all had to move with the new SHA, and the re-pin needed one closure record that ties the pin, the delta accounting, the evidence, and the known limitations together before the branch merges to master.

## Decision

The fork is re-pinned to `d347e703908d0406b7a7ef80e3a0e594d86b2215` (release tag `dsh-v0.1.3-alpha.1`; the tag's commit is the pinned SHA, verified with `git ls-remote`). The upstream-contract procedure ran to completion before `UPSTREAM.md` changed: upstream change inspection, contract re-verification against the frozen candidate, the full authoritative suite against the new SHA (including the genuine A→B cross-artifact migration gate), and flow testing. The closure additionally ran the repository's full test lane, the CI-form E2E lane, the clean-install package pipeline, the four-platform CI desktop matrix, and the Stage-12 upstream observation from the new pin, and settled the final M/U ledger. The re-pin branch `upstream-repin-0.1.3-alpha.1` merges to master preserving history.

## Pin and toolchain

| Item | Previous pin | New pin |
| --- | --- | --- |
| Upstream SHA | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | `d347e703908d0406b7a7ef80e3a0e594d86b2215` |
| Release tag | `dsh-v0.1.1-rc.2` (2026-08-22) | `dsh-v0.1.3-alpha.1` (pinned 2026-10-03) |
| Root package | `@deepseek-ai/dsh-root@0.1.1-rc.2` | `@deepseek-ai/dsh-root@0.1.3-alpha.1` |
| Node engine | `^22.19.0 \|\| >=24.0.0` | unchanged |
| Verification Node / pnpm | `v22.23.2` / `pnpm@11.7.0` | unchanged |

## Delta accounting (M/U)

Against the frozen candidate the entire rc.2 patch set was re-audited file by file; the full ledger is in the upstream contract's Desktop Extension Surface. Retained and re-applied unchanged: U1 (projection-cache write-order), U2 (storage close-deferral), U3 (inspect-manifest readiness). Replaced: rc.2 M2 (the candidate's connection row wires `credentials`, so the patch text changed and the BrowserAuth row became conditional). Reclassified: rc.2 M1 became U4 (the no-Web serving face plus the public `fetchBundle(request)` the boot-graph carrier consumes; upstream master has since absorbed the same face). Carried over unchanged: M3 (no-op channel disposer without a webserver). Added: U5 (native-opener capability seam), M4–M5 (the fork CI desktop jobs and their spec validation), and U6 (a later-upstream backport, removal-conditioned). No rc.2 patch was dropped.

## Candidate architecture changes

- The session format is v2: v0/v1 remain readable through the adjacent migrations, the v2 log has no `assistant/chunk` records (each model-visible text block settles as one `assistant/message`), a graceful cancel settles a partial block with `interrupted: true`, and a SIGKILL settles nothing.
- The client tree uses the Lexical composer and turn-process rendering: off-viewport rows carry `hidden="until-found"`, are excluded from `innerText`, and stay present in the row's `textContent` — the re-expressed durable-expectation probes select by `[data-chat-flow-key]` rows.
- The connection row wires `credentials`; the BrowserAuth row, the `/api` route, and the WebSocket downlinks register only when their services are present, while the in-process RPC dispatch stays unconditional.
- The ClientModuleRegistry no-Web serving face (conditional carrier registration plus a public `fetchBundle`) landed upstream, which is what let rc.2 M1 reclassify into the upstream-generic U4.
- The candidate's plugin resolution graph is 78 edges, all resolved by the package pipeline's resolution smoke under the bundled Node.

## Native, bundle, and session adaptations

- Native: `koffi` is pinned `^3.1.0` → `3.1.1` in the six native-dependent package manifests (the 3.1.1 prebuild is the ABI-verified one for the bundled Node target), and the closure staging rebuilds the ABI-fragile native packages against the bundled Node v22.23.2; the native-module smoke and the 78/78-edge resolution smoke run under the artifact's own Node.
- Bundle: the fork's cordis agent preset content was migrated to the alpha.1 tool vocabulary and two pre-rescope prose tokens were removed so `rescope-vendor:check` passes at the new pin; the generated Cordis catalog artifacts were regenerated against the frozen candidate (the re-pin had left them stale), which also required classifying the `fetchBundle` signature's `Request`/`Response` in `scripts/gen-cordis-catalog.ts`; the boot-graph carrier serves the exact `fetchBundle` bytes.
- Session: the durable format is v2 with v0/v1 adjacent migrations, and the A→B gate below exercises those migrations across two actually built releases.

## Genuine A→B cross-artifact migration

`session-migration.spec.ts` (3/3 green) drives two real release artifacts: release A (`dsh-v0.1.1-rc.2`, built at `4327dc33`) creates a real v0 profile, and release B (this tree) migrates v0→v1→v2 on reopen, restores the session `cwd`, and drives the production native-opener seam (`shell.openPath`) through the rendered "Show in folder" affordance. The gate is the standing proof that released v0 session data survives the re-pin.

## Evidence

| Gate | Evidence |
| --- | --- |
| Full test lane (local) | 1,113 files / 18,675 tests: 18,557 passed, 118 skipped, exit 0 (host Node v22.23.2, shim-free PATH) |
| Desktop Layer C/D | 25 files / 229 tests green, including the event-correctness (5) and crash-recovery (9) suites re-expressed to the v2 durable semantics |
| E2E, CI form | `DSH_EXAMPLE_MODE=lib DSH_E2E_MAX_WORKERS=4`: 137 passed, 73 keyless-skipped, exit 0 |
| A→B migration | 3/3 green (section above) |
| Package pipeline, clean install | exit 0: build, closure staging with the ABI rebuild, packaging, fuses, ad-hoc signing, boot smoke (`dshVersion 0.1.3-alpha.1`), resolution 78/78, native-module smoke, packaged-app smoke |
| Four-platform CI desktop matrix | run `37057856641` (head `91489b15`): all four desktop jobs success, including `desktop / windows package + D4 containment`; darwin-arm64 zip SHA256 `ad3758dc778a9932e3085a33c913fe2de2fb0ff76186094868aa583b12424cc7` |
| Typecheck / docs / vendor | `pnpm run typecheck`, `pnpm run test:docs`, and `pnpm run rescope-vendor:check` pass |

## Known flakes and classified failures

- `user-patches.spec.ts` "watches add, failure, recovery, and removal through transactional HMR" — load-dependent (a 10 s `eventually` deadline over the first chokidar event under full-lane fork load); an rc.2-era test whose mechanism the re-pin did not change; 8/8 green in isolation and under partial load.
- The spill-local startup-cleanup boundary flake — a float-seconds `utimes` artifact, fixed by the U6 backport (upstream `228f3aef83`).
- The python-runtime environment-leak assertion — the host's pyenv shims re-inject `PATH`/`PYENV_*` into python children; host-environment classification, green under a shim-free PATH (250 passed, 2 skipped).
- `web-agent-presets.e2e.ts` writes fixed-name sessions into the real `~/.dsh/sessions/_no-cwd` (unpinned by design, rc.2-era); local runs need residue cleanup, and CI runners are fresh.
- `python runtime / release-shaped matrix / node24-win-x64` in run `37057856641` — digest-mismatch, green in the prior run `37047907732`; the single permitted rerun was still blocked at closure by seven queued enterprise-pool jobs and is recorded as an infrastructure limitation, not a product failure.
- The `Issue lifecycle` and `Issue policy` CI jobs stay red because the fork does not set `DSH_ISSUE_APP_CLIENT_ID` — a pre-existing fork-infra gap, not a pin defect.

## Environment and infrastructure limitations

- The dev host exports `CC=/opt/homebrew/bin/gcc-13` / `CXX=/opt/homebrew/bin/g++-13`, whose binaries are missing and break node-gyp flavor detection; every native build in the re-pin ran with `CC=/usr/bin/cc CXX=/usr/bin/c++`.
- The host's pyenv shims re-inject environment into python children, so the python runtime tests run under a shim-free `PATH`.
- The dev host has not accepted the Xcode license (`sudo xcodebuild -license`), which the `fs-ext` native build requires — a host prerequisite recorded in the stage 11 clean-install note, satisfied on the CI runners.
- The enterprise runner pool queued seven jobs of run `37057856641` through closure, blocking the single permitted node24-win-x64 rerun.
- The 2026-10-02 GitHub control-plane disable event is recorded in its own note and cost the desktop matrix a run until the one-time re-enable.

## D4 obligation

D4 (bundled-standalone-Node ABI compatibility plus Windows process containment) is CI-proven on all four per-platform lanes: the closure stages host-specific native prebuilds, the per-platform boot smoke starts DSH in packaged form under the artifact's own Node, and the Windows lane runs the Win32 ABI probe that executes one real four-argument `SetInformationJobObject` against the shipping kernel. The product-job `KILL_ON_JOB_CLOSE` end-to-end kill drill remains the explicit final-v1 validation obligation: implementation is complete, but it is externally blocked from behavioral validation because every reachable Windows launch context (the GitHub runner and the local Windows 11 VM's automation trees alike) is already a member of an externally owned Job Object; the externally-contained fallback and its loud `SKIP (externally contained)` marker are the standing evidence that job-contained hosts boot healthy and are never misreported as validated.

## Signing and notarization

Signing is credential-gated and reported as configured-versus-executed per step in `package-report.json`: the CI lanes sign ad-hoc on macOS (launchable on the build host, not distributable), ship unsigned on Windows, and apply no signing on Linux; the Developer ID / notarization / Windows-certificate paths are configured-not-executed while credentials are absent. Real signing happens only in the release-workflow credential path; the re-pin lanes deliberately stayed on the ad-hoc/unsigned form, and the report makes that distinction explicit.

## src-mode E2E persistence drop

The non-CI src-mode E2E driver (tsx loader with `TSX_TSCONFIG_PATH` set, the default `src` example mode) exits 0 without materializing `.sessions`. The drop reproduces identically on the untouched frozen candidate in the same built state: the same time-context driver and fixture create no session files in that form, while the same launch without `TSX_TSCONFIG_PATH` — the CI-authoritative `DSH_EXAMPLE_MODE=lib` form — writes `session.v2.jsonl`. The attribution is frozen-candidate behavior (a hybrid source/lib module graph in which the JSONL persistence plugin is never constructed), not a fork delta and not an environmental condition; per the closure decision the fork does not fix candidate-only non-authoritative src-mode behavior, and the fact is recorded in the upstream contract's closure record.

## Current upstream observation

The Stage-12 observation ran from the new pin on 2026-10-03: upstream master is `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, 5,526 commits ahead of the pin, no newer release tags since the pin, and the pinned SHA reachable on master. The desktop delta does not apply cleanly on current master (upstream changed files the delta touches), so the recorded status is `upstream-needs-adaptation` — expected at this drift. Per the closure decision the observation records SHA, drift, and verdict only; no adaptation to current upstream was made.

## Alternatives considered

- **Stay on `dsh-v0.1.1-rc.2`.** Lost: alpha.1 is the current release line carrying the v2 session format and the client composition the fork's durable expectations must track; staying pins the fork to a superseded session format and defers the same work with more drift between.
- **Pin to upstream master instead of a tagged release.** Lost: the contract procedure prefers a release tag, and master moved 5,526 commits between the pin and the closure — the exact drift a master pin would absorb silently between observations.
- **Fix the src-mode persistence drop in the fork.** Lost: the drop reproduces on the untouched candidate and only in the non-authoritative src form while the CI-authoritative lib form is green; forking candidate behavior would add delta with no product signal.

## Consequences

What it cost: a multi-day validation lane (full test lane, CI-form E2E, clean-install package pipeline, four-platform CI matrix), two CI infrastructure events (the 2026-10-02 control-plane disable and the still-pending node24-win-x64 rerun), and explicit host-prerequisite overrides for `CC`/`CXX`, the pyenv shims, and the unaccepted Xcode license. What it bought: a forward pin with a complete evidence matrix, an M/U ledger with explicit removal conditions (U4 drops when a pin carries upstream's no-Web serving face; U6 drops when a pin carries `228f3aef83`), genuine cross-release migration proof from two real release artifacts, an ABI-verified native closure on four platforms, and the observation track running from the new pin.

## Related

- [Unexplained manual workflow disables on the fork (CI, Landlock Run)](2026-10-02-fork-ci-workflow-disable-investigation.md)
- [Packaging closure rebuilds the ABI-fragile native packages](2026-10-02-desktop-packaging-native-abi-rebuild.md)
- [Packaging smoke contracts](2026-10-02-desktop-packaging-smoke-contracts.md)
- [Release family excludes the private desktop apps](2026-10-02-release-family-excludes-private-apps.md)
- [Stage 11 packaging: reproducible self-contained release unit](../architecture/2026-08-29-desktop-stage11-packaging.md)
- [Stage 11 clean-install prerequisite](../architecture/2026-09-22-desktop-stage11-packaging-clean-install-prerequisite.md)
- [UPSTREAM.md](../../../../UPSTREAM.md) and the [upstream contract](../../../../apps/desktop/docs/upstream-contract.md)
