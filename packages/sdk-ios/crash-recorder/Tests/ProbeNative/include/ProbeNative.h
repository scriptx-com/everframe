// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <stdbool.h>
void EFCRProbeObjCException(void);
void EFCRProbeMemoryFault(void);
int EFCRProbePoisonVendor(const char *directory);
int EFCRProbeGate(void);
void EFCRProbeSetGate(bool open);
