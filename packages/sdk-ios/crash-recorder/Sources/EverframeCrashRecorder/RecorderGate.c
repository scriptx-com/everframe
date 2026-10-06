// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "RecorderGate.h"
#include <stdatomic.h>
#include <string.h>
_Static_assert(ATOMIC_BOOL_LOCK_FREE == 2, "Crash gate must always be lock free");
_Static_assert(ATOMIC_POINTER_LOCK_FREE == 2, "Crash context pointer must always be lock free");
typedef struct { char identifier[37]; } EFCRContext;
static const EFCRContext noContext = {{0}};
static EFCRContext contexts[256];
// Healthy publication is serialized by Recorder.m. Never reuse or free a slot.
static unsigned contextCount = 0;
static _Atomic(const EFCRContext *) published = ATOMIC_VAR_INIT(&noContext);
static _Atomic(const EFCRContext *) admitted = ATOMIC_VAR_INIT(NULL);
static atomic_bool enabled = ATOMIC_VAR_INIT(false);
void efcr_gateSet(bool value) { atomic_store_explicit(&enabled, value, memory_order_release); }
bool efcr_gateGet(void) { return atomic_load_explicit(&enabled, memory_order_acquire); }
void efcr_willWriteReport(KSCrash_ExceptionHandlingPlan *plan, const struct KSCrash_MonitorContext *context) {
    (void)context;
    if (!atomic_load_explicit(&enabled, memory_order_acquire)) {
        plan->shouldWriteReport = false;
        return;
    }
    if (plan->shouldWriteReport) {
        const EFCRContext *expected = NULL;
        const EFCRContext *current = atomic_load_explicit(&published, memory_order_acquire);
        // A non-NULL empty sentinel also freezes legacy/no-context admission.
        atomic_compare_exchange_strong_explicit(&admitted, &expected, current,
                                                memory_order_release, memory_order_relaxed);
    }
}

bool efcr_contextPublish(const char *identifier) {
    if (!identifier) {
        atomic_store_explicit(&published, &noContext, memory_order_release);
        return true;
    }
    if (strnlen(identifier, 37) != 36) return false;
    for (unsigned i = 0; i < 36; i++) {
        char value = identifier[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (value != '-') return false; }
        else if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return false;
    }
    for (unsigned i = 0; i < contextCount; i++) {
        if (memcmp(contexts[i].identifier, identifier, 37) == 0) {
            atomic_store_explicit(&published, &contexts[i], memory_order_release);
            return true;
        }
    }
    if (contextCount == 256) return false;
    EFCRContext *slot = &contexts[contextCount++];
    memcpy(slot->identifier, identifier, 37);
    atomic_store_explicit(&published, slot, memory_order_release);
    return true;
}

void efcr_writeContext(const KSCrash_ExceptionHandlingPlan *plan, const KSCrashReportWriter *writer) {
    (void)plan;
    const EFCRContext *context = atomic_load_explicit(&admitted, memory_order_acquire);
    if (context && context->identifier[0]) {
        writer->addStringElement(writer, "everframe_context_id", context->identifier);
    }
}
