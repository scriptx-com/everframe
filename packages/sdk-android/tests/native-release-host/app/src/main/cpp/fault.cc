// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <jni.h>
#include <signal.h>
#include <sys/mman.h>
#include <thread>
#include <unistd.h>
#include <dlfcn.h>
#include <string>
__attribute__((noinline)) void AuthoredReleaseFault() {
  // Deliberate address-zero store; optimized source-line acceptance target.
  asm volatile("str wzr, [%0]" :: "r"(static_cast<void*>(nullptr)) : "memory");
}
__attribute__((noinline)) void NullFunctionCall() {
  void (*target)() = nullptr;
  asm volatile("" : "+r"(target));  // An opaque, real indirect call: the fault PC is zero.
  target();
}
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_releaseproof_MainActivity_nullCall(JNIEnv*, jobject) { NullFunctionCall(); }
// Alternating page protections split one reservation into 2 * pairs mappings, all
// below the dynamic linker in /proc/self/maps.
extern "C" JNIEXPORT jint JNICALL Java_dev_everframe_releaseproof_MainActivity_splitMappings(JNIEnv*, jobject, jint pairs) {
  const size_t page = static_cast<size_t>(sysconf(_SC_PAGESIZE));
  auto* base = static_cast<char*>(mmap(nullptr, page * 2 * pairs, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  if (base == MAP_FAILED) return 0;
  jint split = 0;
  for (jint i = 0; i < pairs; i++) if (mprotect(base + page * 2 * i, page, PROT_READ) == 0) split++;
  return split;
}
static void ForeignHandler(int) { _exit(86); }
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_releaseproof_MainActivity_foreignHandler(JNIEnv*, jobject) {
  struct sigaction action{}; action.sa_handler = ForeignHandler; sigemptyset(&action.sa_mask); sigaction(SIGABRT, &action, nullptr);
}
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_releaseproof_MainActivity_fault(JNIEnv*, jobject, jboolean worker) {
  if (worker) { std::thread thread(AuthoredReleaseFault); thread.join(); } else { AuthoredReleaseFault(); }
}

extern "C" JNIEXPORT jstring JNICALL Java_dev_everframe_releaseproof_MainActivity_signalOwners(JNIEnv* env, jobject) {
  std::string result;
  for (int signal : {SIGSEGV,SIGABRT,SIGBUS,SIGFPE,SIGILL,SIGTRAP,SIGSYS}) {
    struct sigaction action{}; sigaction(signal,nullptr,&action); Dl_info info{};
    dladdr(reinterpret_cast<void*>(action.sa_sigaction),&info);
    result += std::to_string(signal) + ":" + std::to_string(reinterpret_cast<uintptr_t>(action.sa_sigaction)) + ":" + (info.dli_fname ? info.dli_fname : (action.sa_handler == SIG_DFL ? "default" : "unknown")) + "\n";
  }
  return env->NewStringUTF(result.c_str());
}
