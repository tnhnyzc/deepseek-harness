/**
 * The host's default-application path-opening capability. A generic OS
 * capability seam: it names only the open operations a host may own, with no
 * Session, Settings, Electron, renderer, or Desktop vocabulary. The ordinary
 * upstream/Web deployment leaves it absent and the controllers fall back to
 * this package's subprocess openers; a host that owns the OS opener (the
 * packaged desktop, over its closed native channel) provides the same
 * capability by delegating to it.
 * @module @deepseek-ai/dsh-native-command/native-openers
 */

// Type-only side-effect import: brings the cordis module into scope so the
// Context augmentation below resolves, without importing any binding.
import type {} from '@deepseek-ai/cordis'

/**
 * The default-application path-opening capability a host may provide.
 * Resolution precedence (owned by the consumer controllers) is: direct unit
 * tests, then this production capability, then the subprocess fallback.
 */
export interface NativeOpeners {
  /** Whether this deployment can hand a path to a native opener. */
  canOpenPath(this: void): boolean
  /**
   * Open a path with the operating system's default application.
   * @param path - the absolute path the caller resolved and authorized.
   * @param signal - caller lifetime; abort terminates the pending open.
   */
  openPath(this: void, path: string, signal: AbortSignal): Promise<void>
  /**
   * Open a text document with the operating system's default editor.
   * @param path - the absolute text-document path.
   * @param signal - caller lifetime; abort terminates the pending open.
   */
  openTextFile(this: void, path: string, signal: AbortSignal): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The host's default-application opener, present only when the host owns
     * the OS opener. Absent on the ordinary upstream/Web deployment.
     */
    nativeOpeners?: NativeOpeners
  }
}
