/**
 * D4 Windows job-object containment: the koffi struct declaration must
 * reproduce the frozen 64-bit Win32 `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`
 * (144 bytes; `KILL_ON_JOB_CLOSE` = 0x00002000 as a bit of
 * `BasicLimitInformation.LimitFlags`; information class 9) — verified
 * against real koffi on every LP64 host here, and against the real SDK
 * headers by the Windows CI lane's C ABI probe
 * (`scripts/check-windows-job-abi.ts`). The install sequence must create
 * the job, set the limit block, and assign this process before it returns;
 * every failure must close what it opened and throw the failing function
 * with its win32 error; the non-Windows branch must be a no-op that never
 * loads koffi.
 */

import koffi from 'koffi'
import { describe, expect, it } from 'vitest'
import {
  buildWindowsJobStructs,
  createWindowsJobContainment,
  installWindowsProcessContainment,
  JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
  KILL_ON_JOB_CLOSE,
  WINDOWS_JOB_ABI,
  type JobKoffi,
} from '../src/windows-job.ts'

/** The recorded koffi stand-in: real call sequence, fake Win32 answers. */
function fakeKoffi(overrides: {
  createJobObject?: () => unknown
  setInformation?: () => number
  openProcess?: () => unknown
  assign?: () => number
  sizes?: Partial<Record<'basic' | 'io' | 'extended', number>>
}) {
  const calls: { name: string; args: unknown[] }[] = []
  const structs: { name: string; fields: Record<string, unknown> }[] = []
  const record = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args })
    switch (name) {
      case 'CreateJobObjectW':
        return overrides.createJobObject !== undefined ? overrides.createJobObject() : 'job-handle'
      case 'SetInformationJobObject':
        return overrides.setInformation !== undefined ? overrides.setInformation() : 1
      case 'GetCurrentProcessId':
        return 1234
      case 'OpenProcess':
        return overrides.openProcess !== undefined ? overrides.openProcess() : 'self-handle'
      case 'AssignProcessToJobObject':
        return overrides.assign !== undefined ? overrides.assign() : 1
      case 'CloseHandle':
        return 1
      case 'GetLastError':
        return 42
      default:
        throw new Error(`fake-koffi: unrecorded function ${name}`)
    }
  }
  const module: JobKoffi = {
    load: () => ({ func: (_convention: string, name: string, _result: string, _args: string[]) => record(name) }),
    struct: (name, fields) => {
      structs.push({ name, fields })
      return name === 'JOBOBJECT_BASIC_LIMIT_INFORMATION'
        ? 'basic-type'
        : name === 'IO_COUNTERS'
          ? 'io-type'
          : 'extended-type'
    },
    sizeof: (type: unknown) => {
      if (type === 'basic-type') return overrides.sizes?.basic ?? WINDOWS_JOB_ABI.basicLimitSize
      if (type === 'io-type') return overrides.sizes?.io ?? WINDOWS_JOB_ABI.ioCountersSize
      return overrides.sizes?.extended ?? WINDOWS_JOB_ABI.extendedLimitSize
    },
  }
  return { module, calls, structs }
}

describe('job-object limit layout (real koffi, LP64 hosts)', () => {
  it('computes the SDK sizes: basic 64, io 48, extended 144', () => {
    // The desktop ships win32-x64 (LP64); arm64 shares the layout.
    if (process.arch !== 'x64' && process.arch !== 'arm64') return
    const { basic, io, extended } = buildWindowsJobStructs(koffi as unknown as JobKoffi)
    expect(koffi.sizeof(basic)).toBe(WINDOWS_JOB_ABI.basicLimitSize)
    expect(koffi.sizeof(io)).toBe(WINDOWS_JOB_ABI.ioCountersSize)
    expect(koffi.sizeof(extended)).toBe(WINDOWS_JOB_ABI.extendedLimitSize)
  })
})

describe('createWindowsJobContainment', () => {
  it('creates the job, sets KILL_ON_JOB_CLOSE in BasicLimitInformation.LimitFlags, and assigns this process', () => {
    const { module, calls, structs } = fakeKoffi({})
    createWindowsJobContainment(module)
    expect(calls.map(c => c.name)).toEqual([
      'CreateJobObjectW',
      'SetInformationJobObject',
      'GetCurrentProcessId',
      'OpenProcess',
      'AssignProcessToJobObject',
    ])
    const setCall = calls[1]
    expect(setCall.args[0]).toBe('job-handle')
    expect(setCall.args[1]).toBe(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION)
    const limits = setCall.args[2] as {
      BasicLimitInformation: Record<string, unknown>
      IoInfo: Record<string, unknown>
      ProcessMemoryLimit: number
    }
    expect(limits.BasicLimitInformation.LimitFlags).toBe(KILL_ON_JOB_CLOSE)
    expect(KILL_ON_JOB_CLOSE).toBe(0x2000)
    // Every other field is zero: no accidental limits are enabled.
    for (const [field, value] of Object.entries(limits.BasicLimitInformation)) {
      if (field !== 'LimitFlags') expect(value).toBe(0)
    }
    for (const value of Object.values(limits.IoInfo)) expect(value).toBe(0)
    expect(limits.ProcessMemoryLimit).toBe(0)
    // The fourth argument is the buffer length current kernels verify; an
    // omitted or wrong length is ERROR_MORE_DATA (24) on the real OS.
    expect(setCall.args[3]).toBe(WINDOWS_JOB_ABI.extendedLimitSize)
    // The extended struct embeds the basic and io structs (the flag is in
    // the basic block, not a flat sibling field).
    const extendedDecl = structs.find(s => s.name === 'JOBOBJECT_EXTENDED_LIMIT_INFORMATION')
    expect(extendedDecl?.fields).toMatchObject({ BasicLimitInformation: 'basic-type', IoInfo: 'io-type' })
    // AssignProcessToJobObject needs a PROCESS_SET_QUOTA handle (0x100).
    expect(calls[3].args).toEqual([0x100, 0, 1234])
    expect(calls[4].args).toEqual(['job-handle', 'self-handle'])
  })

  it('releases the self handle and the job handle exactly once', () => {
    const { module, calls } = fakeKoffi({})
    const containment = createWindowsJobContainment(module)
    containment.release()
    containment.release()
    const closes = calls.filter(c => c.name === 'CloseHandle').map(c => c.args[0])
    expect(closes).toEqual(['self-handle', 'job-handle'])
  })

  const failureCases: [string, Parameters<typeof fakeKoffi>[0]][] = [
    ['CreateJobObjectW', { createJobObject: () => null }],
    ['SetInformationJobObject', { setInformation: () => 0 }],
    ['OpenProcess', { openProcess: () => null }],
    ['AssignProcessToJobObject', { assign: () => 0 }],
  ]
  it.each(failureCases)('%s failure throws with the win32 error and closes what it opened', (fn, override) => {
    const { module, calls } = fakeKoffi(override)
    expect(() => createWindowsJobContainment(module)).toThrow(new RegExp(`^windows-job: ${fn} failed \\(win32 error 42\\)$`))
    const closes = calls.filter(c => c.name === 'CloseHandle').map(c => c.args[0])
    if (fn === 'CreateJobObjectW') expect(closes).toEqual([])
    else if (fn === 'SetInformationJobObject' || fn === 'OpenProcess') expect(closes).toEqual(['job-handle'])
    else expect(closes).toEqual(['self-handle', 'job-handle'])
  })

  it.each([
    ['basic', { basic: WINDOWS_JOB_ABI.basicLimitSize - 8 }],
    ['io', { io: WINDOWS_JOB_ABI.ioCountersSize + 8 }],
    ['extended', { extended: WINDOWS_JOB_ABI.extendedLimitSize - 8 }],
  ] as const)('refuses an unverified %s limit layout', (_label, sizes) => {
    const { module } = fakeKoffi({ sizes })
    expect(() => createWindowsJobContainment(module)).toThrow(/unverified/)
  })
})

describe('installWindowsProcessContainment', () => {
  it('is a no-op off Windows and never loads koffi there', async () => {
    if (process.platform === 'win32') return
    const containment = await installWindowsProcessContainment()
    containment.release()
    containment.release()
  })
})
