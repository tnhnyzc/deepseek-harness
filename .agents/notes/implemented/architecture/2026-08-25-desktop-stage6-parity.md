# Agent Note: desktop stage 6 — DSH web parity over the desktop transport

Status: implemented

English | [中文](2026-08-25-desktop-stage6-parity.zh.md)

## Problem

Stage 6 (SPEC §15) must prove the desktop is semantically equivalent to `dsh web` for the normal user workflow before any desktop UX is added: session list, new session, rename, workspace selection, conversation rendering, streaming, trajectory/tool rendering, approval, question, cancellation, model/provider settings, and session recovery after restart. DSH stays the sole owner of every agent semantic (desktop = carrier only), the proof must run the real pinned client tree in the real app, and the test environment has no API key and no drivable OS directory dialog.

## Decision

**Parity harness.** `apps/desktop/tests/dsh-parity.spec.ts` — one profile, eleven sequential tests against the built app: real Electron (`_electron.launch` of `dist/main`), real desktop-runtime child, real pinned DSH composition, real client tree. The only non-real element is a scripted deterministic SSE provider on loopback HTTP, reached through the pinned DeepSeek provider's `DEEPSEEK_BASE_URL` seam — the same keyless seam the web lane's real-host e2e uses. The provider answers per-turn scripts keyed by a marker in the prompt text: paced text chunks (streaming proof: the partial text is visible before the turn finishes), tool calls (`bash`, `ask_user_question`), and escalation re-requests carrying `sandbox_permissions: 'workspace-write'` (approval proof). The suite self-skips without the built artifacts and holds a console gate: zero renderer `console.error`/page errors.

**Surface coverage.** (1) seeded workspace lists with its blank session and an unlocked composer; (2) incremental streaming; (3) bash tool card plus trajectory rendering; (4) approval `Allow once` runs the escalation; (5) `Reject` does not run it; (6) `ask_user_question` answered through the question composer; (7) cancellation mid-stream; (8) rename through the session row menu, durable to the log; (9) second session via `New session`; (10) model/provider settings dialog; (11) clean-restart recovery (both sessions, none running, no welcome notice, history reopens, rename durable).

**Workspace selection.** The OS directory dialog cannot be driven programmatically. Selection is proven through the seeded-registry plus startup auto-selection path: the harness writes a version-2 workspace registry (`<DSH_HOME>/storages/workspace.json`, `unit: { name: 'workspace', version: 2 }`) before first launch, and the client's `startInitialSelection` selects the single workspace and reuses its blank session. The native dialog itself is the manual-smoke step.

**Keyless client mechanics encoded by the harness.** Facts a parity consumer must know about the pinned client tree — all observed and asserted, none patched:

- The first-run "Internal Testing Notice" (`packages/client/ui-settings-models/src/client/WelcomeNotice.tsx`) mounts only after its `ui-onboarding` settings scope has loaded — i.e. **after** `#root[data-state=ready]` — and its `OnboardingSurface` (`packages/client/ui-primitives/src/OnboardingSurface.tsx`) portals a body mask that holds `#root` inert until acknowledged. A one-shot visibility check at ready misses the notice, and later clicks are intercepted by the mask. The harness acknowledges in `beforeAll`: wait visible → click `Continue` → wait detached, tolerating absence (already acknowledged). Acknowledgement persists in the `ui-onboarding` settings namespace (`welcomeNoticeVersion`, exact match against `2026-08-13.1`), so a relaunch shows no notice — asserted in the restart test.
- The sidebar is collapsed by default; each session row's action cell (`.rowActions`, `Rows.module.css`) is `display: none` until the row is hovered, and the menu button carries `aria-label="Session actions for {title}"` — rename is hover → click → `Rename session` → `input[aria-label="Session name"]`.
- The composer is locked with `readonly` on `[data-composer-card] textarea` (never `disabled`), and its placeholder changes after the first turn; the stable selector is the card's textarea, not the placeholder.
- A collapsed tool card shows tool name plus description; the command text renders only in the expanded seat. The Chat/Trajectory switcher is `role="tab"`, not buttons.
- Session logs at `<DSH_HOME>/sessions/<projectKey(cwd)>/<id>/session.jsonl.zstd` are **concatenated Zstandard frame containers** (one frame per durable write batch; structural decode via `scanZstdFrames`, `packages/session/session-persistence-jsonl/src/zstd.ts`). Node's `zstdDecompressSync` decodes only the first frame of such a file, so the harness ports the backend's frame scan to inspect durable state (title events, rename durability).

**Restart semantics (evidence).** The graceful shutdown chain is correct as wired (before-quit → supervisor stop → runtime `runtime.shutdown` → fiber dispose → write-behind quiescence, bounded 5 s self-force): the durable log contains every title event in seq order (fallback title, provider title, user rename). Two DSH-owned cold-start behaviors surfaced, both shared with `dsh web`, neither a carrier defect:

- The restarted **list** row title could briefly show the projection-cache checkpoint title: the cache (`packages/session/session-projection-cache`; web-app row config `writeEveryEvents: 200`, `writeIntervalMs: 5000`) checkpointed at the last `turn/end` or session disposal, and a rename that landed after the last `turn/end` was absent from the cold-start row. Opening the session replayed the log tail and the row relabeled to the user rename; no data loss. Stage 8 resolved this at the DSH seams (the disposal drain now durably checkpoints the rename, and the cold list asserts the latest title post-restart; `2026-08-26-desktop-stage8-correctness.md`).
- The restarted client could log one transient `[cordis-client-runner] syncing inspect providers failed: … no active Connection` while its inspect sync lost the connection bring-up race. Stage 8 removed the race (the inspect manifest stages until the connection readiness seam; `2026-08-26-desktop-stage8-correctness.md`), and the gate's allowlist with it.

Both are race-window / cache-staleness concerns owned by Stage 8 (deferred: race windows, event loss, reconnect pathology, pending interactions across renderer reload, adversarial disconnect), not stage 6 scope. The restart test asserts the true parity outcome — sessions recovered, nothing running, history reopens, the row relabels to the user rename on open, the rename durable in the log, no welcome re-shown — and fails on any renderer error (the stage 6 allowlist for the inspect transient is gone; the gate is fully strict).

**Carrier defect fixed (composition).** `apps/desktop-runtime/package.json` declared only the two bundle packages (`dsh-base`, `dsh-web-app`); the composed web-app configuration additionally resolves preset/tool rows (agent-tool-presentation, persona, terminal, terminal-bash, tool-ask-user, tool-bash-persistent, tool-cordis, tool-pwsh-persistent) through the profile `node_modules` at boot, so session creation failed. All eight were added as workspace dependencies; knip's `apps/desktop-runtime` `ignoreDependencies` generalized from the two named bundles to `@deepseek-ai/.+`, because the runtime graph is resolved by the cordis composition, not by static imports.

## Consequences

- Stage 6 exit criterion met: every SPEC-listed surface is proven on the pinned UI over the desktop transport with DSH semantics untouched; the only surface not proven automatically is the native directory-dialog click (manual smoke).
- The pinned client tree gains **zero** stage 6 modifications; the stage 4 set (M1–M3) remains the only divergence.
- The parity suite doubles as the built-artifact smoke (it runs the `dist/` output plus the runtime and bundled node) and holds the console gate for the whole journey.
- Full desktop suite: 125/125 (114 baseline + 11 parity).
- Two DSH findings surfaced (both resolved in stage 8, `2026-08-26-desktop-stage8-correctness.md`): projection-cache cold-start title staleness (now checkpointed by the disposal drain) and the cold-start inspect-sync race (now armed at the connection readiness seam).
- The `DEEPSEEK_BASE_URL` scripted-provider seam is the standing keyless proof vehicle for desktop provider-facing behavior; real-API verification stays with the web lane's e2e.

## Alternatives considered

- Real-API provider for the parity run — rejected: nondeterministic, network-dependent, key-gated; the web lane's own keyless e2e already uses the `DEEPSEEK_BASE_URL` seam, which keeps the pinned DeepSeek provider's wire path real.
- Native automation of the OS dialog (AppleScript/robotjs) — rejected: platform-specific and flaky in a portable suite; the dialog is a thin Electron `showOpenDialog` wrapper whose only unproven step is the final user click.
- A desktop-side fix for the stale list title (refetch or client patch) — rejected: DSH owns the session list and the projection cache; the carrier-only rule forbids a desktop replacement, and the correct home for a fix is DSH.
- Forcing a projection-cache checkpoint before the restart test's close (e.g. an extra turn after the rename) — rejected: it would hide a real DSH cold-start behavior and change the user journey under test.
- One profile per surface (isolated tests) — rejected: one profile exercising the full journey in sequence is the closer approximation of the normal user workflow, and the restart test needs the state the earlier tests built.
