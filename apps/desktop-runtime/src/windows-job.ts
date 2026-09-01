/**
 * Windows process containment (D4): before this process may spawn any
 * descendant, it creates a job object with KILL_ON_JOB_CLOSE, assigns
 * itself to the job, and holds the job handle for its whole life. Windows
 * adds every process a member spawns to that member's job automatically,
 * so the complete descendant tree of this process is contained: when the
 * process dies — clean exit, forced kill, or crash — the last job handle
 * closes and the OS terminates every surviving member. A replacement
 * generation is a new process that installs its own job, and no unrelated
 * process is ever a member of this one.
 *
 * The handle is held by this process (the standalone runtime child), not
 * by the Electron supervisor, so containment is in place before any
 * descendant can exist: the job installs before the composition boots.
 * The supervisor's stage-9 tree cleanup remains the fallback for the
 * window where this installation has not yet happened (early boot death).
 *
 * Outer jobs: hosts whose launch context already places the process tree
 * in a Job Object (hosted CI runners, service hosts) cannot be joined by a
 * second job — a process already member of a job is refused with
 * ERROR_ACCESS_DENIED. `IsProcessInJob` (or the assignment rejection as
 * the proof) detects that case, and the install then returns the
 * `externally-contained` fallback: the OS still kernel-contains the whole
 * tree in the outer job, the product job is not installed, the boot
 * reports the fallback loud, and D4 is NOT claimed validated there.
 * Every other failure still fails the boot closed.
 *
 * The Win32 surface used here is frozen Windows ABI since XP, mirrored
 * field-for-field from the SDK headers (winnt.h, as mirrored by Wine's
 * `include/winnt.h` and Microsoft's API reference):
 *
 * ```c
 * typedef struct _JOBOBJECT_BASIC_LIMIT_INFORMATION {
 *   LARGE_INTEGER PerProcessUserTimeLimit; // 8 @0
 *   LARGE_INTEGER PerJobUserTimeLimit;     // 8 @8
 *   DWORD         LimitFlags;              // 4 @16  (KILL_ON_JOB_CLOSE lives here)
 *   SIZE_T        MinimumWorkingSetSize;   // 8 @24
 *   SIZE_T        MaximumWorkingSetSize;   // 8 @32
 *   DWORD         ActiveProcessLimit;      // 4 @40
 *   ULONG_PTR     Affinity;                // 8 @48
 *   DWORD         PriorityClass;           // 4 @56
 *   DWORD         SchedulingClass;         // 4 @60
 * } JOBOBJECT_BASIC_LIMIT_INFORMATION;     // 64 bytes on 64-bit
 *
 * typedef struct _IO_COUNTERS {            // #pragma pack(push,8) in winnt.h
 *   ULONGLONG ReadOperationCount;          // 8 @0
 *   ULONGLONG WriteOperationCount;         // 8 @8
 *   ULONGLONG OtherOperationCount;         // 8 @16
 *   ULONGLONG ReadTransferCount;           // 8 @24
 *   ULONGLONG WriteTransferCount;          // 8 @32
 *   ULONGLONG OtherTransferCount;          // 8 @40
 * } IO_COUNTERS;                           // 48 bytes
 *
 * typedef struct _JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
 *   JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; // @0
 *   IO_COUNTERS                       IoInfo;                // @64
 *   SIZE_T                            ProcessMemoryLimit;    // 8 @112
 *   SIZE_T                            JobMemoryLimit;        // 8 @120
 *   SIZE_T                            PeakProcessMemoryUsed; // 8 @128
 *   SIZE_T                            PeakJobMemoryUsed;     // 8 @136
 * } JOBOBJECT_EXTENDED_LIMIT_INFORMATION;  // 144 bytes on 64-bit
 * ```
 *
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is `0x00002000`, a bit of
 * `BasicLimitInformation.LimitFlags` (the SDK documents that this limit
 * "requires use of a JOBOBJECT_EXTENDED_LIMIT_INFORMATION structure"). The
 * information class is `JobObjectExtendedLimitInformation` = 9, and the
 * process handle passed to `AssignProcessToJobObject` needs
 * `PROCESS_SET_QUOTA` (0x0100).
 *
 * Current SDKs declare a fourth `SetInformationJobObject` parameter — the
 * information buffer length, which current kernels verify (an omitted
 * length leaves the register undefined and the call fails with
 * ERROR_MORE_DATA, 24). Older kernels ignore the extra register, so the
 * four-argument form is the portable one; the CI probe executes the call
 * against the shipping kernel to keep this verified.
 *
 * The koffi structs below reproduce exactly that layout; the install
 * refuses to run when koffi computes a different size, and the Windows CI
 * lane compiles a C probe against the real SDK headers and cross-checks
 * every size and constant (`scripts/check-windows-job-abi.ts`).
 *
 * koffi is imported lazily inside the Windows branch, so non-Windows
 * processes never load it — the same containment as the repo's other
 * `win32` modules.
 * @module @deepseek-ai/dsh-desktop-runtime/windows-job
 */

/** KILL_ON_JOB_CLOSE: a LimitFlags bit — closing the last job handle kills every member. */
export const KILL_ON_JOB_CLOSE = 0x2000

/** JOBOBJECTINFOCLASS.JobObjectExtendedLimitInformation (winnt.h). */
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

/**
 * The containment mode a process runs in. `product-job` is the D4 contract:
 * this process's own job object contains its tree. `externally-contained`
 * is the fallback for hosts where the process tree is ALREADY a member of
 * an externally owned job (CI runners, service hosts): a fresh, empty,
 * fully-privileged job cannot take a member away, so the product job is not
 * installed — the OS keeps the tree contained in the outer job, and D4 is
 * NOT validated in this mode. `supervisor-owned` is the non-Windows no-op
 * (the supervisor owns process-group cleanup).
 */
export const CONTAINMENT_MODES = {
  productJob: 'product-job',
  externallyContained: 'externally-contained',
  supervisorOwned: 'supervisor-owned',
} as const

/** One containment mode. */
export type ContainmentMode = (typeof CONTAINMENT_MODES)[keyof typeof CONTAINMENT_MODES]

/** OpenProcess right required by AssignProcessToJobObject (winnt.h). */
const PROCESS_SET_QUOTA = 0x100

/** ERROR_ACCESS_DENIED (winerror.h): the assignment-rejection outer-job proof. */
const ERROR_ACCESS_DENIED = 5

/** S_OK (winnt.h): IsProcessInJob succeeded. */
const S_OK = 0

/**
 * The verified 64-bit (LP64: x64 and arm64) sizes and offsets of the job
 * object limit structures, per the SDK layout above.
 */
export const WINDOWS_JOB_ABI = {
  /** sizeof(JOBOBJECT_BASIC_LIMIT_INFORMATION). */
  basicLimitSize: 64,
  /** sizeof(IO_COUNTERS). */
  ioCountersSize: 48,
  /** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION). */
  extendedLimitSize: 144,
  /** offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags). */
  limitFlagsOffset: 16,
} as const

/** The koffi surface the job installation uses; injectable in tests. */
export interface JobKoffi {
  load(path: string): { func(convention: string, name: string, result: string, args: string[]): (...args: unknown[]) => unknown }
  struct(name: string, fields: Record<string, unknown>): unknown
  sizeof(type: unknown): number
  /** Encode a value into a scratch buffer usable as a pointer out-parameter. */
  encode(type: unknown, value: unknown): Buffer
  /** Decode the scratch buffer an out-parameter call wrote through. */
  decode(type: unknown, buffer: Buffer): unknown
}

/**
 * The three koffi struct types, declared in C order with the SDK field
 * types. `LARGE_INTEGER`/`ULONGLONG` are 8-byte integral, `DWORD` is
 * 32-bit unsigned, `SIZE_T`/`ULONG_PTR` are pointer-sized unsigned.
 * @param koffi - the koffi module (or a test stand-in).
 * @returns the basic, IO, and extended limit types.
 */
export function buildWindowsJobStructs(koffi: JobKoffi): { basic: unknown; io: unknown; extended: unknown } {
  const basic = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'longlong',
    PerJobUserTimeLimit: 'longlong',
    LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'size_t',
    MaximumWorkingSetSize: 'size_t',
    ActiveProcessLimit: 'uint32',
    Affinity: 'size_t',
    PriorityClass: 'uint32',
    SchedulingClass: 'uint32',
  })
  const io = koffi.struct('IO_COUNTERS', {
    ReadOperationCount: 'ulonglong',
    WriteOperationCount: 'ulonglong',
    OtherOperationCount: 'ulonglong',
    ReadTransferCount: 'ulonglong',
    WriteTransferCount: 'ulonglong',
    OtherTransferCount: 'ulonglong',
  })
  const extended = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
    BasicLimitInformation: basic,
    IoInfo: io,
    ProcessMemoryLimit: 'size_t',
    JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t',
    PeakJobMemoryUsed: 'size_t',
  })
  return { basic, io, extended }
}

/**
 * Process-tree containment for the current process.
 */
export interface WindowsProcessContainment {
  /** The containment mode this process runs in (see {@link CONTAINMENT_MODES}). */
  readonly mode: ContainmentMode
  /**
   * Fallback mode only: the outer job's `LimitFlags` when the
   * NULL-handle job query succeeded from this process; absent when the
   * outer job does not grant the query.
   */
  readonly outerJobLimitFlags?: number
  /**
   * Release the job handle. Product-job mode: when the process tree is
   * already quiescent the close is a no-op; when members still outlive the
   * root (a hung dispose), closing a KILL_ON_JOB_CLOSE job terminates
   * them. Fallback and supervisor modes: a no-op (no product handle
   * exists). Idempotent; process exit closing the handle is the backstop
   * either way.
   */
  release(): void
}

/**
 * Install the containment for this process.
 * @returns the containment controller on Windows; a supervisor-owned no-op
 * controller elsewhere (POSIX containment is process-group signaling owned
 * by the supervisor).
 * @throws on Windows when the job object cannot be created, its limit block
 * cannot be set, or this process cannot be assigned to it for any reason
 * other than a proven pre-existing outer job membership — a contained
 * runtime is a desktop invariant, so boot fails loud instead of running
 * uncontained. A proven outer job instead returns the
 * `externally-contained` fallback controller (the OS keeps the tree
 * contained in the outer job).
 */
export async function installWindowsProcessContainment(): Promise<WindowsProcessContainment> {
  if (process.platform !== 'win32') {
    return { mode: CONTAINMENT_MODES.supervisorOwned, release: () => {} }
  }
  const koffi = (await import('koffi')).default as unknown as JobKoffi
  return createWindowsJobContainment(koffi)
}

/**
 * The zeroed extended limit block: no limit is enabled in the query buffer
 * (read-only) and every field but LimitFlags stays zero in the product-job
 * set (no accidental limits are enabled).
 */
function zeroExtendedLimits(): Record<string, unknown> {
  return {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: 0,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  }
}

/**
 * Create the job object, set KILL_ON_JOB_CLOSE, and assign this process to
 * it. Exported separately so tests inject a recorded koffi stand-in; the
 * platform gate and the koffi import stay in
 * {@link installWindowsProcessContainment}.
 *
 * Outer-job detection, before and as a proof: `IsProcessInJob` (kernel32,
 * Windows 10 1809+) is probed first; when it is missing or fails the probe
 * is unusable and the product path runs, where an assignment rejected with
 * ERROR_ACCESS_DENIED is itself the proof — a fresh, empty, fully
 * privileged job can only refuse a member the process already belongs to
 * in an outer job. Either proof returns the `externally-contained`
 * fallback controller (the OS keeps the whole tree contained in the outer
 * job); every other failure throws.
 * @param koffi - the koffi module (or a test stand-in with its surface).
 * @returns the containment controller: the job handle in product mode, the
 * no-op fallback controller in the outer-job cases.
 * @throws with the failing Win32 function name and error code when any
 * step fails outside the proven outer-job cases; handles opened before the
 * failure are closed.
 */
export function createWindowsJobContainment(koffi: JobKoffi): WindowsProcessContainment {
  const kernel32 = koffi.load('kernel32.dll')
  // Register the struct types before any func signature references them by
  // name: koffi resolves the type names at the func() call, so a signature
  // declared before the struct exists is an unknown type.
  const { basic, io, extended } = buildWindowsJobStructs(koffi)
  const createJobObject = kernel32.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'str16'])
  // Current SDKs declare the fourth parameter (the information buffer
  // length, verified by the kernel — omitting it leaves the register
  // undefined and the call fails with ERROR_MORE_DATA, 24). Older
  // kernels ignore the extra register, so the 4-argument form is the
  // forward- and backward-compatible one.
  const setInformation = kernel32.func('__stdcall', 'SetInformationJobObject', 'int32', [
    'void *', 'uint32', 'JOBOBJECT_EXTENDED_LIMIT_INFORMATION *', 'uint32',
  ])
  const getCurrentProcessId = kernel32.func('__stdcall', 'GetCurrentProcessId', 'uint32', [])
  const openProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'uint32', 'uint32'])
  const assign = kernel32.func('__stdcall', 'AssignProcessToJobObject', 'int32', ['void *', 'void *'])
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int32', ['void *'])
  const lastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', [])
  // A NULL job handle queries the calling process's own job.
  const queryJobObject = kernel32.func('__stdcall', 'QueryInformationJobObject', 'int32', [
    'void *', 'uint32', 'void *', 'uint32', 'uint32 *',
  ])
  // IsProcessInJob landed in kernel32 with Windows 10 1809: on older hosts
  // the export is missing, and koffi throws at the func() declaration — an
  // unusable probe, never a boot failure.
  let isProcessInJob: ((...args: unknown[]) => unknown) | undefined
  try {
    isProcessInJob = kernel32.func('__stdcall', 'IsProcessInJob', 'int32', ['uint32 *'])
  } catch {
    isProcessInJob = undefined
  }

  // The FFI boundary: koffi results are unknown until used; the code only
  // ever reaches the diagnostic message.
  const failed = (fn: string, code: unknown): Error =>
    new Error(`windows-job: ${fn} failed (win32 error ${String(code)})`)
  const sizes: [number, number][] = [
    [koffi.sizeof(basic), WINDOWS_JOB_ABI.basicLimitSize],
    [koffi.sizeof(io), WINDOWS_JOB_ABI.ioCountersSize],
    [koffi.sizeof(extended), WINDOWS_JOB_ABI.extendedLimitSize],
  ]
  for (const [actual, expected] of sizes) {
    if (actual !== expected) {
      throw new Error(
        `windows-job: job-object limit layout is ${String(actual)} bytes, expected ${String(expected)}; `
        + 'the 64-bit Win32 layout changed and the job object must not run unverified',
      )
    }
  }

  /**
   * The fallback controller: no product job exists (nothing to release);
   * the outer job's limit flags are recorded when the NULL-handle query
   * grants them, for the boot diagnostic.
   */
  const fallback = (): WindowsProcessContainment => {
    let outerJobLimitFlags: number | undefined
    try {
      const limitsBuffer = koffi.encode(extended, zeroExtendedLimits())
      const lengthBuffer = koffi.encode('uint32', 0)
      if (queryJobObject(null, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limitsBuffer, koffi.sizeof(extended), lengthBuffer) === 1) {
        const info = koffi.decode(extended, limitsBuffer) as { BasicLimitInformation: { LimitFlags: number } }
        outerJobLimitFlags = info.BasicLimitInformation.LimitFlags
      }
    } catch {
      // The outer job does not grant the query from this process: the
      // flags stay absent and the diagnostic says so.
    }
    return {
      mode: CONTAINMENT_MODES.externallyContained,
      ...(outerJobLimitFlags !== undefined ? { outerJobLimitFlags } : {}),
      release: () => {},
    }
  }

  // Probe first: a usable `IsProcessInJob` S_OK answer settles the outer-
  // job case without creating a job this process cannot join.
  if (isProcessInJob !== undefined) {
    try {
      const memberBuffer = koffi.encode('uint32', 0)
      if (isProcessInJob(memberBuffer) === S_OK && koffi.decode('uint32', memberBuffer) === 1) {
        return fallback()
      }
    } catch {
      // The call failed: the probe is unusable; the assignment below proves
      // the same case by rejection.
    }
  }

  const job = createJobObject(null, null)
  if (job === null) throw failed('CreateJobObjectW', lastError())
  let selfHandle: unknown = null
  try {
    const limits = zeroExtendedLimits()
    const basicLimits = limits.BasicLimitInformation as Record<string, unknown>
    basicLimits.LimitFlags = KILL_ON_JOB_CLOSE
    if (!setInformation(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, koffi.sizeof(extended))) {
      throw failed('SetInformationJobObject', lastError())
    }
    const pid = getCurrentProcessId()
    selfHandle = openProcess(PROCESS_SET_QUOTA, 0, pid)
    if (selfHandle === null) throw failed('OpenProcess', lastError())
    if (!assign(job, selfHandle)) {
      const code = lastError()
      if (code === ERROR_ACCESS_DENIED) {
        // A fresh, empty job with full creator rights refuses only a
        // process already member of an outer job: proven fallback case.
        closeHandle(selfHandle)
        selfHandle = null
        closeHandle(job)
        return fallback()
      }
      throw failed('AssignProcessToJobObject', code)
    }
  } catch (error) {
    if (selfHandle !== null) closeHandle(selfHandle)
    closeHandle(job)
    throw error
  }

  let released = false
  return {
    mode: CONTAINMENT_MODES.productJob,
    release: () => {
      if (released) return
      released = true
      closeHandle(selfHandle)
      closeHandle(job)
    },
  }
}
