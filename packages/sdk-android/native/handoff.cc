// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "handoff.h"
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <poll.h>
#include <fcntl.h>
#include <vector>
#include <sys/socket.h>
#include <unistd.h>
namespace everframe_native::android {
void Clear(void* bytes,size_t size){auto* p=static_cast<volatile uint8_t*>(bytes);while(size--)*p++=0;}
bool KeyAbsentFromInputs(const std::array<uint8_t,32>& key){
  for(const char* name:{"/proc/self/cmdline","/proc/self/environ"}){
    int fd=open(name,O_RDONLY|O_CLOEXEC);if(fd<0)return false;std::vector<uint8_t> bytes;uint8_t chunk[4096];bool okay=true;
    for(;;){ssize_t n=read(fd,chunk,sizeof chunk);if(n<0&&errno==EINTR)continue;if(n==0)break;if(n<0||bytes.size()+n>1024*1024){okay=false;break;}bytes.insert(bytes.end(),chunk,chunk+n);}
    close(fd);Clear(chunk,sizeof chunk);bool absent=std::search(bytes.begin(),bytes.end(),key.begin(),key.end())==bytes.end();Clear(bytes.data(),bytes.size());if(!okay||!absent)return false;
  }
  return true;
}
bool Valid(const Frame& f,uint32_t kind,pid_t pid,uid_t uid,uid_t own){
  if(f.magic!=0x45564644||f.version!=1||f.kind!=kind||pid<=0||f.pid!=pid||uid!=own||
      !std::all_of(f.reserved.begin(),f.reserved.end(),[](auto b){return b==0;}))return false;
  if(kind==kProvision)return std::all_of(f.epoch.begin(),f.epoch.end(),[](char c){return(c>='a'&&c<='f')||(c>='0'&&c<='9');})&&
      std::any_of(f.key.begin(),f.key.end(),[](auto b){return b!=0;});
  return (kind==kReady||kind==kRevoke||kind==kRevoked)&&std::all_of(f.key.begin(),f.key.end(),[](auto b){return b==0;});
}
bool Ready(const Frame& f,const std::array<uint8_t,16>& challenge,pid_t pid,uid_t uid,uid_t own){return Valid(f,kReady,pid,uid,own)&&f.challenge==challenge;}
bool Send(int fd,const Frame& f){ssize_t n;do{n=send(fd,&f,sizeof f,MSG_NOSIGNAL|MSG_DONTWAIT);}while(n<0&&errno==EINTR);return n==sizeof f;}
bool Receive(int fd,Frame* out,Peer* peer,int timeout_ms){
  if(timeout_ms<1||timeout_ms>5000)return false;
  auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(timeout_ms);
  for(;;){
    auto left=std::chrono::duration_cast<std::chrono::milliseconds>(end-std::chrono::steady_clock::now()).count();if(left<=0)return false;
    pollfd p{fd,POLLIN,0};int r=poll(&p,1,static_cast<int>(left));if(r<0&&errno==EINTR)continue;if(r<=0)return false;break;
  }
  Frame incoming{};iovec io{&incoming,sizeof incoming};
  alignas(cmsghdr) unsigned char control[CMSG_SPACE(sizeof(ucred))+CMSG_SPACE(sizeof(int)*4)]{};
  msghdr msg{};msg.msg_iov=&io;msg.msg_iovlen=1;msg.msg_control=control;msg.msg_controllen=sizeof control;
  ssize_t n=recvmsg(fd,&msg,MSG_DONTWAIT|MSG_CMSG_CLOEXEC);
  // Failed recvmsg leaves msg_control unchanged. Never iterate that buffer:
  // Bionic CMSG_NXTHDR does not advance past a zero-length header.
  if(n<0){Clear(&incoming,sizeof incoming);return false;}
  bool okay=n==sizeof incoming&&!(msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC));
  bool found=false;Peer sender{};
  for(auto* c=CMSG_FIRSTHDR(&msg);c;c=CMSG_NXTHDR(&msg,c)){
    size_t offset=reinterpret_cast<unsigned char*>(c)-control;
    if(c->cmsg_len<CMSG_LEN(0)||c->cmsg_len>msg.msg_controllen-offset){okay=false;break;}
    if(c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_CREDENTIALS&&c->cmsg_len==CMSG_LEN(sizeof(ucred))&&!found){ucred credentials{};memcpy(&credentials,CMSG_DATA(c),sizeof credentials);sender={credentials.pid,credentials.uid};found=true;}
    else {
      okay=false;
      if(c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_RIGHTS&&c->cmsg_len>=CMSG_LEN(0)){
        size_t count=(c->cmsg_len-CMSG_LEN(0))/sizeof(int);auto* descriptors=reinterpret_cast<int*>(CMSG_DATA(c));for(size_t i=0;i<count;++i)close(descriptors[i]);
      }
    }
  }
  if(okay&&found){*out=incoming;*peer=sender;}Clear(&incoming,sizeof incoming);return okay&&found;
}
}
