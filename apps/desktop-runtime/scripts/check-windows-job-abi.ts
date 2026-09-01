/**
 * Win32 Job Object ABI gate (D4, Windows only): compiles
 * `windows-job-abi-probe.c` with the Visual Studio toolchain's cl.exe
 * against the machine's real SDK headers, runs it, and asserts that the C
 * compiler's sizes, offsets, and constants equal both the verified SDK
 * values and the koffi declaration in `src/windows-job.ts`. The probe also
 * executes one real `SetInformationJobObject` call (four-argument form with
 * the buffer length, on a memberless job), so a kernel that rejects the
 * layout or signature fails here on the shipping machine. The fake-Win32
 * unit test proves the call sequence; only this gate and the D4 acceptance
 * run prove the layout against the real kernel.
 *
 * Run from the repository root:
 *   node --import tsx/esm apps/desktop-runtime/scripts/check-windows-job-abi.ts
 * Exit codes: 0 pass, 1 mismatch or toolchain failure, 2 not a Windows host.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Candidate Visual Studio environment batch files, in preference order.
 * The runner image's VS generation is not pinned (2019 through 2026 layouts
 * all ship vcvarsall.bat, and newer images moved to a year-less `18` folder),
 * so discovery prefers the VS Installer's own `vswhere` output and falls back
 * to the explicit edition paths on both Program Files roots. Each installation
 * offers two entry points: `vcvarsall.bat x64` and `VsDevCmd.bat -arch=x64`.
 */
function findVcvarsCommands(): string[] {
  const commands: string[] = []
  const forInstall = (installPath: string): void => {
    const vcvarsall = join(installPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
    if (existsSync(vcvarsall)) commands.push(`call "${vcvarsall}" x64`)
    const vsdevcmd = join(installPath, 'Common7', 'Tools', 'VsDevCmd.bat')
    if (existsSync(vsdevcmd)) commands.push(`call "${vsdevcmd}" -arch=x64 -host_arch=x64`)
  }
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
  if (existsSync(vswhere)) {
    const out = spawnSync(
      vswhere,
      ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
      { encoding: 'utf8' },
    )
    if (out.status === 0) {
      for (const installPath of String(out.stdout ?? '').trim().split(/\r?\n/).map(line => line.trim())) {
        if (installPath !== '') forInstall(installPath)
      }
    }
  }
  const roots = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio',
    'C:\\Program Files\\Microsoft Visual Studio',
  ]
  const editions = ['Enterprise', 'Professional', 'Community', 'BuildTools']
  for (const year of ['18', '2026', '2025', '2024', '2022', '2019']) {
    for (const root of roots) {
      for (const edition of editions) {
        forInstall(join(root, year, edition))
      }
    }
  }
  return [...new Set(commands)]
}

const workDir = join(tmpdir(), `dsh-job-abi-${String(process.pid)}`)
mkdirSync(workDir, { recursive: true })
try {
  const probeSource = join(import.meta.dirname, 'windows-job-abi-probe.c')
  const probeExe = join(workDir, 'probe.exe')
  const vcvarsCommands = findVcvarsCommands()
  if (vcvarsCommands.length === 0) {
    fail('no Visual Studio C++ toolchain batch file found (vswhere and the explicit 2019-2026 paths); the Windows runner image must carry the VS Build Tools')
  }
  // The command is written to a batch file rather than passed as a cmd
  // argument: Node re-quotes argument text when it builds the CreateProcess
  // command line, which backslash-escapes the quotes around the toolchain path
  // and makes cmd look for a program literally named `\"C:\...\"`. A wrapper
  // file is parsed by cmd verbatim; the relative argument below carries no
  // quoting at all.
  const attempts: string[] = []
  let compiled = false
  vcvarsCommands.forEach((envCommand, index) => {
    if (compiled) return
    const wrapper = `compile-${String(index)}.cmd`
    writeFileSync(
      join(workDir, wrapper),
      `@echo off\r\n${envCommand}\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /W3 /O2 "${probeSource}" /Fe"${probeExe}"\r\n`,
      'utf8',
    )
    const compile = spawnSync('cmd', ['/c', wrapper], { cwd: workDir, encoding: 'utf8' })
    if (compile.status === 0 && existsSync(probeExe)) {
      compiled = true
      return
    }
    attempts.push(`-- ${envCommand} (exit ${String(compile.status)}):\n${String(compile.stdout)}\n${String(compile.stderr)}`)
  })
  if (!compiled) {
    fail(`cl.exe probe compile failed under every discovered toolchain (${String(vcvarsCommands.length)} candidate(s)):\n${attempts.join('\n')}`)
  }
  const output = execFileSync(probeExe, [], { encoding: 'utf8' })
  const reported: Record<string, number> = {}
  let setInfoOk = Number.NaN
  let setInfoErr = Number.NaN
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const [key, value] = fields
    if (key === 'SET_INFO') {
      setInfoOk = Number(fields[1])
      setInfoErr = Number(fields[2])
      continue
    }
    if (key === undefined || value === undefined) continue
    reported[key] = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value)
  }
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const actual = reported[key]
    if (actual !== expected) {
      fail(`SDK header ${key} is ${String(actual)}, expected ${String(expected)}: the Win32 job ABI changed; re-verify against the SDK before shipping`)
    }
  }
  if (setInfoOk !== 1 || setInfoErr !== 0) {
    fail(`SetInformationJobObject on this machine returned ${String(setInfoOk)} (win32 error ${String(setInfoErr)}): the kernel no longer accepts the 144-byte extended limit block with its buffer length — re-verify the Win32 job ABI against this OS before shipping`)
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
  process.stdout.write(`check-windows-job-abi: PASS — koffi mirrors the SDK layout (${String(reported.EXTENDED_LIMIT_SIZE)}-byte extended limit block); SetInformationJobObject accepted the extended limits on this kernel\n`)
  process.exit(0)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
