/**
 * The desktop's `ctx.directoryPicker` provider: the pinned native seat
 * (`kind: 'native'`), backed by the desktop native channel — Electron's OS
 * directory chooser in the main process — instead of the host-native
 * subprocess choosers (osascript, Zenity/KDialog, the Windows COM dialog),
 * which a forked runtime child would otherwise spawn. The DSH contract is
 * unchanged: `host.pickDirectory` consumes `capability().pick(signal)`, an
 * operator cancel is null, and a caller abort terminates the pick.
 * @module @deepseek-ai/dsh-desktop-runtime/directory-picker
 */

import { DirectoryPicker, type DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import type { Context } from '@deepseek-ai/cordis'

/** The native pick delegate: the desktop runtime provides it over the native channel. */
export type DesktopDirectoryPick = (signal: AbortSignal) => Promise<string | null>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The desktop native pick delegate (provided by the desktop runtime boot). */
    desktopDirectoryPick: DesktopDirectoryPick
  }
}

/**
 * The desktop native directory picker. The capability object is stable for
 * the service lifetime, as the seat's contract requires; the delegate is
 * captured once at construction (the injected service is final for the
 * context's life).
 */
export default class DesktopDirectoryPicker extends DirectoryPicker {
  static inject = ['desktopDirectoryPick']

  private readonly nativeCapability: DirectoryPickerCapability

  constructor(ctx: Context) {
    super(ctx)
    const pick = ctx.desktopDirectoryPick
    this.nativeCapability = { kind: 'native', pick }
  }

  /**
   * The native interaction capability.
   * @returns the stable `native` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
