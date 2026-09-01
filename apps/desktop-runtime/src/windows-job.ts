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

/** OpenProcess right required by AssignProcessToJobObject (winnt.h). */
const PROCESS_SET_QUOTA = 0x100

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
  /**
   * Release the job handle. When the process tree is already quiescent the
   * close is a no-op; when members still outlive the root (a hung dispose),
   * closing a KILL_ON_JOB_CLOSE job terminates them. Idempotent; process
   * exit closing the handle is the backstop either way.
   */
  release(): void
}

/**
 * Install the containment for this process.
 * @returns the containment controller on Windows; a no-op controller
 * elsewhere (POSIX containment is process-group signaling owned by the
 * supervisor).
 * @throws on Windows when the job object cannot be created or this
 * process cannot be assigned to it — a contained runtime is a desktop
 * invariant, so boot fails loud instead of running uncontained.
 */
export async function installWindowsProcessContainment(): Promise<WindowsProcessContainment> {
  if (process.platform !== 'win32') {
    return { release: () => {} }
  }
  const koffi = (await import('koffi')).default as unknown as JobKoffi
  return createWindowsJobContainment(koffi)
}

/**
 * Create the job object, set KILL_ON_JOB_CLOSE, and assign this process to
 * it. Exported separately so tests inject a recorded koffi stand-in; the
 * platform gate and the koffi import stay in
 * {@link installWindowsProcessContainment}.
 * @param koffi - the koffi module (or a test stand-in with its surface).
 * @returns the containment controller owning the job handle.
 * @throws with the failing Win32 function name and error code when any
 * step fails; handles opened before the failure are closed.
 */
export function createWindowsJobContainment(koffi: JobKoffi): WindowsProcessContainment {
  const kernel32 = koffi.load('kernel32.dll')
  // Register the struct types before any func signature references them by
  // name: koffi resolves the type names at the func() call, so a signature
  // declared before the struct exists is an unknown type.
  const { basic, io, extended } = buildWindowsJobStructs(koffi)
  const createJobObject = kernel32.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'str16'])
  // lpJobObjectExtendedLimitInfo is a pointer to the structure (LP…);
  // declaring the struct itself passes it by value and the OS answers
  // ERROR_MORE_DATA (24) instead of applying the limits.
  const setInformation = kernel32.func('__stdcall', 'SetInformationJobObject', 'int32', [
    'void *', 'uint32', 'JOBOBJECT_EXTENDED_LIMIT_INFORMATION *',
  ])
  const getCurrentProcessId = kernel32.func('__stdcall', 'GetCurrentProcessId', 'uint32', [])
  const openProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'uint32', 'uint32'])
  const assign = kernel32.func('__stdcall', 'AssignProcessToJobObject', 'int32', ['void *', 'void *'])
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int32', ['void *'])
  const lastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', [])

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

  const job = createJobObject(null, null)
  if (job === null) throw failed('CreateJobObjectW', lastError())
  let selfHandle: unknown = null
  try {
    const limits = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0,
        PerJobUserTimeLimit: 0,
        LimitFlags: KILL_ON_JOB_CLOSE,
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
    if (!setInformation(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits)) {
      throw failed('SetInformationJobObject', lastError())
    }
    const pid = getCurrentProcessId()
    selfHandle = openProcess(PROCESS_SET_QUOTA, 0, pid)
    if (selfHandle === null) throw failed('OpenProcess', lastError())
    if (!assign(job, selfHandle)) throw failed('AssignProcessToJobObject', lastError())
  } catch (error) {
    if (selfHandle !== null) closeHandle(selfHandle)
    closeHandle(job)
    throw error
  }

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      closeHandle(selfHandle)
      closeHandle(job)
    },
  }
}
