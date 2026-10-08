// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include <jni.h>
#include <signal.h>
#include <thread>
#include <unistd.h>
#include <dlfcn.h>
#include <string>
__attribute__((noinline)) void AuthoredReleaseFault() {
  // Deliberate address-zero store; optimized source-line acceptance target.
  asm volatile("str wzr, [%0]" :: "r"(static_cast<void*>(nullptr)) : "memory");
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
