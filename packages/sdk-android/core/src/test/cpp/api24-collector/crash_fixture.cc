// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Qualification executable only. No SDK entry point or enabled collector.
#include "minimal_handler.h"
#include <openssl/rand.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
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
namespace {
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
  if (mode!="segv" && mode!="abort" && mode!="crypto-controls") return 2;
  struct rlimit core={0,0}; if (setrlimit(RLIMIT_CORE,&core)!=0) return 3;
  umask(0077); std::filesystem::create_directories(directory);
  if (!std::filesystem::is_empty(directory)) return 4;
  eq::Key key{}; if (RAND_bytes(key.data(),key.size())!=1) return 5;
  if (mode=="crypto-controls") return CryptoControls(directory,key)?0:6;
  crashpad::ScopedFileHandle client_socket, server_socket;
  // Credential reception must be configured before the child can send.
  if (!crashpad::UnixCredentialSocket::CreateCredentialSocketpair(&client_socket, &server_socket)) return 7;
  int sockets[2] = {client_socket.release(), server_socket.release()};
  const pid_t handler=getpid();
  const pid_t client=fork();
  if (client<0) return 8;
  if (client==0) {
    close(sockets[1]);
    OPENSSL_cleanse(key.data(),key.size());
    crashpad::SimpleStringDictionary annotations;
    annotations.SetKeyValue("qualification", "EV_ANNOTATION_SECRET_QUALIFICATION");
    crashpad::CrashpadInfo::GetCrashpadInfo()->set_simple_annotations(&annotations);
    crashpad::CrashpadClient crashpad;
    if (!crashpad.SetHandlerSocket(crashpad::ScopedFileHandle(sockets[0]), handler)) _exit(80);
    Fault(mode);
  }
  close(sockets[0]);
  const eq::FrozenIdentity identity{"fixture-report", "fixture-epoch", "fixture-owner", "fixture-release"};
  const bool committed=eq::RunHandler(sockets[1],directory,identity,key);
  int status=0; if (waitpid(client,&status,0)!=client || !WIFSIGNALED(status) || !committed) return 9;
  const auto file=directory+"/"+identity.report_id;
  std::ifstream stream(file,std::ios::binary);
  const std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(stream),std::istreambuf_iterator<char>()};
  const auto record=eq::OpenRecord(bytes,key);
  if (!record) return 10;
  size_t count=0; for (const auto& ignored : std::filesystem::directory_iterator(directory)) { (void)ignored; ++count; }
  std::cout << "{\"fatalSignal\":" << WTERMSIG(status) << ",\"encryptedBytes\":" << bytes.size()
            << ",\"expectedSegvPc\":" << reinterpret_cast<uintptr_t>(ev_qualification_fault_pc)
            << ",\"recordCount\":" << count << ",\"record\":" << *record << "}\n";
  OPENSSL_cleanse(key.data(),key.size()); return 0;
}
