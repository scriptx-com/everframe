// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "handoff.h"
#include "authority.h"
#include "minimal_handler.h"
#include <android/log.h>
#include <android/api-level.h>
#include <dirent.h>
#include <fcntl.h>
#include <poll.h>
#include <cerrno>
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>
namespace eq=everframe_qualification;
namespace qa=everframe_qualification::android;
namespace {
bool PackagedExecution(const char* library){
  std::string module=library?library:"";if(!module.starts_with("/data/app/")||!module.ends_with("/libeverframe_qualification_handler.so"))return false;
  char bytes[4096]{};ssize_t count=readlink("/proc/self/exe",bytes,sizeof bytes-1);if(count<=0)return false;std::string executable(bytes,count);
  if(android_get_device_api_level()>=29)return executable=="/system/bin/linker64"||executable=="/system/bin/linker"||executable=="/apex/com.android.runtime/bin/linker64"||executable=="/apex/com.android.runtime/bin/linker";
  return executable.starts_with("/data/app/")&&executable.ends_with("/libeverframe_qualification_trampoline.so");
}
int Number(const std::string& s){char* end=nullptr;long n=strtol(s.c_str(),&end,10);return !s.empty()&&*end==0&&n>0&&n<2147483647?static_cast<int>(n):-1;}
bool InheritedOnly(int control,int crash){
  DIR* dir=opendir("/proc/self/fd");if(!dir)return false;int scan=dirfd(dir);bool okay=true;errno=0;
  while(auto* e=readdir(dir)){char* end=nullptr;long fd=strtol(e->d_name,&end,10);if(*end==0&&fd>2&&fd!=scan&&fd!=control&&fd!=crash)okay=false;}
  const bool complete=errno==0;closedir(dir);return complete&&okay&&control>2&&crash>2&&control!=crash;
}
std::optional<std::vector<uint8_t>> Read(const std::string& path,size_t cap){
  int fd=open(path.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return std::nullopt;std::vector<uint8_t> out;uint8_t b[4096];
  bool okay=true;for(;;){ssize_t n=read(fd,b,sizeof b);if(n<0&&errno==EINTR)continue;if(n==0)break;if(n<0||out.size()+n>cap){okay=false;break;}out.insert(out.end(),b,b+n);}qa::Clear(b,sizeof b);close(fd);if(!okay){qa::Clear(out.data(),out.size());return std::nullopt;}return out;
}
}
extern "C" __attribute__((visibility("default"))) int CrashpadHandlerMain(int argc,char** argv){
  int control=-1,crash=-1,client=-1;std::string directory;
  for(int i=1;i<argc;i++){
    std::string s=argv[i];
    if(s.starts_with("--control-fd="))control=Number(s.substr(13));
    else if(s.starts_with("--initial-client-fd="))crash=Number(s.substr(20));
    else if(s.starts_with("--expected-client="))client=Number(s.substr(18));
    else if(s.starts_with("--qualification-directory="))directory=s.substr(26);
    else return 71;
  }
  if(directory.empty()||client<1||!InheritedOnly(control,crash)||!PackagedExecution(argv[0]))return 72;
  auto domain=Read("/proc/self/attr/current",4096);
  if(getuid()<10000||!domain||!std::string(domain->begin(),domain->end()).starts_with("u:r:untrusted_app"))return 72;
  qa::Frame frame{};qa::Peer peer{};
  if(!qa::Receive(control,&frame,&peer)||peer.pid!=client||!qa::Valid(frame,qa::kProvision,client,peer.uid,getuid())){qa::Clear(&frame,sizeof frame);return 73;}
  eq::Key key=frame.key;auto challenge=frame.challenge;uint64_t expected_pc=frame.expected_pc;
  eq::FrozenIdentity identity{"android-qualification",std::string(frame.epoch.begin(),frame.epoch.end()),"anonymous-qualification","frozen-native-qualification"};qa::Clear(&frame,sizeof frame);
  bool private_key=qa::KeyAbsentFromInputs(key);
  if(!private_key){qa::Clear(key.data(),key.size());return 74;}
  {eq::Authority authority(directory,key);if(!authority.Enable(identity.epoch)){qa::Clear(key.data(),key.size());return 75;}}
  qa::Frame ready{};ready.kind=qa::kReady;ready.pid=getpid();ready.challenge=challenge;
  if(!qa::Send(control,ready)){eq::Authority authority(directory,key);authority.Revoke();qa::Clear(key.data(),key.size());return 76;}
  __android_log_print(ANDROID_LOG_INFO,"EVNativeQualification","EV_HANDLER ready inherited_fds=2 peer_verified=1 key_not_args_env=1 exec_apk_path=1 untrusted_domain=1 client=%d uid=%d launch=%s",client,getuid(),android_get_device_api_level()>=29?"system-linker":"extracted-trampoline");
  std::atomic<bool> done{false};
  std::thread controller([&]{
    while(!done.load()){
      pollfd wait{control,POLLIN,0};int readable=poll(&wait,1,100);if(readable==0||(readable<0&&errno==EINTR))continue;if(readable<0)break;
      qa::Frame request{};qa::Peer sender{};if(!qa::Receive(control,&request,&sender))break;
      if(sender.pid!=client||!qa::Valid(request,qa::kRevoke,client,sender.uid,getuid())||request.challenge!=challenge)break;
      eq::Authority authority(directory,key);auto result=authority.Revoke();if(result==eq::RevokeResult::error)break;
      qa::Frame reply{};reply.kind=qa::kRevoked;reply.pid=getpid();reply.challenge=challenge;if(!qa::Send(control,reply))break;
    }
  });
  // Android may kill every process in the app group after client death. Verify
  // the durable file in the healthy callback before the fatal client is released.
  bool qualified=false;
  auto after_commit=[&](bool committed){
    bool authenticated=false,exact=false,partial=false,key_absent=true,minimal=false;
    if(committed){auto bytes=Read(directory+"/"+identity.epoch,eq::kRecordLimit);auto plain=bytes?eq::OpenRecord(*bytes,key):std::nullopt;key_absent=bytes&&std::search(bytes->begin(),bytes->end(),key.begin(),key.end())==bytes->end();authenticated=plain.has_value();if(plain){minimal=plain->size()<2048&&plain->find("EV_STACK_SECRET_QUALIFICATION")==std::string::npos&&plain->find("EV_ANNOTATION_SECRET_QUALIFICATION")==std::string::npos&&plain->find("/data/")==std::string::npos;exact=plain->find("\"pc\":"+std::to_string(expected_pc)+",")!=std::string::npos;partial=plain->find("\"partial\":true")!=std::string::npos;qa::Clear(plain->data(),plain->size());}}
    qualified=committed&&authenticated&&partial&&key_absent&&minimal;
    __android_log_print(ANDROID_LOG_INFO,"EVNativeQualification","EV_HANDLER captured committed=%d authenticated=%d exact_pc=%d partial=%d key_not_cipher=%d minimal=%d client=%d",committed,authenticated,exact,partial,key_absent,minimal,client);
  };
  const bool committed=eq::RunHandler(crash,directory,identity,key,after_commit);done.store(true);controller.join();close(control);
  qa::Clear(key.data(),key.size());
  return committed&&qualified?0:77;
}
