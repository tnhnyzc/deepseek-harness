# Agent Note: Desktop native opener as an optional host capability

Status: implemented

English | [中文](2026-09-15-desktop-native-opener-host-capability.zh.md)

## Problem

The packaged desktop runs its DSH runtime as a supervised child process and routes every OS capability call — choosing a directory, opening a path, opening a text document — to Electron main over the closed native channel, because the child must not open OS files directly. Before the `dsh-v0.1.3-alpha.1` re-pin, the desktop injected its default-application opener into the gateway through an apiproxy that read the `nativeOpeners` host service.

The re-pin moved the open call onto the `SessionController` and `SettingsController` remote methods (`session/openWorkspacePath`, `settings/openSettingsDocument`, `settings/openAgentPresetDirectory`). Those controllers resolved their open operation only from unit-test `internals`, never from the host service. The desktop kept *providing* `nativeOpeners` (delegating to the native channel) while the controllers *never read it*: the production opener wiring was orphaned, so a packaged desktop had no path from a resolved DSH path to a native opener.

The text-document opener compounded the split. The old desktop design kept it on the DSH subprocess opener because the Electron `shell` API names no separate text-editor intent, while the directory chooser and the default-application path open already crossed the channel. The two open intents therefore lived on two different OS paths.

## Decision

The opener becomes a generic optional host capability, `NativeOpeners`, owned by `@deepseek-ai/dsh-native-command` (which both controllers already depend on). It names only the open operations a host may own, with no Session, Settings, Electron, renderer, or Desktop vocabulary:

```ts
interface NativeOpeners {
  canOpenPath(): boolean
  openPath(path: string, signal: AbortSignal): Promise<void>
  openTextFile(path: string, signal: AbortSignal): Promise<void>
}
```

A host that owns the OS opener registers it under the `nativeOpeners` service, declared by a `Context.nativeOpeners` augmentation in the same package. The controllers resolve the open operation fresh at call time — never captured at construction — in a fixed precedence: the direct unit-test `internals`, then the host's `nativeOpeners` capability, then this package's subprocess opener fallback. The availability probe `canOpen` follows the same precedence: the unit-test probe, then the explicit `nativeOpen` config policy, then the capability's `canOpenPath()` or the presence of a reachable opener.

The desktop runtime provides the capability by delegating all three operations to the native channel, and the channel gains a `path.openText` method so a text document crosses to Electron main like any other open. Main dispatches `path.open` and `path.openText` to its capability registry; the Electron `shell` API names no separate text-editor open, so both intents use the OS default application. The text-editor intent is therefore preserved at the DSH and protocol layer and honored by the subprocess fallback in non-desktop deployments, while the desktop uses the default application for both.

The real-boot acceptance (`apps/desktop-runtime/tests/native-boot.spec.ts`) and the main-side integration (`apps/desktop/tests/native-integration.spec.ts`) drive the alpha.1 endpoints — `directoryPicker/pick`, `session/openWorkspacePath`, `session/canOpenWorkspacePath`, and `settings/openSettingsDocument` — and assert the `path.open` and `path.openText` native requests each raises, including caller abort and the main-issued cancel terminal.

## Alternatives considered

**Restore the rc.2 apiproxy injection.** The rc.2 transport consumed `nativeOpeners` in an apiproxy that no longer exists in alpha.1. Re-adding a controller-specific injection path would reintroduce the process-specific wiring the re-pin removed and leave the text-document opener split across two mechanisms.

**Capture the opener at construction.** Reading `nativeOpeners` once in the constructor couples the controller's capability to Loader ordering — the provider may install after the controller constructs — and can leave a stale callable if the provider is later removed. Operation-time resolution reads the current capability and degrades to the fallback cleanly when it is absent.

**Keep the desktop text-document opener on the subprocess.** This avoids a new channel method but leaves the desktop's opener behavior split: path opens cross the channel while text-document opens spawn a subprocess from the runtime child. That is an unexplained asymmetry and a second OS path the desktop would own for no benefit.

## Consequences

Both controllers honor a host-provided opener in the packaged desktop and fall back to the subprocess opener in the ordinary upstream/Web deployment, where the `nativeOpeners` service is simply absent. Adding the capability to a host requires no controller change, and a host that removes the provider degrades to the subprocess opener without a stale reference.

The native channel's closed method set gains `path.openText`; every parser, demux guard, and main-side dispatch that switches on the method set is updated and covered by the protocol and channel specs.

The desktop's text-document open uses the OS default application rather than a text-editor-forced open (Electron `shell` has no editor intent). This is a deliberate, documented difference from the subprocess `open -t` behavior in non-desktop deployments.
