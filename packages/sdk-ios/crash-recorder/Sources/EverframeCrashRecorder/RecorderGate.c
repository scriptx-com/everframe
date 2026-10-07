// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "RecorderGate.h"
#include <stdatomic.h>
_Static_assert(ATOMIC_BOOL_LOCK_FREE == 2, "Crash gate must always be lock free");
static atomic_bool enabled = ATOMIC_VAR_INIT(false);
void efcr_gateSet(bool value) { atomic_store_explicit(&enabled, value, memory_order_release); }
bool efcr_gateGet(void) { return atomic_load_explicit(&enabled, memory_order_acquire); }
void efcr_willWriteReport(KSCrash_ExceptionHandlingPlan *plan, const struct KSCrash_MonitorContext *context) {
    (void)context;
    if (!atomic_load_explicit(&enabled, memory_order_acquire)) plan->shouldWriteReport = false;
}
