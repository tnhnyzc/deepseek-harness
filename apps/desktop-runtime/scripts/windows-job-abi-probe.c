/*
 * Win32 Job Object ABI probe (D4): compiled by the Windows CI lane with the
 * Visual Studio toolchain's cl.exe against the machine's real SDK headers
 * (windows.h -> winnt.h) and run by scripts/check-windows-job-abi.ts, which
 * asserts that the C compiler's sizes, offsets, and constants equal the
 * values the koffi declaration in src/windows-job.ts mirrors.
 *
 * The probe also executes one real SetInformationJobObject call (against a
 * job with no member assigned, so no process is contained). The call goes
 * through a locally declared four-argument prototype resolved at runtime:
 * current SDKs appended a buffer-length parameter to the export, older
 * kernels ignore the extra register, and compiling against either header
 * generation stays valid. A layout or signature the kernel no longer
 * accepts fails the call here, on the machine that ships the artifact.
 */
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <windows.h>

typedef BOOL (WINAPI *SetInformationJobObjectFn)(HANDLE, JOBOBJECTINFOCLASS, LPVOID, DWORD);

int main(void)
{
    printf("BASIC_LIMIT_SIZE %llu\n", (unsigned long long)sizeof(JOBOBJECT_BASIC_LIMIT_INFORMATION));
    printf("IO_COUNTERS_SIZE %llu\n", (unsigned long long)sizeof(IO_COUNTERS));
    printf("EXTENDED_LIMIT_SIZE %llu\n", (unsigned long long)sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    printf("LIMIT_FLAGS_OFFSET %llu\n",
           (unsigned long long)offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags));
    printf("KILL_ON_JOB_CLOSE 0x%llx\n", (unsigned long long)JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
    printf("INFO_CLASS %d\n", (int)JobObjectExtendedLimitInformation);

    SetInformationJobObjectFn setInformation = (SetInformationJobObjectFn)(void *)
        GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "SetInformationJobObject");
    if (setInformation == NULL) {
        printf("SET_INFO 0 %lu\n", (unsigned long)GetLastError());
        return 1;
    }
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) {
        printf("SET_INFO 0 %lu\n", (unsigned long)GetLastError());
        return 1;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
    memset(&info, 0, sizeof info);
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    BOOL ok = setInformation(job, JobObjectExtendedLimitInformation, &info, (DWORD)sizeof info);
    printf("SET_INFO %d %lu\n", (int)ok, (unsigned long)(ok ? 0 : GetLastError()));
    CloseHandle(job);
    return ok ? 0 : 1;
}
