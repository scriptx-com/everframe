// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#ifndef EVERFRAME_CRASH_RECORDER_H
#define EVERFRAME_CRASH_RECORDER_H
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef enum {
    EFCRInstallSuccess = 0,
    EFCRInstallAlreadyInstalled = 1,
    EFCRInstallInvalidDirectory = 2,
    EFCRInstallVendorFailure = 3
} EFCRInstallResult;
// Healthy-process integration only. Supply an existing, empty, canonical absolute
// directory owned by this user with mode 0700, reserved exclusively for this run.
// Do not rename/replace it concurrently. Validation failure permits correction;
// entering the vendor installer is terminal even if it fails. Success is disabled.
EFCRInstallResult EFCRInstall(const char *runDirectory);
// Healthy threads only; calls are serialized. Disabling closes the report gate
// before monitor mutation. A handler that already passed the gate may finish.
// Returns false before successful installation or if enabling monitors fails.
bool EFCRSetEnabled(bool enabled);
bool EFCRIsEnabled(void);
const char *EFCRVersion(void);
#ifdef __cplusplus
}
#endif
#endif
