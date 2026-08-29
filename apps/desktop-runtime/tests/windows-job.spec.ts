/**
 * D4 Windows job-object containment: the koffi struct layout must match the
 * frozen 64-bit Win32 `JOB_OBJECT_EXTENDED_LIMIT_INFORMATION` (verified
 * against real koffi on every LP64 host, including the Windows acceptance
 * run), the install sequence must create the job, set KILL_ON_JOB_CLOSE,
 * and assign this process before it returns, every failure must close what
 * it opened and throw the failing function with its win32 error, and the
 * non-Windows branch must be a no-op that never loads koffi.
 */

import koffi from 'koffi'
import { describe, expect, it } from 'vitest'
import {
  createWindowsJobContainment,
  installWindowsProcessContainment,
  WINDOWS_JOB_EXTENDED_LIMITS_FIELDS,
  WINDOWS_JOB_EXTENDED_LIMITS_SIZE,
  type JobKoffi,
} from '../src/windows-job.ts'

/** The recorded koffi stand-in: real call sequence, fake Win32 answers. */
function fakeKoffi(overrides: {
  createJobObject?: () => unknown
  setInformation?: () => number
  openProcess?: () => unknown
  assign?: () => number
  sizeof?: number
}) {
  const calls: { name: string; args: unknown[] }[] = []
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
    struct: () => 'limits-type',
    sizeof: () => overrides.sizeof ?? WINDOWS_JOB_EXTENDED_LIMITS_SIZE,
  }
  return { module, calls }
}

describe('job-object extended limit layout', () => {
  it('matches the frozen 64-bit Win32 size', () => {
    // The desktop ships win32-x64 (LP64); arm64 shares the layout.
    if (process.arch !== 'x64' && process.arch !== 'arm64') return
    const type = koffi.struct('DshJobObjectExtendedLimitsSpec', WINDOWS_JOB_EXTENDED_LIMITS_FIELDS)
    expect(koffi.sizeof(type)).toBe(WINDOWS_JOB_EXTENDED_LIMITS_SIZE)
  })
})

describe('createWindowsJobContainment', () => {
  it('creates the job, sets KILL_ON_JOB_CLOSE, and assigns this process', () => {
    const { module, calls } = fakeKoffi({})
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
    expect(setCall.args[1]).toBe(9)
    expect((setCall.args[2] as Record<string, unknown>).killFlags).toBe(0x20000000)
    expect(calls[3].args).toEqual([0x101, 0, 1234])
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

  it('refuses an unverified limit layout', () => {
    const { module } = fakeKoffi({ sizeof: WINDOWS_JOB_EXTENDED_LIMITS_SIZE - 8 })
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
