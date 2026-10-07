// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#ifndef EVERFRAME_RECORDER_GATE_H
#define EVERFRAME_RECORDER_GATE_H
#include "EverframeKSCrashNamespace.h"
#include "KSCrashExceptionHandlingPlan.h"
struct KSCrash_MonitorContext;
#include <stdbool.h>
void efcr_gateSet(bool enabled);
bool efcr_gateGet(void);
void efcr_willWriteReport(KSCrash_ExceptionHandlingPlan *plan, const struct KSCrash_MonitorContext *context);
#endif
