# Agent Note: The dsh release family excludes private manifests

Status: implemented

English | [中文](2026-10-02-release-family-excludes-private-apps.zh.md)

## Problem

The dsh release family selects its members by directory pattern (`packages/!(experimental)/*/package.json` and `apps/*/package.json`) with no knowledge of whether a manifest is publishable. Upstream, that invariant holds: every manifest those patterns select is a publishable npm member. The fork's desktop apps (`apps/desktop`, `apps/desktop-runtime`) are `private: true` — they ship as a packaged Electron app, not to npm — yet the patterns select them anyway.

The re-pin to `dsh-v0.1.3-alpha.1` surfaced the consequence in the pull-request rehearsal. `release:pack` packs every selected member and validates each tarball against the publication payload policy (no `src/`, no `.js.map`, no `.d.ts.map`); a private app with no `files` field packs its entire tree and fails the validation. At publish time the failure moves: `release:verify`'s `verifyPublishable` refuses a family that carries a `private` member, so the fork's first real release would have failed from its own tag even though the rehearsal had turned green.

The version side had the same shape. The bump script's private tracking (`privateDshVersions`) covered `packages/*/*` only, so a private `apps/*` app that leaves the publish set has no mechanism to keep it in step with the family version. The static `constraints` gate ([workspace version coherence](2026-09-03-workspace-version-coherence-gate.md)) enforces the shared version on every dsh-named manifest, so the drift would still be caught — but only after it landed.

## Decision

`ReleaseFamily.members()` skips `private: true` manifests: the publish set contains exactly what npm will accept, and both families (dsh and vendor) inherit the exclusion from the shared method. Private members are not dropped from the release sequence: `bump.ts`'s `privateDshVersions` now also globs `apps/*/package.json`, so every private dsh package under `packages/` and every private app under `apps/` is bumped with the family version and tagged nothing, exactly as private packages under `packages/*/*` already were.

The boundary now equals the static gate's: the root, the publishable members, and every private dsh-named manifest, whether under `packages/` or `apps/`.

## Alternatives considered

**Give the private apps a publishable `files` payload.** A `files` field would make the rehearsal tarball pass, but private manifests stay inside the publish set: every rehearsal packs them, and the first real release still stops at `verifyPublishable`, forcing the decision from a tag instead of from a pull request. It papers over the boundary rather than drawing it.

**Special-case the fork's app directories in the family patterns.** Keeping the patterns upstream-shaped and filtering by a directory list (or by the desktop app names) would work, but the filter would restate the `private` field that already names the intent; a manifest that stops being private would silently rejoin the publish set the moment its payload was ready, with no gate to notice.

## Consequences

The dsh family now reports 248 members at `0.1.3-alpha.1` (250 before the exclusion), and `release:verify` resolves the publish order without the private apps. `release:pack` no longer builds or validates tarballs for them. A future app that becomes publishable joins the release sequence by removing `private: true` — no pattern, script, or gate change needed; its first pack rehearsal then checks its payload, and its first `verifyVersions` run checks its version. The `members()` change is a fork-level edit to an upstream script; a re-pin onto a future upstream that adds its own private app members would need this exclusion re-applied, and the `families.spec.ts` assertions naming the two desktop apps fail immediately if either app is renamed or made publishable.
