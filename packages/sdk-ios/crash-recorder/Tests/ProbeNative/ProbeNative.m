// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "EverframeKSCrashNamespace.h"
#include "KSCrashC.h"
#include "KSCrashCConfiguration.h"
#include "KSCrashMonitor.h"
#include "RecorderGate.h"
#import <Foundation/Foundation.h>
#include <sys/mman.h>
#include <unistd.h>
void EFCRProbeObjCException(void) {
    @throw [NSException exceptionWithName:@"EFCRQualification" reason:@"synthetic fatal exception" userInfo:nil];
}
void EFCRProbeMemoryFault(void) {
    void *page = mmap(NULL, (size_t)getpagesize(), PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (page == MAP_FAILED) _exit(77);
    *(volatile char *)page = 1;
    _exit(78);
}
int EFCRProbePoisonVendor(const char *directory) {
    KSCrashCConfiguration configuration = KSCrashCConfiguration_Default();
    configuration.enableSwapCxaThrow = false;
    int result = kscrash_install("Qualification", directory, &configuration);
    kscm_disableAllMonitors();
    return result;
}

int EFCRProbeGate(void) {
    KSCrash_ExceptionHandlingPlan plan = {0};
    plan.shouldWriteReport = true;
    efcr_gateSet(false); efcr_willWriteReport(&plan, NULL);
    if (plan.shouldWriteReport) return 1;
    plan.shouldWriteReport = true;
    efcr_gateSet(true); efcr_willWriteReport(&plan, NULL);
    if (!plan.shouldWriteReport) return 2;
    plan.shouldWriteReport = false;
    efcr_willWriteReport(&plan, NULL);
    if (plan.shouldWriteReport) return 3;
    efcr_gateSet(false);
    return 0;
}
