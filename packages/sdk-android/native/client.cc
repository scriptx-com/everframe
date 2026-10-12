// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "handoff.h"
#include <android/api-level.h>
#include <jni.h>
#include <dlfcn.h>
#include <elf.h>
#include <fcntl.h>
#include <link.h>
#include <signal.h>
#include <sys/auxv.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
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
// Executable segments of the dynamic linker this process runs under. The kernel
// loaded it at AT_BASE from the main executable's PT_INTERP, so its extent comes
// from in-memory program headers, read once, without /proc.
struct Linker { std::array<std::pair<uintptr_t,uintptr_t>,4> text{}; size_t count=0; };
Linker FindLinker() {
  const auto* program=reinterpret_cast<const ElfW(Phdr)*>(getauxval(AT_PHDR));
  const size_t count=getauxval(AT_PHNUM);const uintptr_t base=getauxval(AT_BASE);
  if(!program||!count||count>64||!base)return {};
  const ElfW(Phdr)* self=nullptr;const ElfW(Phdr)* interp=nullptr;
  for(size_t i=0;i<count;i++) {
    if(program[i].p_type==PT_PHDR)self=&program[i];
    else if(program[i].p_type==PT_INTERP)interp=&program[i];
  }
  if(!self||!interp||interp->p_filesz<2||interp->p_filesz>256)return {};
  const auto* name=reinterpret_cast<const char*>(reinterpret_cast<uintptr_t>(program)-self->p_vaddr+interp->p_vaddr);
  const std::string_view path(name,interp->p_filesz-1);
  if(name[interp->p_filesz-1]!='\0'||(path!="/system/bin/linker64"&&path!="/system/bin/linker"&&
      path!="/apex/com.android.runtime/bin/linker64"&&path!="/apex/com.android.runtime/bin/linker"))return {};
  const auto* header=reinterpret_cast<const ElfW(Ehdr)*>(base);
  if(memcmp(header->e_ident,ELFMAG,SELFMAG)!=0||header->e_ident[EI_CLASS]!=(sizeof(void*)==8?ELFCLASS64:ELFCLASS32)||
     header->e_type!=ET_DYN||header->e_phentsize!=sizeof(ElfW(Phdr))||!header->e_phnum||header->e_phnum>64)return {};
  const auto* segments=reinterpret_cast<const ElfW(Phdr)*>(base+header->e_phoff);
  Linker linker;bool first=true;
  for(size_t i=0;i<header->e_phnum;i++) {
    const auto& segment=segments[i];
    if(segment.p_type!=PT_LOAD)continue;
    // Linked at zero, so AT_BASE is both the load bias and the mapped ELF header.
    if(first&&(segment.p_vaddr!=0||segment.p_offset!=0))return {};
    first=false;
    if(!(segment.p_flags&PF_X))continue;
    if(linker.count==linker.text.size()||!segment.p_memsz||segment.p_vaddr>UINTPTR_MAX-base-segment.p_memsz)return {};
    linker.text[linker.count++]={base+segment.p_vaddr,base+segment.p_vaddr+segment.p_memsz};
  }
  return linker;
}
bool SystemHandler(const struct sigaction& a) {
  if(a.sa_handler==SIG_DFL)return true;
  if(a.sa_handler==SIG_IGN)return false;
  // Android's linker installs the debuggerd handlers, which dladdr cannot resolve.
  // Accept only the executable segments of the platform linker named by PT_INTERP.
  static const Linker linker=FindLinker();
  const auto address=reinterpret_cast<uintptr_t>(a.sa_sigaction);
  for(size_t i=0;i<linker.count;i++)if(linker.text[i].first<=address&&address<linker.text[i].second)return true;
  Dl_info library{};
  if(!dladdr(reinterpret_cast<void*>(a.sa_sigaction),&library)||!library.dli_fname)return false;
  const std::string path=library.dli_fname;
  // Platform signal chaining is required for ART implicit null checks and debuggerd.
  // App-bundled crash collectors, even with these basenames, are never admitted.
  return (path.starts_with("/system/")||path.starts_with("/apex/")) &&
      (path.ends_with("/libsigchain.so")||path.ends_with("/libart.so")||path.ends_with("/libc.so"));
}
// WebView's in-process Crashpad handler restores the handler it replaced and
// re-raises, so it chains whether it was installed before or after this one.
// Admit it only inside the current provider's APKs or library directory.
bool WebViewHandler(const struct sigaction& a,const std::vector<std::string>& webview) {
  if(a.sa_handler==SIG_DFL||a.sa_handler==SIG_IGN||webview.empty())return false;
  Dl_info library{};
  if(!dladdr(reinterpret_cast<void*>(a.sa_sigaction),&library)||!library.dli_fname)return false;
  const std::string path=library.dli_fname;
  if(!path.ends_with(".so"))return false;
  return std::any_of(webview.begin(),webview.end(),[&](const std::string& root) {
    return path.starts_with(root+"!/")||(path.starts_with(root+"/")&&path.find('/',root.size()+1)==std::string::npos);
  });
}
std::vector<std::string> WebViewPaths(JNIEnv* env,jobjectArray values) {
  std::vector<std::string> paths;
  const jsize count=values?std::min<jsize>(env->GetArrayLength(values),64):0;
  for(jsize i=0;i<count;i++) {
    auto* item=static_cast<jstring>(env->GetObjectArrayElement(values,i));
    if(env->ExceptionCheck())return {};
    const auto path=String(env,item);if(item)env->DeleteLocalRef(item);
    // Absolute and normalized: no empty, '.' or '..' component and no trailing '/'.
    bool normal=path.size()>1&&path.size()<=4096&&path.front()=='/'&&path.back()!='/';
    for(size_t start=1;normal&&start<path.size();) {
      const size_t end=std::min(path.find('/',start),path.size());
      const auto part=std::string_view(path).substr(start,end-start);
      normal=!part.empty()&&part!="."&&part!="..";start=end+1;
    }
    if(normal)paths.push_back(path);
  }
  return paths;
}
bool OwnsSignals(const std::vector<std::string>& webview) {
  for(int s=1;s<NSIG;s++)if(crashpad::Signals::IsCrashSignal(s)) {
    struct sigaction action{};if(sigaction(s,nullptr,&action))return false;
    const bool chaining=WebViewHandler(action,webview);
    if(installed_once) { if(!SameHandler(action,*installed.ActionForSignal(s))&&!chaining)return false; }
    else { if(!SystemHandler(action)&&!chaining)return false;*original.ActionForSignal(s)=action; }
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
bool Spawn(const std::string& directory,const std::string& library,wire::Frame* provision,
    const std::vector<std::string>& webview) {
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
     !wire::Ready(ready,challenge,peer.pid,peer.uid,getuid())||!OwnsSignals(webview))return false;
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
    JNIEnv* env,jclass,jstring directory,jstring libraries,jbyteArray key,jstring epoch,jlong generation,
    jobjectArray webview_paths) {
  std::lock_guard<std::mutex> lock(Operations());
  uint64_t expected=static_cast<uint64_t>(generation);
  if((expected&1)||state.load(std::memory_order_acquire)!=expected)return false;
  const auto webview=WebViewPaths(env,webview_paths);
  if(permanent_failure||android_get_device_api_level()<26||android_get_device_api_level()>30||!OwnsSignals(webview))return false;
  const auto root=String(env,directory),lib=String(env,libraries),id=String(env,epoch);
  if(root.empty()||lib.empty()||id.size()!=32||!key||env->GetArrayLength(key)!=32 ||
     !std::all_of(id.begin(),id.end(),[](char c){return (c>='a'&&c<='f')||(c>='0'&&c<='9');}))return false;
  wire::Frame frame{};frame.kind=wire::kProvision;std::copy(id.begin(),id.end(),frame.epoch.begin());
  env->GetByteArrayRegion(key,0,32,reinterpret_cast<jbyte*>(frame.key.data()));
  bool okay=false;
  if(!env->ExceptionCheck())okay=session?Exchange(&frame,wire::kReady):Spawn(root,lib,&frame,webview);
  wire::Clear(&frame,sizeof frame);
  // A start/disable arriving at any point during provisioning wins this CAS.
  return okay && state.compare_exchange_strong(expected,expected|1,std::memory_order_acq_rel);
}
