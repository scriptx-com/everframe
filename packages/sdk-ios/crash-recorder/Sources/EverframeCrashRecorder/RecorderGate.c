// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "RecorderGate.h"
#include <stdatomic.h>
#include <string.h>
#include <limits.h>
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Crash admission must always be lock free");
_Static_assert(sizeof(unsigned) * CHAR_BIT >= 19, "Crash admission state needs19 bits");
typedef struct { char identifier[37]; } EFCRContext;
// Publication runs disabled under Recorder.m's healthy mutex. The current
// slot and the single fatal-admitted slot are never overwritten; a third slot
// is always available. A fatal reader reads only its admitted immutable slot.
static EFCRContext contexts[3];
// One atomic value ties eligibility and ownership to the admission CAS.
// Current0 is empty;1..3 name slots. Admitted0 is unset;1 is frozen empty.
// Healthy mutations preserve the admitted field for this terminating process.
enum { CURRENT_MASK = 0x1ffu, ADMITTED_SHIFT = 9,
       ADMITTED_MASK = 0x1ffu << ADMITTED_SHIFT, ENABLED = 1u << 18 };
static atomic_uint state = ATOMIC_VAR_INIT(0);
void efcr_gateSet(bool value) {
    if (value) atomic_fetch_or_explicit(&state, ENABLED, memory_order_release);
    else atomic_fetch_and_explicit(&state, ~ENABLED, memory_order_release);
}
bool efcr_gateGet(void) { return (atomic_load_explicit(&state, memory_order_acquire) & ENABLED) != 0; }
void efcr_willWriteReport(KSCrash_ExceptionHandlingPlan *plan, const struct KSCrash_MonitorContext *context) {
    (void)context;
    unsigned observed = atomic_load_explicit(&state, memory_order_acquire);
    for (;;) {
        if (!(observed & ENABLED)) { plan->shouldWriteReport = false; return; }
        if (!plan->shouldWriteReport || (observed & ADMITTED_MASK)) return;
        unsigned admitted = ((observed & CURRENT_MASK) + 1) << ADMITTED_SHIFT;
        if (atomic_compare_exchange_weak_explicit(&state, &observed, observed | admitted,
                                                  memory_order_acq_rel, memory_order_acquire)) return;
        // Disable/publication raced admission: retry against their complete state,
        // never combine one context's enabled bit with another context's identity.
    }
}
static void publishSlot(unsigned slot) {
    unsigned observed = atomic_load_explicit(&state, memory_order_relaxed);
    while (!atomic_compare_exchange_weak_explicit(&state, &observed, (observed & ~CURRENT_MASK) | slot,
                                                  memory_order_release, memory_order_relaxed)) {}
}

bool efcr_contextPublish(const char *identifier) {
    if (efcr_gateGet()) return false;
    if (!identifier) {
        publishSlot(0);
        return true;
    }
    if (strnlen(identifier, 37) != 36) return false;
    for (unsigned i = 0; i < 36; i++) {
        char value = identifier[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (value != '-') return false; }
        else if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return false;
    }
    for (unsigned i = 0; i < 3; i++) {
        if (memcmp(contexts[i].identifier, identifier, 37) == 0) {
            publishSlot(i + 1);
            return true;
        }
    }
    unsigned snapshot = atomic_load_explicit(&state, memory_order_acquire);
    unsigned current = snapshot & CURRENT_MASK;
    unsigned admitted = (snapshot & ADMITTED_MASK) >> ADMITTED_SHIFT;
    for (unsigned slot = 1; slot <= 3; ++slot) {
        if (slot == current || slot + 1 == admitted) continue;
        memcpy(contexts[slot - 1].identifier, identifier, 37);
        publishSlot(slot);
        return true;
    }
    return false;
}

bool efcr_contextRetained(char current[37], char admitted[37]) {
    unsigned snapshot = atomic_load_explicit(&state, memory_order_acquire);
    if (snapshot & ENABLED) return false;
    unsigned selected = snapshot & CURRENT_MASK;
    unsigned frozen = (snapshot & ADMITTED_MASK) >> ADMITTED_SHIFT;
    current[0] = admitted[0] = '\0';
    if (selected) memcpy(current, contexts[selected - 1].identifier, 37);
    if (frozen > 1) memcpy(admitted, contexts[frozen - 2].identifier, 37);
    return true;
}

void efcr_writeContext(const KSCrash_ExceptionHandlingPlan *plan, const KSCrashReportWriter *writer) {
    (void)plan;
    unsigned admitted = (atomic_load_explicit(&state, memory_order_acquire) & ADMITTED_MASK) >> ADMITTED_SHIFT;
    //0 means not admitted;1 freezes the empty context;2..4 name slots0..2.
    if (admitted > 1) {
        writer->addStringElement(writer, "everframe_context_id", contexts[admitted - 2].identifier);
    }
}
