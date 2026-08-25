/**
 * The main-side native channel: strict validation at the wire boundary,
 * one response per request, closed-code failure mapping, duplicate refusal,
 * malformed-request classification, and the generation-teardown cancel of
 * every pending request with late results dropped.
 */

import { describe, expect, it, vi } from 'vitest'
import { createNativeChannel } from '../src/main/native-channel.ts'
import { MAX_DIAGNOSTIC_CHARS, NativeCapabilityError, type NativeCapabilities } from '../src/main/native-capabilities.ts'
import type { NativeMessage } from '@deepseek-ai/dsh-desktop-runtime/native'

interface Harness {
  sent: NativeMessage[]
  channel: ReturnType<typeof createNativeChannel>
}

function makeHarness(capabilities: NativeCapabilities = stubCapabilities()): Harness {
  const sent: NativeMessage[] = []
  const channel = createNativeChannel({
    capabilities,
    send: (message) => { sent.push(message) },
    getWindow: () => undefined,
  })
  return { sent, channel }
}

function stubCapabilities(): NativeCapabilities {
  return {
    pickDirectory: async () => '/tmp/chosen',
    openPath: async () => undefined,
  }
}

describe('createNativeChannel', () => {
  it('answers a directory.pick request with the chooser path', async () => {
    const harness = makeHarness()
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    await vi.waitFor(() => { expect(harness.sent).toHaveLength(1) })
    expect(harness.sent[0]).toEqual({ type: 'native.response', requestId: 'a', ok: true, path: '/tmp/chosen' })
    expect(harness.channel.pendingIds()).toEqual([])
  })

  it('answers a directory.pick operator cancel with a null path', async () => {
    const harness = makeHarness({ pickDirectory: async () => null, openPath: async () => undefined })
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    await vi.waitFor(() => { expect(harness.sent).toHaveLength(1) })
    expect(harness.sent[0]).toEqual({ type: 'native.response', requestId: 'a', ok: true, path: null })
  })

  it('answers a path.open request with a valueless success', async () => {
    const opened: string[] = []
    const harness = makeHarness({ pickDirectory: async () => null, openPath: async (path) => { opened.push(path) } })
    harness.channel.handle({ type: 'native.request', requestId: 'b', method: 'path.open', path: '/tmp/doc.txt' })
    await vi.waitFor(() => { expect(harness.sent).toHaveLength(1) })
    expect(harness.sent[0]).toEqual({ type: 'native.response', requestId: 'b', ok: true })
    expect(opened).toEqual(['/tmp/doc.txt'])
  })

  it('maps a capability failure onto its closed code', async () => {
    const harness = makeHarness({
      pickDirectory: async () => { throw new NativeCapabilityError('dialog-failed', 'display gone') },
      openPath: async () => undefined,
    })
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    await vi.waitFor(() => { expect(harness.sent).toHaveLength(1) })
    expect(harness.sent[0]).toEqual({ type: 'native.response', requestId: 'a', ok: false, code: 'dialog-failed', message: 'display gone' })
  })

  it('maps an unexpected throw to the method fallback code', async () => {
    const harness = makeHarness({
      pickDirectory: async () => { throw new Error('weird') },
      openPath: async () => { throw new Error('weirder') },
    })
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    harness.channel.handle({ type: 'native.request', requestId: 'b', method: 'path.open', path: '/x' })
    await vi.waitFor(() => { expect(harness.sent).toHaveLength(2) })
    expect(harness.sent[0]).toMatchObject({ requestId: 'a', ok: false, code: 'dialog-failed', message: 'weird' })
    expect(harness.sent[1]).toMatchObject({ requestId: 'b', ok: false, code: 'open-failed', message: 'weirder' })
  })

  it('answers an unknown method with the unknown-method code', () => {
    const harness = makeHarness()
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'session.create' })
    expect(harness.sent).toEqual([
      { type: 'native.response', requestId: 'a', ok: false, code: 'unknown-method', message: 'the request was not a well-formed native request' },
    ])
  })

  it('answers a malformed known-method request with the malformed-request code', () => {
    const harness = makeHarness()
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'path.open', path: '' })
    expect(harness.sent).toEqual([
      { type: 'native.response', requestId: 'a', ok: false, code: 'malformed-request', message: 'the request was not a well-formed native request' },
    ])
  })

  it('drops an uncorrelatable malformed request without a response', () => {
    const harness = makeHarness()
    harness.channel.handle('nonsense')
    harness.channel.handle({ type: 'native.request', method: 'path.open', path: '/x' })
    expect(harness.sent).toEqual([])
  })

  it('ignores a duplicate request while the first is still in flight', async () => {
    const harness = makeHarness({
      // In-flight forever: the duplicate arrives before any settlement.
      pickDirectory: () => new Promise<string | null>(() => undefined),
      openPath: async () => undefined,
    })
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    await vi.waitFor(() => { expect(harness.channel.pendingIds()).toEqual(['a']) })
    expect(harness.sent).toEqual([])
  })

  it('teardown cancels every pending request exactly once', async () => {
    const harness = makeHarness({
      pickDirectory: () => new Promise<string | null>(() => undefined),
      openPath: () => new Promise<void>(() => undefined),
    })
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    harness.channel.handle({ type: 'native.request', requestId: 'b', method: 'path.open', path: '/x' })
    await vi.waitFor(() => { expect(harness.channel.pendingIds()).toHaveLength(2) })
    harness.channel.teardown('generation ended')
    expect(harness.sent).toEqual([
      { type: 'native.cancel', requestId: 'a', reason: 'generation ended' },
      { type: 'native.cancel', requestId: 'b', reason: 'generation ended' },
    ])
    expect(harness.channel.pendingIds()).toEqual([])
    // Teardown is idempotent.
    harness.channel.teardown('generation ended')
    expect(harness.sent).toHaveLength(2)
  })

  it('drops the late result of a torn-down generation', async () => {
    let settlePick: (value: string | null) => void = () => undefined
    const harness = makeHarness({
      pickDirectory: () => new Promise<string | null>((resolve) => { settlePick = resolve }),
      openPath: async () => undefined,
    })
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    await vi.waitFor(() => { expect(harness.channel.pendingIds()).toEqual(['a']) })
    harness.channel.teardown('generation ended')
    settlePick('/late')
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    expect(harness.sent).toEqual([{ type: 'native.cancel', requestId: 'a', reason: 'generation ended' }])
  })

  it('ignores new requests after teardown', () => {
    const harness = makeHarness()
    harness.channel.teardown('generation ended')
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    expect(harness.sent).toEqual([])
  })

  it('bounds the cancel reason', () => {
    const harness = makeHarness({
      pickDirectory: () => new Promise<string | null>(() => undefined),
      openPath: async () => undefined,
    })
    harness.channel.handle({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
    harness.channel.teardown('r'.repeat(MAX_DIAGNOSTIC_CHARS * 2))
    expect(harness.sent[0]).toEqual({ type: 'native.cancel', requestId: 'a', reason: 'r'.repeat(MAX_DIAGNOSTIC_CHARS) })
  })
})
