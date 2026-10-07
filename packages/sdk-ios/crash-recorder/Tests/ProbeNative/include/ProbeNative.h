// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <stdbool.h>
void EFCRProbeObjCException(void);
void EFCRProbeMemoryFault(void);
void EFCRProbeLeafFault(void);
void EFCRProbeStackOverflow(void);
int EFCRProbePoisonVendor(const char *directory);
int EFCRProbeGate(void);
int EFCRProbeAdmitContext(void);
void EFCRProbeSetGate(bool open);
int EFCRProbeInstallOffMain(const char *directory);
int EFCRProbeEnableOffMain(void);
