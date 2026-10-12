// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <jni.h>
// Built as libeverframe_release+plus.so: a fault inside a module whose SONAME
// contains '+', as libc++_shared.so does.
__attribute__((noinline)) void PlusModuleFault() {
  asm volatile("str wzr, [%0]" :: "r"(static_cast<void*>(nullptr)) : "memory");
}
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_releaseproof_MainActivity_plusModuleFault(JNIEnv*, jobject) { PlusModuleFault(); }
