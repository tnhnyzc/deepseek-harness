/**
 * The desktop runtime protocol version: the wire contract between the
 * Electron main process and the standalone runtime child — the fork IPC
 * control messages (`runtime.ready`, `runtime.shutdown`,
 * `runtime.boot-graph`), the transport relay, and the native capability
 * channel. Bump only when a packaged release could not interoperate with a
 * newer or older half of the pair; the build manifest records the version
 * of the half it shipped.
 * @module @deepseek-ai/dsh-desktop/src/shared/runtime-protocol
 */

/** The current desktop runtime protocol version. */
export const DESKTOP_RUNTIME_PROTOCOL_VERSION = 1
