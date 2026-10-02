# Agent Note: The desktop packaging smokes meet the migrated contracts

Status: implemented

English | [中文](2026-10-02-desktop-packaging-smoke-contracts.zh.md)

## Problem

The re-pin onto `dsh-v0.1.3-alpha.1` moved the desktop packaging smokes onto a different lockfile graph and a different composer, and two harness assumptions broke against the product — the product itself was correct in both cases.

**The resolution smoke anchored colliding consumers by name.** `buildProbes` located each probe's consumer with `findStagedPackageDirs(runtimeDir, consumer.name)` and took the first copy, on the premise that a consumer is one instance. The alpha.1 graph makes `debug` a same-name/different-version collision (`2.6.9` and `4.4.3`), and staging correctly places one copy per consumer location — `compression` carries `debug@2.6.9` with its `ms@2.0.0` shadow, `express` carries `debug@4.4.3` with its `ms@2.1.3` shadow. The probe for the `debug@2.6.9 -> ms@2.0.0` edge anchored on whichever `debug` copy the walk found first; when that was the `4.4.3` copy, the walk resolved `ms@2.1.3` against the edge's `2.0.0` and the artifact failed a check its own staging had satisfied.

**The packaged-app smoke typed into Lexical with a DOM mutation.** The carrier round trip inserted its text with `document.execCommand('insertText', ...)` and submitted with a synthetic `KeyboardEvent`. Against the release-B Lexical composer, `execCommand` reports success while the browser's uncontrolled DOM mutation is reconciled away by the editor's state — the composer stays empty, Enter submits nothing, the scripted provider never receives a request, and the canary times out. Instrumented evidence: `execCommand` returned `true` with `textContent` empty before, after, and at the 120-second deadline.

## Decision

**Anchor each probe on the staged copies whose manifest matches the edge's consumer version.** `buildProbes` now filters the candidate directories by reading each staged `package.json` and keeps the copies whose `version` equals the consumer's version; the probe dedupe key and the per-consumer cache are keyed by `name@version`, so both edges of a colliding consumer are probed from their own instances. Same-version copies remain interchangeable (one instance, one manifest), which is the premise that still holds.

**Drive the composer through the browser input pipeline.** The smoke focuses the composer in the page, inserts the turn with CDP `Input.insertText` (the browser delivers a trusted `beforeinput`, which is the path Lexical consumes), and submits with `Input.dispatchKeyEvent` Enter keydown/keyUp (a trusted keydown through Lexical's `KEY_ENTER_COMMAND` keymap). The turn reaches the scripted provider over the packaged runtime and the canary renders.

## Alternatives considered

**Treat both failures as product regressions and change the app.** The staged tree and the composer both behave per their contracts; the failures were the smokes' assumptions about their own operands (which copy is "the" consumer; which input event the editor consumes). Changing the product to satisfy a stale harness would corrupt the contract the harness exists to check.

**Make the resolution probe read the audit report's consumer locations instead of the staged tree.** The audit report records the graph, not the staged layout; probing from it would verify the report against itself. The smoke's purpose is to prove the staged tree resolves the way the lockfile graph says it must, so the anchor must come from the staged tree — filtered to the right instance.

**Dispatch a synthetic `beforeinput` from the page instead of using CDP input.** A page-dispatched `beforeinput` is untrusted and some editor paths (and the browser's default insertion) treat it differently from the pipeline event; CDP input is the same mechanism the browser uses for real typing and IME commit, so the smoke exercises the input path the user's keystrokes take.

## Consequences

Both smokes are harness-only changes: no product code, no staging code, no audit code moves. The resolution smoke verified all 78 staged edges under the bundled Node on the re-pinned graph; the packaged-app smoke completes its full contract — UI boot, security baseline, native channel, bounded carrier round trip, zero product listeners, crash/restart to a fresh generation — on the packaged artifact, and the local `package` pipeline (build, staging, fuses, layout, archive, all four smokes) runs green end to end. If a future graph introduces a colliding consumer the probe set did not expect, the same version-anchored rule handles it; if a future composer stops consuming the browser input pipeline, `Input.insertText` failing to land text will surface at the same canary deadline.
