/**
 * The desktop directory-picker provider: the native seat, its capability
 * object stable for the service lifetime, and the pick delegate carrying the
 * caller signal. The real-composition behavior (one provider in the desktop
 * boot, host.pickDirectory crossing to Electron main) is pinned by
 * native-boot.spec.ts against the built runtime.
 */

import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import DesktopDirectoryPicker, { type DesktopDirectoryPick } from '../src/directory-picker.ts'

function makeCtx(pick: DesktopDirectoryPick): { ctx: Context; provided: Record<string, unknown> } {
  const provided: Record<string, unknown> = {}
  const ctx = {
    reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    desktopDirectoryPick: pick,
  } as unknown as Context
  return { ctx, provided }
}

describe('DesktopDirectoryPicker', () => {
  it('registers as ctx.directoryPicker and keeps one stable native capability', () => {
    const { ctx, provided } = makeCtx(() => Promise.resolve(null))
    const service = new DesktopDirectoryPicker(ctx)
    expect(provided.directoryPicker).toBe(service)
    const first = service.capability()
    const second = service.capability()
    expect(first).toBe(second)
    expect(first.kind).toBe('native')
  })

  it('delivers the caller signal to the native pick delegate', async () => {
    const pick = vi.fn(async (signal: AbortSignal) => (signal.aborted ? null : '/tmp/chosen'))
    const { ctx } = makeCtx(pick)
    const service = new DesktopDirectoryPicker(ctx)
    const signal = new AbortController().signal
    const capability = service.capability()
    if (capability.kind !== 'native') throw new Error('expected the native capability')
    await expect(capability.pick(signal)).resolves.toBe('/tmp/chosen')
    expect(pick).toHaveBeenCalledTimes(1)
    expect(pick).toHaveBeenCalledWith(signal)
  })

  it('carries the operator cancel as null', async () => {
    const { ctx } = makeCtx(() => Promise.resolve(null))
    const service = new DesktopDirectoryPicker(ctx)
    const capability = service.capability()
    if (capability.kind !== 'native') throw new Error('expected the native capability')
    await expect(capability.pick(new AbortController().signal)).resolves.toBeNull()
  })

  it('carries a delegate rejection as a rejection', async () => {
    const { ctx } = makeCtx(() => Promise.reject(new Error('boom')))
    const service = new DesktopDirectoryPicker(ctx)
    const capability = service.capability()
    if (capability.kind !== 'native') throw new Error('expected the native capability')
    await expect(capability.pick(new AbortController().signal)).rejects.toThrow('boom')
  })
})
