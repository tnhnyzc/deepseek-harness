/**
 * The OS capability registry: the two closed capabilities over an
 * injectable OS port, their success/cancel/failure mapping, and the bounded,
 * redaction-safe diagnostic messages.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createNativeCapabilities,
  MAX_DIAGNOSTIC_CHARS,
  NativeCapabilityError,
  type NativeCapabilityPorts,
} from '../src/main/native-capabilities.ts'

function ports(overrides: Partial<NativeCapabilityPorts> = {}): NativeCapabilityPorts {
  return {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/tmp/chosen'] })),
    openPath: vi.fn(async () => ''),
    ...overrides,
  }
}

describe('createNativeCapabilities', () => {
  it('returns the chosen directory from a successful chooser', async () => {
    const show = vi.fn(async () => ({ canceled: false, filePaths: ['/tmp/chosen', 'spurious-extra'] }))
    const capabilities = createNativeCapabilities(ports({ showOpenDialog: show }))
    await expect(capabilities.pickDirectory(undefined)).resolves.toBe('/tmp/chosen')
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('maps the operator cancel to null', async () => {
    const capabilities = createNativeCapabilities(ports({
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    }))
    await expect(capabilities.pickDirectory(undefined)).resolves.toBeNull()
  })

  it('maps an empty selection to null', async () => {
    const capabilities = createNativeCapabilities(ports({
      showOpenDialog: async () => ({ canceled: false, filePaths: [] }),
    }))
    await expect(capabilities.pickDirectory(undefined)).resolves.toBeNull()
  })

  it('maps a chooser failure to the dialog-failed code', async () => {
    const capabilities = createNativeCapabilities(ports({
      showOpenDialog: async () => { throw new Error('display gone') },
    }))
    await expect(capabilities.pickDirectory(undefined)).rejects.toMatchObject({
      name: 'NativeCapabilityError',
      code: 'dialog-failed',
      message: 'display gone',
    })
  })

  it('maps a non-Error chooser throw to the bounded fallback', async () => {
    const capabilities = createNativeCapabilities(ports({
      showOpenDialog: async () => { throw 'odd' },
    }))
    await expect(capabilities.pickDirectory(undefined)).rejects.toMatchObject({ code: 'dialog-failed' })
  })

  it('resolves a default-application open into void', async () => {
    const open = vi.fn(async () => '')
    const capabilities = createNativeCapabilities(ports({ openPath: open }))
    await expect(capabilities.openPath('/tmp/doc.txt')).resolves.toBeUndefined()
    expect(open).toHaveBeenCalledWith('/tmp/doc.txt')
  })

  it('maps the shell failure string to the open-failed code', async () => {
    const capabilities = createNativeCapabilities(ports({
      openPath: async () => 'no default app for .xyz',
    }))
    await expect(capabilities.openPath('/tmp/x.xyz')).rejects.toMatchObject({
      name: 'NativeCapabilityError',
      code: 'open-failed',
      message: 'no default app for .xyz',
    })
  })

  it('maps a throw during the open to the open-failed code', async () => {
    const capabilities = createNativeCapabilities(ports({
      openPath: async () => { throw new Error('spawn refused') },
    }))
    await expect(capabilities.openPath('/tmp/x')).rejects.toMatchObject({ code: 'open-failed', message: 'spawn refused' })
  })

  it('bounds the diagnostic message', async () => {
    const long = 'x'.repeat(MAX_DIAGNOSTIC_CHARS * 3)
    const capabilities = createNativeCapabilities(ports({
      openPath: async () => long,
    }))
    const error = await capabilities.openPath('/tmp/x').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(NativeCapabilityError)
    expect((error as NativeCapabilityError).message).toHaveLength(MAX_DIAGNOSTIC_CHARS)
  })
})
