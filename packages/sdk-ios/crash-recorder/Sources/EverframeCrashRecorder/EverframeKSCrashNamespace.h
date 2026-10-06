// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#ifndef EVERFRAME_KSCRASH_NAMESPACE_H
#define EVERFRAME_KSCRASH_NAMESPACE_H
// Every vendored translation unit includes this before any system/vendor header.
#ifdef KSCRASH_NAMESPACE
#error EverframeCrashRecorder owns its fixed private namespace
#endif
#define KSCRASH_NAMESPACE _everframe
#include "Vendor/KSCrashCore/include/KSCrashNamespace.h"
// Missing from the pinned upstream generator output; full-object linking verifies these.
#define kscrash_notifyObjCLoad KSCRASH_NS(kscrash_notifyObjCLoad)
#define kscrash_notifyAppActive KSCRASH_NS(kscrash_notifyAppActive)
#define kscrash_notifyAppInForeground KSCRASH_NS(kscrash_notifyAppInForeground)
#define kscrash_notifyAppTerminate KSCRASH_NS(kscrash_notifyAppTerminate)
#define kscrash_notifyAppCrash KSCRASH_NS(kscrash_notifyAppCrash)
#define kscrash_testcode_setMonitors KSCRASH_NS(kscrash_testcode_setMonitors)
#define kscrash_testcode_setLastRunID KSCRASH_NS(kscrash_testcode_setLastRunID)
#endif
