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
    EFCRInstallVendorFailure = 3,
    EFCRInstallWrongThread = 4
} EFCRInstallResult;
// Install and set enabled on the main thread only, after UIApplicationMain has started:
// the vendor monitors call UIKit there, and the signal alternate stack is set for the
// calling thread. Other threads get EFCRInstallWrongThread (recoverable) or false; hop
// to the main thread asynchronously, since a synchronous hop can deadlock.
// Healthy-process integration only. Supply an existing, empty, canonical absolute
// directory of at most 449 bytes, owned by this user with mode 0700, reserved
// exclusively for this run. Canonical means realpath(3) output, or that path without
// the /private prefix, as Foundation reports /var and /tmp locations; the recorder
// installs with the realpath(3) form.
// Do not rename/replace it concurrently. Validation failure permits correction;
// entering the vendor installer is terminal even if it fails. Success is disabled.
EFCRInstallResult EFCRInstall(const char *runDirectory);
// Main thread only; calls are serialized. Disabling closes the report gate
// before monitor mutation. A handler that already passed the gate may finish.
// Returns false off the main thread, before successful installation or if enabling
// monitors fails.
bool EFCRSetEnabled(bool enabled);
bool EFCRIsEnabled(void);
// Any healthy thread, not only the main thread: it shares the install lock but calls
// no UIKit or vendor code. Never from a crash or signal handler. After installation
// and only while disabled. Persist context bytes durably BEFORE publication, then
// enable (on the main thread) only after this returns true.
// Canonical lowercase UUID (36 chars); NULL clears. Invalid/capacity failure leaves
// the previous owner unchanged.256 immutable lifetime slots; duplicates reuse one.
// A fatal event already admitted retains its original identifier across updates.
bool EFCRSetContextIdentifier(const char *identifier);
const char *EFCRVersion(void);
#ifdef __cplusplus
}
#endif
#endif
