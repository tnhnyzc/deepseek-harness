# Agent Note: Desktop Stage 11 packaging requires a clean host install, not historical store contents

Status: implemented

## Problem

During the `dsh-v0.1.3-alpha.1` re-pin, the desktop closure-audit and the `package` script failed on this host with `dependency @koromix/koffi-darwin-x64 is not installed`, blocking the arm64 `.app` build. The immediate trigger was an accidental `pnpm store prune` that removed cached non-host artifacts (the non-darwin-arm64 `@koromix/koffi-*` prebuilds) from the global pnpm store. On a darwin-arm64 host a normal `pnpm install` does not re-materialize cross-platform optional native prebuilds, so the pruned prebuilds were left as broken symlinks that the audit tripped on.

## Decision

The investigation confirmed the intended design is target-specific (each runner packages its own platform), so no source or packaging change is required:

- `closure.ts` states the contract: "each CI runner packages its own platform, whose workspace install holds that platform's prebuilds."
- Empirically, a clean darwin-arm64 install materializes only `koffi-darwin-arm64` in the koffi container (not the other platform prebuilds). The closure-audit audits whatever the host install actually holds; it is not over-scoped to a cross-platform matrix.

A clean install is therefore the supported, reproducible starting point for packaging. Historical pnpm-store contents are not a required build input, and a damaged or cross-platform-populated local store is not a supported local state.

## Local validation and the Xcode-license gap

After restoring a clean install (a fresh temporary pnpm store + frozen-lockfile install), the closure-audit passed (8/8) and the `package` pipeline ran through build, closure staging, Electron packaging, fuses, ad-hoc signing, and layout verification (33 checks). It stopped only at the boot smoke on `Cannot find module './build/Release/fs_ext.node'`: the `fs-ext` native build requires the Xcode license (`sudo xcodebuild -license`), which this host has not accepted, plus local network instability slowed the install. This is a host prerequisite / local environment limitation, not a re-pin product or packaging regression.

The authoritative completion proof (frozen install, native build, closure audit, package creation, boot smoke, native-module smoke, packaged-app, packaged-user-journey) is delegated to the existing clean macOS CI packaging runner (`ci.yml` → `desktop-macos`, arm64), which has the Xcode license and stable network. No production or packaging source was changed to encode this local incident.
