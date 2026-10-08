// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Qualification executable only. No SDK entry point or enabled collector.
#include "minimal_handler.h"
#include "authority.h"
#include <openssl/rand.h>
#include <signal.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include "client/crashpad_client.h"
#include "client/crashpad_info.h"
#include "client/simple_string_dictionary.h"
#include "util/linux/socket.h"
extern "C" const char ev_qualification_fault_pc[];
namespace eq = everframe_qualification;
bool AuthorityControls(const std::string&,const eq::Key&);
namespace {
int evidence_pipe = -1;
int worker_gate = -1;
uintptr_t alternate_begin=0,alternate_end=0;
struct sigaction default_action{};
void Token(char value) { if(write(evidence_pipe,&value,1)!=1)_exit(81); }
void PreviousHandler(int sig,siginfo_t*,void*) { Token('P');sigaction(sig,&default_action,nullptr); }
bool FirstChance(int,siginfo_t*,ucontext_t*) {
  int local=0;auto address=reinterpret_cast<uintptr_t>(&local);
  Token(address>=alternate_begin&&address<alternate_end?'S':'N');return false;
}
void RememberAlternateStack() {
  stack_t stack{};if(sigaltstack(nullptr,&stack)!=0||(stack.ss_flags&SS_DISABLE))_exit(82);
  alternate_begin=reinterpret_cast<uintptr_t>(stack.ss_sp);alternate_end=alternate_begin+stack.ss_size;
}
int64_t MonotonicMs() { timespec now{};clock_gettime(CLOCK_MONOTONIC,&now);return int64_t{now.tv_sec}*1000+now.tv_nsec/1000000; }
std::string RandomEpoch() {
  unsigned char bytes[16];if(RAND_bytes(bytes,sizeof bytes)!=1)_exit(83);
  const char* hex="0123456789abcdef";std::string out;for(auto b:bytes){out+=hex[b>>4];out+=hex[b&15];}return out;
}
[[gnu::noinline]] void Overflow(size_t depth) {
  volatile char page[4096];page[depth%sizeof page]=static_cast<char>(depth);
  asm volatile("" : : "r"(&page) : "memory");
  void(*volatile next)(size_t)=Overflow;next(depth+1);
  asm volatile("" : : "r"(&page) : "memory");
}
[[gnu::noinline]] void Fault(const std::string& mode) {
  volatile char stack_secret[64] = "EV_STACK_SECRET_QUALIFICATION";
  asm volatile("" : : "r"(&stack_secret) : "memory");
  if (mode == "abort") abort();
#if defined(__aarch64__)
  asm volatile("mov x9, #0\n.global ev_qualification_fault_pc\nev_qualification_fault_pc:\nstr w9, [x9]\n" : : : "x9", "memory");
#elif defined(__x86_64__)
  asm volatile("xor %%rax, %%rax\n.global ev_qualification_fault_pc\nev_qualification_fault_pc:\nmovb $0, (%%rax)\n" : : : "rax", "memory");
#else
#error Qualification fault instruction requires an explicitly supported host architecture
#endif
  _exit(99);
}
void* Worker(void* argument) {
  const auto& mode=*static_cast<const std::string*>(argument);char go;
  if(read(worker_gate,&go,1)!=1)_exit(84);
  if(mode=="worker-unprepared-overflow") {
    stack_t stack{};if(sigaltstack(nullptr,&stack)!=0||!(stack.ss_flags&SS_DISABLE))_exit(85);Token('U');
  } else {
    if(!crashpad::CrashpadClient::InitializeSignalStackForThread())_exit(86);RememberAlternateStack();
  }
  if(mode=="worker-segv")Fault(mode);else Overflow(0);
  return nullptr;
}
bool CryptoControls(const std::string& directory, const eq::Key& key) {
  eq::MinimalRecord r{{"fixture-report", "fixture-epoch", "fixture-owner", "fixture-release"}, 11, 1, 0x1234, 0x1000, 0x234, "fixture", "aabbccdd"};
  auto sealed=eq::SealRecord(r,key), next=eq::SealRecord(r,key);
  if (!sealed || !next || *sealed==*next || !eq::OpenRecord(*sealed,key)) return false;
  auto tampered=*sealed; tampered.back()^=1;
  auto truncated=*sealed; truncated.pop_back();
  auto wrong=key; wrong[0]^=1;
  if (eq::OpenRecord(tampered,key) || eq::OpenRecord(truncated,key) || eq::OpenRecord(*sealed,wrong)) return false;
  r.identity.release=std::string(eq::kRecordLimit,'x');
  if (eq::SealRecord(r,key)) return false;
  if (eq::WriteEncryptedRecord(directory,"oversize",std::vector<uint8_t>(eq::kRecordLimit+1))) return false;
  if (!std::filesystem::is_empty(directory)) return false;
  std::cout << "{\"oversizeRejectedBeforeWrite\":true,\"tamperRejected\":true,\"truncationRejected\":true,\"wrongKeyRejected\":true,\"freshNonce\":true}\n";
  return true;
}
}
int main(int argc,char** argv) {
  if (argc!=3) return 2;
  const std::string mode=argv[1], directory=argv[2];
  if (mode!="segv" && mode!="abort" && mode!="crypto-controls" && mode!="authority-controls" && mode!="previous-handler" && mode!="worker-segv" && mode!="worker-overflow" && mode!="existing-altstack" && mode!="worker-unprepared-overflow") return 2;
  struct rlimit core={0,0}; if (setrlimit(RLIMIT_CORE,&core)!=0) return 3;
  umask(0077); std::filesystem::create_directories(directory);
  if (!std::filesystem::is_empty(directory)) return 4;
  eq::Key key{}; if (RAND_bytes(key.data(),key.size())!=1) return 5;
  if (mode=="authority-controls") return AuthorityControls(directory,key)?0:6;
  if (mode=="crypto-controls") return CryptoControls(directory,key)?0:6;
  const eq::FrozenIdentity identity{"fixture-report", RandomEpoch(), "fixture-owner", "fixture-release"};
  { eq::Authority authority(directory,key);if(!authority.Enable(identity.epoch))return 11; }
  int events[2],gate[2];if(pipe(events)!=0||pipe(gate)!=0)return 12;
  evidence_pipe=events[1];worker_gate=gate[0];
  crashpad::ScopedFileHandle client_socket, server_socket;
  // Credential reception must be configured before the child can send.
  if (!crashpad::UnixCredentialSocket::CreateCredentialSocketpair(&client_socket, &server_socket)) return 7;
  int sockets[2] = {client_socket.release(), server_socket.release()};
  const pid_t handler=getpid();
  const int64_t forked=MonotonicMs();
  const pid_t client=fork();
  if (client<0) return 8;
  if (client==0) {
    close(sockets[1]);close(events[0]);
    OPENSSL_cleanse(key.data(),key.size());
    crashpad::SimpleStringDictionary annotations;
    annotations.SetKeyValue("qualification", "EV_ANNOTATION_SECRET_QUALIFICATION");
    crashpad::CrashpadInfo::GetCrashpadInfo()->set_simple_annotations(&annotations);
    const bool worker=mode.starts_with("worker-");pthread_t thread{};
    if(worker){pthread_attr_t attr;pthread_attr_init(&attr);pthread_attr_setstacksize(&attr,128*1024);
      if(pthread_create(&thread,&attr,Worker,const_cast<std::string*>(&mode))!=0)_exit(87);pthread_attr_destroy(&attr);}
    void* existing_stack=nullptr;
    if(mode=="existing-altstack") {
      existing_stack=mmap(nullptr,1024*1024,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(existing_stack==MAP_FAILED)_exit(88);
      stack_t stack{existing_stack,0,1024*1024};if(sigaltstack(&stack,nullptr)!=0)_exit(89);
    }
    if(mode=="previous-handler") { default_action.sa_handler=SIG_DFL;sigemptyset(&default_action.sa_mask);
      struct sigaction action{};action.sa_sigaction=PreviousHandler;action.sa_flags=SA_SIGINFO|SA_ONSTACK;sigemptyset(&action.sa_mask);
      if(sigaction(SIGSEGV,&action,nullptr)!=0)_exit(90); }
    crashpad::CrashpadClient crashpad;
    if (!crashpad.SetHandlerSocket(crashpad::ScopedFileHandle(sockets[0]), handler)) _exit(80);
    crashpad::CrashpadClient::SetFirstChanceExceptionHandler(FirstChance);
    if(worker){char go=1;if(write(gate[1],&go,1)!=1)_exit(91);pthread_join(thread,nullptr);_exit(92);}
    RememberAlternateStack();
    if(existing_stack){stack_t stack{};if(sigaltstack(nullptr,&stack)!=0||stack.ss_sp!=existing_stack)_exit(93);Token('E');}
    Fault(mode);
  }
  close(sockets[0]);close(events[1]);close(gate[0]);close(gate[1]);
  const bool committed=eq::RunHandler(sockets[1],directory,identity,key);
  int status=0; if (waitpid(client,&status,0)!=client || !WIFSIGNALED(status)) return 9;
  // Spans fault and capture; a handler that never releases the client adds its 5 s completion wait.
  const int64_t lifetime_ms=MonotonicMs()-forked;
  char observed[16]{};const ssize_t observed_count=read(events[0],observed,sizeof observed);close(events[0]);
  const std::string tokens=observed_count>0?std::string(observed,observed_count):std::string();
  size_t count=0; for (const auto& item : std::filesystem::directory_iterator(directory)) if(item.path().filename()!="authority")++count;
  if(mode=="worker-unprepared-overflow") {
    if(committed||count||WTERMSIG(status)!=SIGSEGV||tokens.find('U')==std::string::npos||tokens.find('S')!=std::string::npos)return 13;
    std::cout<<"{\"fatalSignal\":11,\"clientLifetimeMs\":"<<lifetime_ms<<",\"recordCount\":0,\"unpreparedThreadDeclined\":true}\n";return 0;
  }
  if(!committed)return 9;
  const auto file=directory+"/"+identity.epoch;
  std::ifstream stream(file,std::ios::binary);
  const std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(stream),std::istreambuf_iterator<char>()};
  const auto record=eq::OpenRecord(bytes,key);
  if (!record) return 10;
  std::cout << "{\"fatalSignal\":" << WTERMSIG(status) << ",\"clientLifetimeMs\":" << lifetime_ms << ",\"encryptedBytes\":" << bytes.size()
            << ",\"expectedSegvPc\":" << reinterpret_cast<uintptr_t>(ev_qualification_fault_pc)
            << ",\"recordCount\":" << count << ",\"signalRanOnAlternateStack\":" << (tokens.find('S')!=std::string::npos?"true":"false")
            << ",\"previousHandlerRan\":" << (tokens.find('P')!=std::string::npos?"true":"false")
            << ",\"existingStackPreserved\":" << (tokens.find('E')!=std::string::npos?"true":"false") << ",\"record\":" << *record << "}\n";
  OPENSSL_cleanse(key.data(),key.size()); return 0;
}
