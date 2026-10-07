// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Qualification links this host with EVERY ordinary and owned recorder object.
#import <Foundation/Foundation.h>
#include "EverframeCrashRecorder.h"
#include "KSCrashC.h"
#include "KSCrashCConfiguration.h"
#include <string.h>
static void ordinary(const char *path) {
    KSCrashCConfiguration configuration = KSCrashCConfiguration_Default();
    configuration.monitors = KSCrashMonitorTypeMachException | KSCrashMonitorTypeSignal | KSCrashMonitorTypeNSException;
    configuration.enableSwapCxaThrow = false;
    if (kscrash_install("Ordinary", path, &configuration) != KSCrashInstallErrorNone) exit(81);
}
static void owned(const char *path) {
    if (EFCRInstall(path) != EFCRInstallSuccess || !EFCRSetEnabled(true)) exit(82);
}
int main(int argc, const char **argv) {
    if (argc != 4) return 80;
    @autoreleasepool {
        if (strstr(argv[1], "ordinary-first")) { ordinary(argv[3]); owned(argv[2]); }
        else { owned(argv[2]); ordinary(argv[3]); }
        if (strncmp(argv[1], "disable-", 8) == 0 && !EFCRSetEnabled(false)) return 83;
        @throw [NSException exceptionWithName:@"DualCollectorQualification" reason:@"synthetic chain probe" userInfo:nil];
    }
}
