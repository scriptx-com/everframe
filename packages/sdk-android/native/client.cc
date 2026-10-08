// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "handoff.h"
#include <android/api-level.h>
#include <jni.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <mutex>
#include <set>
#include <string>
#include <vector>
#include "client/crashpad_client.h"
#include "util/linux/socket.h"
#include "util/posix/signals.h"
#include "util/posix/spawn_subprocess.h"
namespace wire = everframe_native::android;
namespace {
struct Session { int control; pid_t handler; std::array<uint8_t,16> challenge; };
Session* session = nullptr; // Stable process lifetime; signal handlers never access this owner.
std::mutex& Operations() { static auto* mutex=new std::mutex;return *mutex; }
// Low bit is armed; upper bits fence a concurrent SDK pause without a lock.
std::atomic<uint64_t> state{0};
static_assert(std::atomic<uint64_t>::is_always_lock_free);
crashpad::Signals::OldActions original{}, installed{};
bool installed_once = false;
bool permanent_failure = false;

bool FirstChance(int signo, siginfo_t* info, ucontext_t*) {
  if ((state.load(std::memory_order_acquire)&1)) return false;
  // Async-signal-safe upstream restoration preserves Android's normal crash chain.
  crashpad::Signals::RestoreHandlerAndReraiseSignalOnReturn(info, original.ActionForSignal(signo));
  return true;
}
bool Random(void* bytes,size_t size) {
  int fd=open("/dev/urandom",O_RDONLY|O_CLOEXEC); if(fd<0)return false;
  auto* p=static_cast<uint8_t*>(bytes);size_t n=0;
  while(n<size){ssize_t r=read(fd,p+n,size-n);if(r<0&&errno==EINTR)continue;if(r<=0){close(fd);return false;}n+=r;}
  close(fd);return true;
}
std::string String(JNIEnv* env,jstring s) {
  if(!s)return {};const char* p=env->GetStringUTFChars(s,nullptr);
  if(!p)return {};std::string value(p);env->ReleaseStringUTFChars(s,p);return value;
}
bool SameHandler(const struct sigaction& a,const struct sigaction& b) {
  return a.sa_sigaction==b.sa_sigaction && (a.sa_flags&SA_SIGINFO)==(b.sa_flags&SA_SIGINFO);
}
bool SystemHandler(const struct sigaction& a) {
  if(a.sa_handler==SIG_DFL)return true;
  if(a.sa_handler==SIG_IGN)return false;
  Dl_info library{};
  std::string path;
  if(dladdr(reinterpret_cast<void*>(a.sa_sigaction),&library)&&library.dli_fname)path=library.dli_fname;
  else {
    // Android's linker installs debuggerd handlers that dladdr cannot resolve.
    // Accept only its executable mapping at a platform-owned absolute path.
    FILE* maps=fopen("/proc/self/maps","re");if(!maps)return false;
    char line[4096];const auto address=reinterpret_cast<uintptr_t>(a.sa_sigaction);
    for(size_t lines=0;lines<4096&&fgets(line,sizeof line,maps);lines++) {
      unsigned long long begin=0,end=0;char permissions[5]{};int offset=0;
      if(sscanf(line,"%llx-%llx %4s %*s %*s %*s %n",&begin,&end,permissions,&offset)==3 &&
          begin<=address&&address<end&&permissions[2]=='x'&&offset>0) {
        path=line+offset;while(!path.empty()&&(path.back()=='\n'||path.back()=='\r'))path.pop_back();break;
      }
    }
    fclose(maps);
    return path=="/system/bin/linker64"||path=="/system/bin/linker"||
        path=="/apex/com.android.runtime/bin/linker64"||path=="/apex/com.android.runtime/bin/linker";
  }
  // Platform signal chaining is required for ART implicit null checks and debuggerd.
  // App-bundled crash collectors, even with these basenames, are never admitted.
  return (path.starts_with("/system/")||path.starts_with("/apex/")) &&
      (path.ends_with("/libsigchain.so")||path.ends_with("/libart.so")||path.ends_with("/libc.so"));
}
bool OwnsSignals() {
  for(int s=1;s<NSIG;s++)if(crashpad::Signals::IsCrashSignal(s)) {
    struct sigaction action{};if(sigaction(s,nullptr,&action))return false;
    if(installed_once) { if(!SameHandler(action,*installed.ActionForSignal(s)))return false; }
    else { if(!SystemHandler(action))return false;*original.ActionForSignal(s)=action; }
  }
  return true;
}
bool Exchange(wire::Frame* request,uint32_t reply_kind) {
  if(!session)return false;
  request->pid=getpid();request->challenge=session->challenge;
  const bool sent=wire::Send(session->control,*request);wire::Clear(request,sizeof *request);
  wire::Frame reply{};wire::Peer peer{};
  return sent && wire::Receive(session->control,&reply,&peer) && peer.pid==session->handler &&
      wire::Valid(reply,reply_kind,session->handler,peer.uid,getuid()) && reply.challenge==session->challenge;
}
bool Spawn(const std::string& directory,const std::string& library,wire::Frame* provision) {
  crashpad::ScopedFileHandle client,handler,control,handler_control;
  if(!crashpad::UnixCredentialSocket::CreateCredentialSocketpair(&client,&handler) ||
     !crashpad::UnixCredentialSocket::CreateCredentialSocketpair(&control,&handler_control))return false;
  std::vector<std::string> args={"--control-fd="+std::to_string(handler_control.get()),
      "--expected-client="+std::to_string(getpid()),"--records-directory="+directory};
  std::set<int> preserve={handler_control.get()};
  const auto trampoline=library+"/libeverframe_native_trampoline.so", executable=library+"/libeverframe_native_handler.so";
  bool started;
  if(android_get_device_api_level()>=29) {
    started=crashpad::CrashpadClient::StartHandlerWithLinkerForClient(trampoline,executable,sizeof(void*)==8,nullptr,{}, {},"",{},args,handler.get(),preserve);
  } else {
    std::vector<std::string> command={trampoline,executable};command.insert(command.end(),args.begin(),args.end());
    command.push_back("--initial-client-fd="+std::to_string(handler.get()));preserve.insert(handler.get());
    started=crashpad::SpawnSubprocess(command,nullptr,preserve,false,nullptr);
  }
  handler.reset();handler_control.reset();if(!started)return false;
  provision->pid=getpid();if(!Random(provision->challenge.data(),provision->challenge.size()))return false;
  const auto challenge=provision->challenge;
  const bool sent=wire::Send(control.get(),*provision);wire::Clear(provision,sizeof *provision);
  wire::Frame ready{};wire::Peer peer{};
  if(!sent||!wire::Receive(control.get(),&ready,&peer)||peer.pid==getpid() ||
     !wire::Ready(ready,challenge,peer.pid,peer.uid,getuid())||!OwnsSignals())return false;
  // Exactly one installation. Reconfiguration later replaces authority over control only.
  crashpad::CrashpadClient collector;
  if(!collector.SetHandlerSocket(std::move(client),peer.pid)){permanent_failure=true;return false;}
  installed_once=true;
  crashpad::CrashpadClient::SetFirstChanceExceptionHandler(FirstChance);
  for(int s=1;s<NSIG;s++)if(crashpad::Signals::IsCrashSignal(s))
    if(sigaction(s,nullptr,installed.ActionForSignal(s))){permanent_failure=true;return false;}
  session=new Session{control.release(),peer.pid,challenge};
  return true;
}
}
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_nativecrash_NativeCrashBridge_pause(JNIEnv*,jclass) {
  uint64_t old=state.load();
  while(!state.compare_exchange_weak(old,(old+2)&~uint64_t{1})) {}
}
extern "C" JNIEXPORT jlong JNICALL Java_dev_everframe_nativecrash_NativeCrashBridge_generation(JNIEnv*,jclass) {
  return static_cast<jlong>(state.load(std::memory_order_acquire)&~uint64_t{1});
}
extern "C" JNIEXPORT jboolean JNICALL Java_dev_everframe_nativecrash_NativeCrashBridge_revoke(JNIEnv*,jclass) {
  state.fetch_and(~uint64_t{1},std::memory_order_acq_rel);
  std::lock_guard<std::mutex> lock(Operations());
  if(!session)return !permanent_failure;
  wire::Frame frame{};frame.kind=wire::kRevoke;
  return Exchange(&frame,wire::kRevoked);
}
extern "C" JNIEXPORT jboolean JNICALL Java_dev_everframe_nativecrash_NativeCrashBridge_arm(
    JNIEnv* env,jclass,jstring directory,jstring libraries,jbyteArray key,jstring epoch,jlong generation) {
  std::lock_guard<std::mutex> lock(Operations());
  uint64_t expected=static_cast<uint64_t>(generation);
  if((expected&1)||state.load(std::memory_order_acquire)!=expected)return false;
  if(permanent_failure||android_get_device_api_level()<26||android_get_device_api_level()>30||!OwnsSignals())return false;
  const auto root=String(env,directory),lib=String(env,libraries),id=String(env,epoch);
  if(root.empty()||lib.empty()||id.size()!=32||!key||env->GetArrayLength(key)!=32 ||
     !std::all_of(id.begin(),id.end(),[](char c){return (c>='a'&&c<='f')||(c>='0'&&c<='9');}))return false;
  wire::Frame frame{};frame.kind=wire::kProvision;std::copy(id.begin(),id.end(),frame.epoch.begin());
  env->GetByteArrayRegion(key,0,32,reinterpret_cast<jbyte*>(frame.key.data()));
  bool okay=false;
  if(!env->ExceptionCheck())okay=session?Exchange(&frame,wire::kReady):Spawn(root,lib,&frame);
  wire::Clear(&frame,sizeof frame);
  // A start/disable arriving at any point during provisioning wins this CAS.
  return okay && state.compare_exchange_strong(expected,expected|1,std::memory_order_acq_rel);
}
