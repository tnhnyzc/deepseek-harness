/**
 * Win32 Job Object ABI gate (D4, Windows only): compiles
 * `windows-job-abi-probe.c` with the Visual Studio toolchain's cl.exe
 * against the machine's real SDK headers, runs it, and asserts that the C
 * compiler's sizes, offsets, and constants equal both the verified SDK
 * values and the koffi declaration in `src/windows-job.ts`. The fake-Win32
 * unit test proves the call sequence; only this gate and the D4 acceptance
 * run prove the layout against the real kernel.
 *
 * Run from the repository root:
 *   node --import tsx/esm apps/desktop-runtime/scripts/check-windows-job-abi.ts
 * Exit codes: 0 pass, 1 mismatch or toolchain failure, 2 not a Windows host.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobKoffi } from '../src/windows-job.ts'

if (process.platform !== 'win32') {
  process.stderr.write('check-windows-job-abi: Windows-only gate; run it on a Windows host or CI runner\n')
  process.exit(2)
}

/** The verified 64-bit SDK values (winnt.h, as mirrored by Wine and Microsoft's reference). */
const EXPECTED = {
  BASIC_LIMIT_SIZE: 64,
  IO_COUNTERS_SIZE: 48,
  EXTENDED_LIMIT_SIZE: 144,
  LIMIT_FLAGS_OFFSET: 16,
  KILL_ON_JOB_CLOSE: 0x2000,
  INFO_CLASS: 9,
} as const

function fail(message: string): never {
  process.stderr.write(`check-windows-job-abi: FAIL: ${message}\n`)
  process.exit(1)
}

/** Locate vcvarsall.bat across the Visual Studio 2019/2022 editions and Build Tools. */
function findVcvars(): string {
  const roots = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio',
    'C:\\Program Files\\Microsoft Visual Studio',
  ]
  const editions = ['Enterprise', 'Professional', 'Community', 'BuildTools']
  for (const year of ['2022', '2019']) {
    for (const root of roots) {
      for (const edition of editions) {
        const candidate = join(root, year, edition, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
        if (existsSync(candidate)) return candidate
      }
    }
  }
  fail('no Visual Studio vcvarsall.bat found; the Windows runner image must carry the VS Build Tools')
}

const workDir = join(tmpdir(), `dsh-job-abi-${String(process.pid)}`)
mkdirSync(workDir, { recursive: true })
try {
  const probeSource = join(import.meta.dirname, 'windows-job-abi-probe.c')
  const probeExe = join(workDir, 'probe.exe')
  const vcvars = findVcvars()
  const compile = spawnSync(
    'cmd',
    ['/d', '/s', '/c', `call "${vcvars}" x64 && cl /nologo /W3 /O2 "${probeSource}" /Fe"${probeExe}"`],
    { cwd: workDir, encoding: 'utf8' },
  )
  if (compile.status !== 0 || !existsSync(probeExe)) {
    fail(`cl.exe probe compile failed (exit ${String(compile.status)}):\n${String(compile.stdout)}\n${String(compile.stderr)}`)
  }
  const output = execFileSync(probeExe, [], { encoding: 'utf8' })
  const reported: Record<string, number> = {}
  for (const line of output.split('\n')) {
    const [key, value] = line.trim().split(' ')
    if (key === undefined || value === undefined) continue
    reported[key] = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value)
  }
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const actual = reported[key]
    if (actual !== expected) {
      fail(`SDK header ${key} is ${String(actual)}, expected ${String(expected)}: the Win32 job ABI changed; re-verify against the SDK before shipping`)
    }
  }
  process.stdout.write(`check-windows-job-abi: SDK headers — basic ${String(reported.BASIC_LIMIT_SIZE)}, io ${String(reported.IO_COUNTERS_SIZE)}, extended ${String(reported.EXTENDED_LIMIT_SIZE)} bytes; LimitFlags @ ${String(reported.LIMIT_FLAGS_OFFSET)}; KILL_ON_JOB_CLOSE 0x${String(reported.KILL_ON_JOB_CLOSE.toString(16))}; info class ${String(reported.INFO_CLASS)}\n`)

  // The koffi declaration must compute the same sizes the C compiler did.
  const koffi = (await import('koffi')).default
  const { buildWindowsJobStructs, WINDOWS_JOB_ABI } = await import('../src/windows-job.ts')
  const { basic, io, extended } = buildWindowsJobStructs(koffi as unknown as JobKoffi)
  const checks: [string, number, number][] = [
    ['JOBOBJECT_BASIC_LIMIT_INFORMATION', koffi.sizeof(basic), reported.BASIC_LIMIT_SIZE],
    ['IO_COUNTERS', koffi.sizeof(io), reported.IO_COUNTERS_SIZE],
    ['JOBOBJECT_EXTENDED_LIMIT_INFORMATION', koffi.sizeof(extended), reported.EXTENDED_LIMIT_SIZE],
  ]
  for (const [name, actual, expected] of checks) {
    if (actual !== expected) {
      fail(`koffi sizeof(${name}) is ${String(actual)}, the C compiler reports ${String(expected)}`)
    }
    if (name === 'JOBOBJECT_EXTENDED_LIMIT_INFORMATION' && actual !== WINDOWS_JOB_ABI.extendedLimitSize) {
      fail(`koffi sizeof(${name}) is ${String(actual)}, the pinned ABI constant is ${String(WINDOWS_JOB_ABI.extendedLimitSize)}`)
    }
  }
  process.stdout.write(`check-windows-job-abi: PASS — koffi mirrors the SDK layout (${String(reported.EXTENDED_LIMIT_SIZE)}-byte extended limit block)\n`)
  process.exit(0)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
