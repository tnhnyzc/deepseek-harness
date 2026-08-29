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
 * The Win32 surface used here (kernel32 CreateJobObjectW,
 * SetInformationJobObject, GetCurrentProcessId, OpenProcess,
 * AssignProcessToJobObject, CloseHandle, GetLastError) is frozen Windows
 * ABI since XP. koffi is imported lazily inside the Windows branch, so
 * non-Windows processes never load it — the same containment as the
 * repo's other `win32` modules.
 * @module @deepseek-ai/dsh-desktop-runtime/windows-job
 */

/** KILL_ON_JOB_CLOSE: closing the last job handle kills every member. */
const KILL_ON_JOB_CLOSE = 0x20000000

/** JOBOBJECTINFOCLASS for the extended limit block. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

/** OpenProcess access rights: quota assignment is what the job API requires. */
const PROCESS_SET_QUOTA = 0x100
const PROCESS_TERMINATE = 0x0001

/**
 * The `JOB_OBJECT_EXTENDED_LIMIT_INFORMATION` field list, in C order, for
 * the 64-bit desktop targets (win32-x64; the LP64 layout is identical on
 * arm64). The flattened names avoid the duplicates the C struct has across
 * its nested blocks. The module verifies `sizeof` at install time and
 * refuses to run with an unverified layout.
 */
export const WINDOWS_JOB_EXTENDED_LIMITS_FIELDS: Record<string, string> = {
  // JOB_OBJECT_IO_INFORMATION
  ioProcessWriteLimit: 'int64',
  ioProcessReadLimit: 'int64',
  ioTotalWriteLimit: 'int64',
  ioTotalReadLimit: 'int64',
  ioCurrentProcessWriteLimit: 'int64',
  ioCurrentProcessReadLimit: 'int64',
  ioPeakProcessWriteLimit: 'int64',
  ioPeakProcessReadLimit: 'int64',
  // JOB_OBJECT_MEMORY_LIMIT_INFORMATION
  memProcessMemoryLimit: 'int64',
  memJobMemoryLimit: 'int64',
  memPeakProcessMemoryUsed: 'int64',
  memPeakJobMemoryUsed: 'int64',
  // PROCESS_LIMIT_INFORMATION
  procLimit: 'uint32',
  procAffinity: 'int64',
  procPriorityClass: 'uint32',
  procSchedulingClass: 'uint32',
  // JOB_OBJECT_BASIC_LIMIT_INFORMATION
  basicLimitFlags: 'uint32',
  basicProcessMemoryLimit: 'int64',
  basicJobMemoryLimit: 'int64',
  basicProcessTimeLimit: 'uint32',
  basicPriorityClass: 'uint32',
  basicSchedulingClass: 'uint32',
  basicAffinity: 'int64',
  // Extended limit fields: the kill-on-close flag lives here, not in
  // `basicLimitFlags` (the basic block's flag word predates the feature).
  killFlags: 'uint32',
  miniModeProcessorSet: 'uint32',
  assignmentType: 'uint32',
  extendedAffinity: 'int64',
}

/** The 64-bit size of the extended limit block in bytes. */
export const WINDOWS_JOB_EXTENDED_LIMITS_SIZE = 192

/** The koffi surface the job installation uses; injectable in tests. */
export interface JobKoffi {
  load(path: string): { func(convention: string, name: string, result: string, args: string[]): (...args: unknown[]) => unknown }
  struct(name: string, fields: Record<string, string>): unknown
  sizeof(type: unknown): number
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
  const createJobObject = kernel32.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'str16'])
  const setInformation = kernel32.func('__stdcall', 'SetInformationJobObject', 'int32', [
    'void *', 'uint32', 'DshJobObjectExtendedLimits',
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

  const limitsType = koffi.struct('DshJobObjectExtendedLimits', WINDOWS_JOB_EXTENDED_LIMITS_FIELDS)
  const size = koffi.sizeof(limitsType)
  if (size !== WINDOWS_JOB_EXTENDED_LIMITS_SIZE) {
    throw new Error(
      `windows-job: job-object limit layout is ${String(size)} bytes, expected ${String(WINDOWS_JOB_EXTENDED_LIMITS_SIZE)}; `
      + 'the 64-bit Win32 layout changed and the job object must not run unverified',
    )
  }

  const job = createJobObject(null, null)
  if (job === null) throw failed('CreateJobObjectW', lastError())
  let selfHandle: unknown = null
  try {
    const limits = {
      ...Object.fromEntries(Object.keys(WINDOWS_JOB_EXTENDED_LIMITS_FIELDS).map(name => [name, 0])),
      killFlags: KILL_ON_JOB_CLOSE,
    }
    if (!setInformation(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits)) {
      throw failed('SetInformationJobObject', lastError())
    }
    const pid = getCurrentProcessId()
    selfHandle = openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
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
