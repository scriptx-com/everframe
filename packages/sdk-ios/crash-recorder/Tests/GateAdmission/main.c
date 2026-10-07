// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Deterministic scheduling hook around the actual gate source's first atomic
// load. This is an admission interleaving regression, not a real fatal race.
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static int inject;
static void after_load(void);
#undef atomic_load_explicit
#define atomic_load_explicit(object, order) ({ __auto_type value = __c11_atomic_load(object, order); after_load(); value; })
#include "RecorderGate.c"
static const char *contextA = "11111111-1111-4111-8111-111111111111";
static const char *contextB = "22222222-2222-4222-8222-222222222222";
static char captured[37];
static void after_load(void) {
    if (inject) {
        inject = 0;
        efcr_gateSet(false);
        if (!efcr_contextPublish(contextB)) abort();
    }
}
static void capture(const KSCrashReportWriter *writer, const char *key, const char *value) {
    (void)writer;
    if (strcmp(key, "everframe_context_id") || strlen(value) != 36) abort();
    memcpy(captured, value, 37);
}
int main(void) {
    if (!efcr_contextPublish(contextA)) abort();
    efcr_gateSet(true);
    KSCrash_ExceptionHandlingPlan plan = {.shouldWriteReport = true};
    inject = 1;
    efcr_willWriteReport(&plan, NULL);
    KSCrashReportWriter writer = {.addStringElement = capture};
    if (plan.shouldWriteReport) efcr_writeContext(&plan, &writer);
    printf("shouldWriteReport=%d enabled=%d admitted=%s\n", plan.shouldWriteReport, efcr_gateGet(), captured);
    // The callback may preserve an already admitted A or observe disablement.
    // It must never admit B, which has not been enabled.
    return efcr_gateGet() || (plan.shouldWriteReport && strcmp(captured, contextA)) ? 1 : 0;
}
