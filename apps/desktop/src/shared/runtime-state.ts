import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

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

/**
 * The client-boot artifacts the runtime publishes before it reports ready:
 * the composed entry graph plus the host-owned boot scripts. The supervisor
 * caches one payload per runtime generation; the renderer pulls it once
 * before it starts the DSH client tree.
 */
export interface DshBootPayload {
  /** The composed entry graph — the wire value of `window.__DSH_BOOT__`. */
  graph: WebBootGraph
  /** The module-loader facade script (the queue-mode `window.__ModuleLoader__`). */
  moduleLoaderScript: string
  /** The parser-preload bundle urls, in the order the boot protocol emits them. */
  preloadBundles: string[]
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

/**
 * The renderer-side transport port surface. contextBridge cannot carry a
 * live `MessagePort` object (it crosses as an inert object), so the preload
 * keeps the real port in its isolated world and exposes these plain
 * functions; the page drives the port through them.
 */
interface DesktopTransportPort {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void
  postMessage(message: object): void
  start(): void
  close(): void
}

/** The supervision bridge surface the preload exposes to the renderer. */
export interface DshDesktopApi {
  /** The current supervisor fact. */
  getRuntimeState(): Promise<RuntimeStateView>
  /** Observe state transitions; returns the unsubscribe function. */
  onRuntimeState(callback: (view: RuntimeStateView) => void): () => void
  /** Request the supervisor to relaunch a failed runtime. */
  requestRestart(): Promise<boolean>
  /**
   * Open the stage 3 transport: resolves the renderer half of a fresh
   * channel. Rejects while the runtime is not ready or the open times out;
   * a later channel loss surfaces as the port's `close` event, never as a
   * rejection of a settled promise.
   */
  openTransport(): Promise<DesktopTransportPort>
  /**
   * Pull the current generation's client-boot payload (boot graph, loader
   * facade, preload bundle urls). Resolves `null` while no payload is
   * cached for the live runtime (before its first publication).
   */
  getBootPayload(): Promise<DshBootPayload | null>
}
