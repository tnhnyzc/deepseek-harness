/**
 * The M4 deployment opener seam: a host may carry the default-application
 * opener itself (an Electron main process answering over its capability
 * channel, for instance) and inject that carrier into the API gateway.
 * The seam is structural and optional: every deployment that does not
 * provide it keeps the existing behavior exactly (the DSH native opener
 * closures, and the platform's `canOpenNativePath` detection), so the
 * change is Web-unchanged by absence. The DSH API is unchanged — the
 * injected closures ARE the `ApiProxyDefaults` openers, and every
 * open/error/cancel mapping (including the `cancelled` business code on
 * abort) stays in this package.
 * @module @deepseek-ai/dsh-host-apiproxy
 */

/**
 * Default-application openers supplied by a deployment. All members are
 * optional; a member left undefined keeps the package's own behavior for
 * that operation.
 */
export interface NativeOpeners {
  /**
   * Open one path with the deployment's default application.
   * @param path - the absolute path the DSH layer resolved and authorized.
   * @param signal - the caller's lifetime; the deployment must honor it.
   */
  openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /**
   * Open one text document for reading.
   * @param path - the absolute path the DSH layer resolved and authorized.
   * @param signal - the caller's lifetime; the deployment must honor it.
   */
  openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional deployment openers (the M4 seam); absent in the web app. */
    nativeOpeners?: NativeOpeners
  }
}
