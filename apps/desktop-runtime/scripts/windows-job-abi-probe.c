/*
 * Win32 Job Object ABI probe (D4): compiled by the Windows CI lane with the
 * Visual Studio toolchain's cl.exe against the machine's real SDK headers
 * (windows.h -> winnt.h) and run by scripts/check-windows-job-abi.ts, which
 * asserts that the C compiler's sizes, offsets, and constants equal the
 * values the koffi declaration in src/windows-job.ts mirrors. This is the
 * ground-truth cross-check the fake-Win32 unit test cannot provide: the job
 * object must match the kernel's layout, not our copy of it.
 */
#include <stddef.h>
#include <stdio.h>
#include <windows.h>

int main(void)
{
    printf("BASIC_LIMIT_SIZE %llu\n", (unsigned long long)sizeof(JOBOBJECT_BASIC_LIMIT_INFORMATION));
    printf("IO_COUNTERS_SIZE %llu\n", (unsigned long long)sizeof(IO_COUNTERS));
    printf("EXTENDED_LIMIT_SIZE %llu\n", (unsigned long long)sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    printf("LIMIT_FLAGS_OFFSET %llu\n",
           (unsigned long long)offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags));
    printf("KILL_ON_JOB_CLOSE 0x%llx\n", (unsigned long long)JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
    printf("INFO_CLASS %d\n", (int)JobObjectExtendedLimitInformation);
    return 0;
}
