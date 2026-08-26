# Agent Note: desktop stage 9 — runtime crash recovery: deterministic failure, restart, and reconnection

Status: implemented

English | [中文](2026-08-26-desktop-stage9-crash-recovery.zh.md)

## Problem

Stage 9 (SPEC §23) must prove that when the standalone DSH runtime process dies unexpectedly — mid-generation, mid-tool, or mid-interaction — the desktop recovers deterministically: the renderer stays alive, every operation of the old transport terminates deterministically, the UI enters a failed state with the death reason and diagnostics, a user-requested restart boots a new runtime generation, and the DSH client reconnects and reconstructs the sessions from persisted state. An interrupted turn must never be reported as completed, and the desktop layer must not fabricate session events.

The supervisor lifecycle built in stages 2–7 already implemented most of this, but nothing had been proved under a real crash injection: every earlier test used graceful shutdown or a pre-ready failure.

## Decision

**The in-place re-boot design proved sufficient; no renderer or supervisor change was needed.** The stage opened with a full inspection of the linchpin paths (renderer `transport.ts`, the module facade, the carrier, the supervisor). The stage 4 in-place re-boot was structurally deterministic under a port close: each `AppWebEntry.run()` makes a fresh Context and module system, the `window.__ModuleLoader__` facade is a plain assignment (safe to re-evaluate), the preload bundles are lazy CJS (evaluation only registers factories), the carrier re-installs `__DSH_TRANSPORT__` per generation, and `teardownAll` on port close rejects every in-flight fetch/stream operation, cancels the credit windows, and wakes the parked producers. The E2E suite confirmed this end to end; no hardening was required.

**Interrupted-turn crash recovery is pinned DSH persistence, not desktop code.** When a new generation cold-loads a session whose log ends mid-turn, the persistence coordinator applies `interruptedTurnClosers` (`packages/core/session/src/repair.ts:27`) in `prepareCore` (`packages/session/session-persistence/src/coordinator.ts:903`): a synthetic `tool/result` error for every assistant tool request without a result (`TOOL_NOT_STARTED` when no `tool/call` was recorded, `TOOL_OUTCOME_UNKNOWN` when one was), then `step/end`, then `turn/end { reason: { kind: 'interrupted' } }`. The synthesis is deterministic — sequences continue the log and timestamps reuse the last real event. The mechanism is shared with `dsh web` and the CLI, and it is exactly the stage's two invariants: the interrupted turn ends `interrupted`, never `completed`, and the desktop layer fabricates no session event — the closers come from the pinned persistence layer, on load.

**Unit level: two crash modes on the supervisor fixture.** `apps/desktop/tests/fixtures/runtime-fixture.mjs` gained `crash-once` (first launch exits with code 3 after ready, the retry succeeds) and `kill` (ready, then SIGKILL itself). `apps/desktop/tests/runtime.spec.ts` (now 10) pins that a user-requested restart after an unexpected death reaches ready again, and that a signal death is reported with the generation's diagnostics retained across the restart.

**The E2E crash-recovery suite.** `apps/desktop/tests/dsh-crash-recovery.spec.ts` (8) drives the built app — real Electron, real desktop-runtime, real pinned composition — against a scripted deterministic SSE provider. Crash injection is a process-group SIGKILL of the runtime pid: the forked child leads its own group, so the group kill reaches its descendants — the shell tool, the subagent worker — exactly like the supervisor's forced kill. Discovery requires the process to be the runtime entry **and** a direct child of the suite's Electron main: other suites boot their own runtimes from the same entry in parallel, and a first parallel run proved that killing the wrong process breaks the other suite's tests while timing out the killer's own.

The eight properties: (1) **idle** — the failure screen shows the death reason, the renderer is alive, in-flight transport operations are rejected, and a user-requested restart boots and reconnects; (2) **mid-generation** — the turn's tail is durably closed `interrupted`, never `completed`, and a follow-up prompt on the same session completes; (3) **during a shell tool** — the recorded `tool/call` is closed with the pinned `TOOL_OUTCOME_UNKNOWN` recovery text and rendered by the pinned UI (`Failed` + tool name), and the group kill took the child process with it; (4) **approval wait** — the pending approval is live Mux state: it dies with the runtime, no stale panel survives recovery, and the session resumes; (5) **question wait** — the same for a pending `ask_user_question`; (6) **subagent** — the parent turn is closed by the pinned closers while the child session, persisted separately, never completes; (7) **a second generation** — two crash generations in one app lifetime leave every persisted fact intact, including the interrupted-turn recovery rendering; (8) **quit while failed** — quits cleanly without hanging.

## Facts the stage settled

- **The real runtime is quiet in normal operation** — nothing on stdout/stderr, so the supervisor's diagnostics ring is legitimately empty after a clean crash; the failure screen renders its diagnostics `<pre>` only when the ring is non-empty (the fixture `kill` mode proves the retention path).
- `approval/requested` and `question/requested` are **live Mux frames**, not log events: a pending interaction is runtime state that a crash destroys entirely, and the failure screen must not pretend it survived.
- The pinned UI renders an interrupted tool turn as `Failed` + the tool name + the pinned recovery text ("The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown."); the tool description and command are not in the collapsed row, so DOM probes must use the recovery text.
- A delegated subagent shows a `1 subagent` badge in the sidebar, not the child's description; the child session is a separate `session.jsonl` under the same home, excluded from the parent's balance checks.
- The runtime boots in about a second; the full eight-property suite (seven crash/restart cycles) runs in about 14 seconds.
- A cross-suite E2E crash probe must disambiguate the runtime by parent pid, not entry path alone.

## Consequences

- Stage 9 exit criteria met with no carrier changes and no new upstream modifications: M1–M3 remain the complete Desktop-enablement set, U1–U3 remain the complete shared fork-delta set, and the crash-recovery semantics are pinned persistence behavior that the suite now pins end to end.
- The desktop suite (`apps/desktop`) is now 162 (152 baseline + 2 supervisor unit + 8 crash E2E); 276 including the desktop-runtime package, all green.
- The supervisor's failure/restart path is now proved under a real kill -9 in every crash window; the diagnostics-retention path is proved by the fixture, since the real runtime writes nothing to the ring in normal operation.
- The crash-recovery suite is the standing regression guard: a future change that makes a crash anything but deterministic — a turn reported completed, a stale pending panel, a hung quit — fails it.

## Alternatives considered

- Desktop-layer synthesis of the closers (renderer or runtime writing its own `turn/end` after a crash) — rejected: the pinned persistence layer already does this deterministically on load, shared with `dsh web` and the CLI; a desktop-side copy would be a second source of truth that could diverge from the pinned repair.
- Automatic restart on crash instead of the failure screen and user-requested restart — rejected per SPEC §23: a crash is a user-visible failure; the failure screen shows why, and the user decides whether to retry.
- Killing the runtime by its pid alone (not the process group) — rejected: the shell tool's children and the subagent worker would survive, and the recovery transcript would diverge from the production supervisor's forced group kill.
- A crash probe that discovers the runtime by entry path alone — rejected on evidence: in a parallel suite run it SIGKILLed the desktop-ux suite's runtime, breaking eight of its tests while timing out its own idle test; parent-pid matching makes the probe suite-local.
