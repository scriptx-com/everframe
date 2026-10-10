// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <jni.h>
__attribute__((noinline)) void CrashDefaultSegv() {
  // Deliberate address-zero store: SIGSEGV, SEGV_MAPERR.
  asm volatile("str wzr, [%0]" :: "r"(static_cast<void*>(nullptr)) : "memory");
}
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_crashdefault_ProofActivity_segv(JNIEnv*, jobject) { CrashDefaultSegv(); }
