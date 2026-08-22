# Upstream Pin

This repository is the desktop fork of
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(fork: [tnhnyzc/deepseek-harness](https://github.com/tnhnyzc/deepseek-harness)).
The desktop delta is the diff between the pinned SHA below and the desktop
release commit. See `ARCHITECTURE.md` and `SPEC.md`.

## Pinned revision

- Upstream repository: `https://github.com/deepseek-ai/deepseek-harness`
- Upstream SHA: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Release tag: `dsh-v0.1.1-rc.2`
- Pinned: 2026-08-22
- The SHA was the live `master` HEAD at pin time (verified with
  `git ls-remote`).

## Toolchain at pin

| Item | Value |
| --- | --- |
| Root package | `@deepseek-ai/dsh-root@0.1.1-rc.2` |
| Node engine requirement | `^22.19.0 \|\| >=24.0.0` |
| Node used for pin verification | `v22.23.2` |
| pnpm pin (`packageManager`) | `pnpm@11.7.0` |
| pnpm used for pin verification | `11.7.0` |

## Baseline status at pin

Stage 0 task 0.2 (untouched upstream baseline), run 2026-08-22 on macOS
arm64 with Node `v22.23.2` and pnpm `11.7.0`:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass (lockfile unchanged). Two benign WARNs link unbuilt demo bins (`dsh-jsonrpc-agent`, `dsh-acp-demo`); `pnpm run build` resolves them |
| `pnpm run build` | pass (21 s; vite prints informational chunk-size warnings) |
| `pnpm run test` | pass: 863 files / 14593 tests; 9 files / 114 tests skipped |
| `pnpm run test:gui` | pass: 284 files / 3997 tests; 1 skipped |
| `pnpm run test:e2e` | pass: 32 files / 129 tests; 29 files / 75 tests self-skip (no `DEEPSEEK_API_KEY` / provider keys) |
| `DSH_BUILD_CLIENT_PROFILE=official pnpm run build` | pass; build record carries `DSH_CLIENT_BUILD_PROFILE: official` |
| `DSH_SNAPSHOT=replay pnpm run test:web:built` | pass: 83 files / 281 tests; 1 file / 15 tests skipped |
| pre-push `pnpm run typecheck` (host + client `tsc -b`) | pass (72.9 s) |
| `pnpm run dsh web --no-open --port 0` | booted `http://127.0.0.1:<port>`; `GET /` 200; clean shutdown |

`pnpm run check:ci` is the CI-owned primary gate matrix and was not
rehearsed locally in full, per the repository's own AGENTS.md.

### Environment prerequisites

- `DEEPSEEK_API_KEY` is not set and no root `.env` exists, so every
  real-model case self-skips (repo e2e convention, including the full-flow
  `apps/web/tests/smoke-real.e2e.ts` smoke). Keyless replay lanes are the
  deterministic baseline.
- The web browser lane requires Playwright Chromium:
  `pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install
  chromium` (same step as CI).
- The web browser lane reads **official-profile client artifacts**: CI's
  `ciBuildGate` (`scripts/run-gates.ts`) sets
  `DSH_BUILD_CLIENT_PROFILE=official` before the `web-snapshot` gate. A
  dev-profile build omits the official brand slots
  (`packages/client/ui-brand-official/src/client/index.ts`), which makes
  `built-boot.snapshot.ts` fail. First local run with a dev-profile build
  produced exactly that single failure; the CI-equivalent sequence above is
  green.

### Walkthrough mapping (SPEC task 0.2, steps 4-14)

Driven by the upstream's own keyless browser e2e lane (real Chromium, real
host boot per test file, recorded model traffic) plus the manual boot above.

| Step | Evidence |
| --- | --- |
| 4. launch `dsh web` | manual boot/serve/shutdown (above); every web-lane file boots the same server |
| 5. create a session | `cold-blank-session.e2e.ts`; `built-boot.snapshot.ts` (fixture session tree) |
| 6. select a workspace | `workspace-management.e2e.ts` (12 tests, dialog add/rename/delete) |
| 7. submit a prompt | `replay-round-trip.e2e.ts` "drives the recorded prompt to a settled turn" |
| 8. verify streaming | `live-interactions.e2e.ts`, `chat-continuous-conversation.e2e.ts`, `chat-scroll-contract.e2e.ts` |
| 9. exercise a tool | `cordis-tool-round.e2e.ts`, `code-mode-round.e2e.ts`, `web-search-round.e2e.ts`, `built-boot.snapshot.ts` (bash round + diff cards) |
| 10. exercise an approval and answer it | `approval-composer.e2e.ts` "caps the long command, answers through the panel, and runs the escalated command" (real pending approval) |
| 11. answer a user-question prompt | `question-composer.e2e.ts` "asks through the composer, answers, and completes with the answer logged" |
| 12. cancel an active turn | `live-interactions.e2e.ts` "cancels a hung stream deterministically", `bash-abort-row.e2e.ts`, `subagent-interrupt.e2e.ts` |
| 13. restart DSH | per-file host boot/teardown cycles across the lane; `subagent-conversation.e2e.ts` reload onto the restart baseline; manual boot/kill cycle |
| 14. reopen the session | `built-boot.snapshot.ts` reopens the persisted fixture session end to end; `subagent-conversation.e2e.ts` restart-baseline lineage discovery after reload |

No contradiction with SPEC.md or ARCHITECTURE.md was found. The one
observed failure is an execution-prerequisite artifact (dev-profile build
in a lane that requires official-profile artifacts), as documented above;
the untouched upstream at the pin is green across all keyless lanes.

## Desktop patches

| File | Change | Stage |
| --- | --- | --- |
| `scripts/check-workspace-constraints.ts` | `privateAppDirectory` carve-out: `apps/desktop` and `apps/desktop-runtime` are private workspace members, exempt from the release-member publication rules and the app publication-files policy (fork-level gate amendment B1 from the upstream contract) | 1 |
| `pnpm-workspace.yaml` | `allowBuilds.electron: true` (pinned Electron binary download); override pinning `@electron/rebuild` to 4.2.0 because the Forge packages' 3.x rebuild sub-dependency resolves node-gyp from a git repository, which `blockExoticSubdeps` rejects | 1 |

## Known incompatibilities

- `pnpm run hygiene` is red **at the pin itself**:
  `pnpm run rescope-vendor:check` fails with two stale exact edits in
  `scripts/rescope-vendor.ts` (`knip-logger-console`,
  `vendoring-cookbook-name-invariant-zh`) that point at files that no longer
  exist in the tree. Verified in a clean detached worktree of the pin.
  Pre-existing upstream defect; fork-level fix deferred.
- Electron Forge 7.11.2's CLI system check requires a hoisted pnpm layout
  (or a custom hoist pattern), which this monorepo does not use;
  `skipSystemCheck` no longer exists in Forge 7. Stage 1 therefore verifies
  bundle assembly with `@electron/packager` 18.4.4 (the assembler Forge uses
  internally) and keeps `forge.config.ts` as the stage 11 packaging
  specification.
