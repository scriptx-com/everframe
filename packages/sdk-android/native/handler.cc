// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "handoff.h"
#include "authority.h"
#include "minimal_record.h"
#include <android/api-level.h>
#include <dirent.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include "handler/linux/capture_snapshot.h"
#include "handler/linux/exception_handler_server.h"
#include "snapshot/linux/process_snapshot_linux.h"
#include "snapshot/sanitized/process_snapshot_sanitized.h"
#include "util/linux/direct_ptrace_connection.h"
#include "util/linux/ptrace_client.h"
namespace native = everframe_native;
namespace wire = everframe_native::android;
namespace {
int Number(const std::string& s) {
  char* end=nullptr;long n=strtol(s.c_str(),&end,10);
  return !s.empty()&&*end==0&&n>0&&n<2147483647?static_cast<int>(n):-1;
}
bool InheritedOnly(int control,int crash) {
  DIR* dir=opendir("/proc/self/fd");if(!dir)return false;
  int scan=dirfd(dir);bool okay=true;errno=0;
  while(auto* e=readdir(dir)) {
    char* end=nullptr;long fd=strtol(e->d_name,&end,10);
    if(*end==0&&fd>2&&fd!=scan&&fd!=control&&fd!=crash)okay=false;
  }
  const bool complete=errno==0;closedir(dir);
  return complete&&okay&&control>2&&crash>2&&control!=crash;
}
bool PackagedExecution(const char* library) {
  std::string path=library?library:"";
  if(!path.starts_with("/data/app/")||!path.ends_with("/libeverframe_native_handler.so"))return false;
  char bytes[4096]{};auto count=readlink("/proc/self/exe",bytes,sizeof bytes-1);
  if(count<=0)return false;std::string executable(bytes,count);
  if(android_get_device_api_level()>=29)return executable=="/system/bin/linker64"||executable=="/system/bin/linker"||
      executable=="/apex/com.android.runtime/bin/linker64"||executable=="/apex/com.android.runtime/bin/linker";
  return executable.starts_with("/data/app/")&&executable.ends_with("/libeverframe_native_trampoline.so");
}
class Owner final : public crashpad::ExceptionHandlerServer::Delegate {
 public:
  explicit Owner(std::string root):root_(std::move(root)) {}
  ~Owner() { wire::Clear(key_.data(),key_.size()); }
  bool Provision(const wire::Frame& frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    if(active_)return false;
    epoch_=std::string(frame.epoch.begin(),frame.epoch.end());key_=frame.key;
    native::Authority authority(root_+"/"+epoch_,key_);
    active_=authority.Enable(epoch_);committed_=false;
    if(!active_)wire::Clear(key_.data(),key_.size());
    return active_;
  }
  bool Revoke(bool preserveCommitted=false) {
    std::lock_guard<std::mutex> lock(mutex_);
    if(!active_)return true;
    if(preserveCommitted&&committed_) { active_=false;wire::Clear(key_.data(),key_.size());epoch_.clear();return true; }
    native::Authority authority(root_+"/"+epoch_,key_);
    const auto result=authority.Revoke();
    if(result!=native::RevokeResult::revoked)return false;
    active_=false;wire::Clear(key_.data(),key_.size());epoch_.clear();return true;
  }
  bool HandleException(pid_t pid,uid_t uid,const crashpad::ExceptionHandlerProtocol::ClientInformation& info,
      crashpad::VMAddress stack,pid_t* thread,crashpad::UUID*) override {
    crashpad::DirectPtraceConnection connection;
    return connection.Initialize(pid)&&Capture(&connection,uid,info,stack,thread);
  }
  bool HandleExceptionWithBroker(pid_t pid,uid_t uid,const crashpad::ExceptionHandlerProtocol::ClientInformation& info,
      int socket,crashpad::UUID*) override {
    crashpad::PtraceClient connection;
    return connection.Initialize(socket,pid)&&Capture(&connection,uid,info,0,nullptr);
  }
 private:
  bool Capture(crashpad::PtraceConnection* connection,uid_t uid,
      const crashpad::ExceptionHandlerProtocol::ClientInformation& info,crashpad::VMAddress stack,pid_t* thread) {
    std::lock_guard<std::mutex> lock(mutex_);
    if(!active_)return false;
    std::unique_ptr<crashpad::ProcessSnapshotLinux> snapshot;
    std::unique_ptr<crashpad::ProcessSnapshotSanitized> sanitized;
    if(!crashpad::CaptureSnapshot(connection,info,{},uid,stack,thread,&snapshot,&sanitized))return false;
    const auto record=native::ProjectSnapshot(*snapshot,{epoch_,epoch_,"anonymous","frozen"});
    if(!record)return false;
    const auto cipher=native::SealRecord(*record,key_);
    if(!cipher)return false;
    native::Authority authority(root_+"/"+epoch_,key_);
    const auto result=authority.Commit(epoch_,*cipher);
    committed_=result==native::CommitResult::committed||result==native::CommitResult::existing;
    return committed_;
  }
  const std::string root_;
  std::mutex mutex_;
  bool active_=false,committed_=false;
  std::string epoch_;
  native::Key key_{};
};
}
extern "C" __attribute__((visibility("default"))) int CrashpadHandlerMain(int argc,char** argv) {
  int control=-1,crash=-1,client=-1;std::string root;
  for(int i=1;i<argc;i++) {
    std::string s=argv[i];
    if(s.starts_with("--control-fd="))control=Number(s.substr(13));
    else if(s.starts_with("--initial-client-fd="))crash=Number(s.substr(20));
    else if(s.starts_with("--expected-client="))client=Number(s.substr(18));
    else if(s.starts_with("--records-directory="))root=s.substr(20);
    else return 71;
  }
  struct stat directory{};
  if(client<1||getuid()<10000||root.empty()||lstat(root.c_str(),&directory)||!S_ISDIR(directory.st_mode)||
     directory.st_uid!=getuid()||(directory.st_mode&0077)||!InheritedOnly(control,crash)||!PackagedExecution(argv[0]))return 72;
  wire::Frame frame{};wire::Peer peer{};
  if(!wire::Receive(control,&frame,&peer)||peer.pid!=client||!wire::Valid(frame,wire::kProvision,client,peer.uid,getuid())) {
    wire::Clear(&frame,sizeof frame);return 73;
  }
  const auto challenge=frame.challenge;
  Owner owner(root);const bool provisioned=owner.Provision(frame);wire::Clear(&frame,sizeof frame);
  if(!provisioned)return 74;
  crashpad::ExceptionHandlerServer server;
  if(!server.InitializeWithClient(crashpad::ScopedFileHandle(crash),true)){owner.Revoke();return 75;}
  std::atomic<bool> done{false};
  // Constructing a controller thread is a prerequisite to advertising readiness.
  std::thread controller([&] {
    while(!done.load()) {
      pollfd wait{control,POLLIN,0};int readable=poll(&wait,1,100);
      if(readable==0||(readable<0&&errno==EINTR))continue;
      if(readable<0)break;
      wire::Frame request{};wire::Peer sender{};
      if(!wire::Receive(control,&request,&sender))break;
      const bool valid=sender.pid==client && request.challenge==challenge &&
          wire::Valid(request,request.kind,client,sender.uid,getuid());
      bool accepted=false;uint32_t reply_kind=0;
      if(valid&&request.kind==wire::kRevoke){accepted=owner.Revoke();reply_kind=wire::kRevoked;}
      else if(valid&&request.kind==wire::kProvision){accepted=owner.Provision(request);reply_kind=wire::kReady;}
      wire::Clear(&request,sizeof request);
      if(!accepted)break;
      wire::Frame reply{};reply.kind=reply_kind;reply.pid=getpid();reply.challenge=challenge;
      if(!wire::Send(control,reply))break;
    }
    // Lost control authority cannot leave a live producer with a retained secret.
    // A normal fatal completion is allowed to keep its committed ciphertext.
    if(!done.load()) { owner.Revoke(true);server.Stop(); }
  });
  wire::Frame ready{};ready.kind=wire::kReady;ready.pid=getpid();ready.challenge=challenge;
  if(!wire::Send(control,ready)){owner.Revoke();done.store(true);controller.join();return 76;}
  server.Run(&owner);done.store(true);controller.join();close(control);
  return 0;
}
