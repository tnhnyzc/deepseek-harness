/**
 * The supervised runtime lifecycle facts, shared verbatim between the
 * main-process supervisor, the preload bridge, and the renderer. Pure types:
 * no runtime code crosses these boundaries.
 * @module @deepseek-ai/dsh-desktop/src/shared/runtime-state
 */

/** The supervised runtime lifecycle states; transitions are explicit. */
export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed'

/** The capability facts the runtime reports at readiness. */
export interface RuntimeCapabilities {
  /** The API gateway composes standalone (the stage 3 transport's host). */
  apiProxy: boolean
  /** An HTTP server is mounted (must be false: no localhost web server). */
  httpServer: boolean
}

/** The `runtime.ready` payload the runtime process emits. */
export interface RuntimeReadyPayload {
  runtimeVersion: string
  dshVersion: string
  capabilities: RuntimeCapabilities
}

/** One observable supervisor fact the renderer projects. */
export interface RuntimeStateView {
  state: RuntimeState
  ready?: RuntimeReadyPayload
  /** One-line reason for a failed state. */
  reason?: string
  /** The retained recent output of the runtime process. */
  diagnostics?: string
  /** True when the single automatic pre-ready retry has been consumed. */
  autoRetried?: boolean
}

/** The supervision bridge surface the preload exposes to the renderer. */
export interface DshDesktopApi {
  /** The current supervisor fact. */
  getRuntimeState(): Promise<RuntimeStateView>
  /** Observe state transitions; returns the unsubscribe function. */
  onRuntimeState(callback: (view: RuntimeStateView) => void): () => void
  /** Request the supervisor to relaunch a failed runtime. */
  requestRestart(): Promise<boolean>
}
