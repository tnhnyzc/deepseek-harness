/**
 * The DSH-facing codec bridging the candidate's Typert RPC seam to the
 * desktop's opaque byte carrier. It maps an RPC endpoint to the stream route
 * the carrier names it by, and encodes/decodes the open payload and the stream
 * items as JSON — the candidate's canonical Remote value encoding (the gateway
 * carries each stream item as a JSON value). The generic wire protocol and the
 * Electron main broker never see these values: they cross as an opaque route
 * plus opaque bytes, so a new or renamed endpoint needs no wire or broker
 * change.
 * @module @deepseek-ai/dsh-desktop-runtime/remote-codec
 */

/** The transport dummy origin every stream route resolves against; the pathname after /api/ is the endpoint. */
const REMOTE_ROUTE_BASE = 'http://dsh.local/api/'

/** Map one RPC endpoint to the stream route the byte carrier names it by. */
export function endpointRoute(endpoint: string): string {
  return REMOTE_ROUTE_BASE + endpoint
}

/** Map one stream route back to the RPC endpoint it names. */
export function routeEndpoint(route: string): string {
  return new URL(route).pathname.replace(/^\/api\//, '')
}

/** Encode one RPC open payload (the endpoint's arguments) as opaque bytes. */
export function encodeRemotePayload(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

/** Decode one RPC open payload from opaque bytes. */
export function decodeRemotePayload(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data))
}

/** Encode one stream item as opaque bytes. */
export function encodeRemoteItem(item: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(item))
}

/** Decode one stream item from opaque bytes. */
export function decodeRemoteItem(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data))
}

/**
 * The fixed size of one item-length prefix, in bytes. The carrier is a chunked
 * byte stream with no message boundaries, so each item carries its own
 * big-endian byte length: the framing is byte-level (not JSON framing), and the
 * item bytes are the canonical JSON encoding above.
 */
const REMOTE_ITEM_LENGTH_BYTES = 4

/** Frame one stream item: its 4-byte big-endian length prefix plus the JSON bytes. */
export function frameRemoteItem(item: unknown): Uint8Array {
  const encoded = encodeRemoteItem(item)
  const frame = new Uint8Array(REMOTE_ITEM_LENGTH_BYTES + encoded.byteLength)
  new DataView(frame.buffer).setUint32(0, encoded.byteLength, false)
  frame.set(encoded, REMOTE_ITEM_LENGTH_BYTES)
  return frame
}

/**
 * Incremental item reader across chunked wire frames: feed it opaque frames and
 * it yields the decoded items, reassembling a length-prefixed item that spans
 * several chunks. An incomplete trailing item stays buffered for the next push.
 */
export class RemoteItemReader {
  private buffer: Uint8Array = new Uint8Array(0)

  /** Consume one opaque wire frame; returns the complete items it completes. */
  push(frame: Uint8Array): unknown[] {
    const combined = new Uint8Array(this.buffer.byteLength + frame.byteLength)
    combined.set(this.buffer, 0)
    combined.set(frame, this.buffer.byteLength)
    this.buffer = combined
    const items: unknown[] = []
    let cursor = 0
    while (cursor + REMOTE_ITEM_LENGTH_BYTES <= this.buffer.byteLength) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + cursor, REMOTE_ITEM_LENGTH_BYTES).getUint32(0, false)
      const start = cursor + REMOTE_ITEM_LENGTH_BYTES
      if (start + length > this.buffer.byteLength) break
      items.push(decodeRemoteItem(this.buffer.subarray(start, start + length)))
      cursor = start + length
    }
    this.buffer = this.buffer.subarray(cursor)
    return items
  }
}
