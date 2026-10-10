// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <stdbool.h>
#include <objc/runtime.h>
void NativeProofInstallTransport(Class protocolClass);
bool NativeProofRecorderEnabled(void);
void NativeProofObjCException(void);
void NativeProofMemoryFault(void);
void NativeProofAbort(void);
