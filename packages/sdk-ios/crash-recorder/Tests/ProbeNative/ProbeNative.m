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
    @throw [NSException exceptionWithName:@"EFCRQualification" reason:@"synthetic fatal exception" userInfo:@{@"sensitive":@"EFCR_USERINFO_SECRET_91a73f"}];
}
__attribute__((noinline)) static void EFCRProbeKeep(volatile uint8_t *bytes) { __asm__ volatile("" : : "r"(bytes) : "memory"); }
void EFCRProbeMemoryFault(void) {
    // Stack canary in the faulting frame; run-probes.py requires it absent from persisted files.
    volatile uint8_t marker[16];
    for (int i = 0; i < 16; i++) marker[i] = (uint8_t)(0x5A + 37 * i);
    EFCRProbeKeep(marker);
    void *page = mmap(NULL, (size_t)getpagesize(), PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (page == MAP_FAILED) _exit(77);
    *(volatile char *)page = 1;
    _exit(78);
}
// The faulting store is a frameless leaf, so the link register still names its caller.
void EFCRProbeLeafStore(volatile char *address);
__attribute__((noinline)) void EFCRProbeLeafStore(volatile char *address) { *address = 1; }
void EFCRProbeLeafFault(void) {
    void *page = mmap(NULL, (size_t)getpagesize(), PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (page == MAP_FAILED) _exit(77);
    EFCRProbeLeafStore(page);
    _exit(78);
}
// Mutual recursion whose only stack writes are frame records: the stack guard faults on a
// function's first instruction, before its frame record exists, while lr names the caller.
static volatile int recursionDepth;
void EFCRProbeRecurseA(void);
void EFCRProbeRecurseB(void);
__attribute__((noinline)) void EFCRProbeRecurseA(void) { EFCRProbeRecurseB(); recursionDepth++; }
__attribute__((noinline)) void EFCRProbeRecurseB(void) { EFCRProbeRecurseA(); recursionDepth++; }
void EFCRProbeStackOverflow(void) {
    EFCRProbeRecurseA();
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
// Moves only the report gate, leaving the vendor monitors as they are.
void EFCRProbeSetGate(bool open) { efcr_gateSet(open); }
