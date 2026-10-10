// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <jni.h>
__attribute__((noinline)) void CrashDefaultSegv() {
  // Deliberate address-zero store: SIGSEGV, SEGV_MAPERR.
  asm volatile("str wzr, [%0]" :: "r"(static_cast<void*>(nullptr)) : "memory");
}
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_crashdefault_ProofActivity_segv(JNIEnv*, jobject) { CrashDefaultSegv(); }

#include <android/log.h>
#include <cstdlib>
#include <cstdint>
#include <unistd.h>
// Every block stays reachable from here, so the compiler cannot drop the allocations or their writes.
static void* volatile g_blocks = nullptr;
// Keeps allocating resident native memory, in the foreground, until the OS ends the process.
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_crashdefault_ProofActivity_exhaustNative(JNIEnv*, jobject) {
  size_t total = 0;
  uint64_t seed = 0x9e3779b97f4a7c15ull;
  for (;;) {
    const size_t chunk = 16u << 20;
    void* block = malloc(chunk);
    if (block == nullptr) { usleep(100000); continue; }
    // Incompressible bytes: zram cannot fold them away, so the pages stay resident.
    uint64_t* words = static_cast<uint64_t*>(block);
    for (size_t i = 0; i < chunk / sizeof(uint64_t); ++i) {
      seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
      words[i] = seed;
    }
    words[0] = reinterpret_cast<uint64_t>(g_blocks);
    g_blocks = block;
    total += chunk;
    __android_log_print(ANDROID_LOG_INFO, "EverframeCrashDefault", "state=allocated mb=%zu", total >> 20);
    usleep(20000);
  }
}
