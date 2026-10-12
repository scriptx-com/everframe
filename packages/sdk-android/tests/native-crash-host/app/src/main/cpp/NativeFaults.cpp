// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <jni.h>
#include <signal.h>
#include <stdint.h>

__attribute__((noinline)) static void writeThroughPointer(volatile int* address) {
    *address = 42;
}

extern "C" JNIEXPORT void JNICALL
Java_dev_everframe_nativeproof_NativeFaults_memoryFault(JNIEnv*, jobject, jlong address) {
    writeThroughPointer(reinterpret_cast<volatile int*>(static_cast<uintptr_t>(address)));
}

extern "C" JNIEXPORT void JNICALL
Java_dev_everframe_nativeproof_NativeFaults_abortFault(JNIEnv*, jobject) {
    raise(SIGABRT);
}
