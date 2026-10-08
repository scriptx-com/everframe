// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "handoff.h"
#include <fcntl.h>
#include <cerrno>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <algorithm>
#include <iostream>
using namespace everframe_qualification::android;
// Host-only syscall fault injection. The iterator trap covers Bionic's lack of
// forward progress for a zero-length header left after failed recvmsg.
static int receive_error=0;
extern "C" ssize_t __real_recvmsg(int,msghdr*,int);
extern "C" ssize_t __wrap_recvmsg(int fd,msghdr* message,int flags){
  if(receive_error){errno=receive_error;return -1;}
  return __real_recvmsg(fd,message,flags);
}
extern "C" cmsghdr* __real___cmsg_nxthdr(msghdr*,cmsghdr*);
extern "C" cmsghdr* __wrap___cmsg_nxthdr(msghdr* message,cmsghdr* header){
  if(header->cmsg_len<sizeof(cmsghdr))_exit(75);
  return __real___cmsg_nxthdr(message,header);
}
#define CHECK(x) do { if(!(x)){std::cerr<<"handoff assertion "<<__LINE__<<"\n";return 70;} } while(false)
int main(int argc,char**){
  Frame frame{};frame.kind=kProvision;frame.pid=getpid();frame.key.fill(0x31);frame.challenge.fill(0x72);frame.epoch.fill('a');
  if(argc==2)return KeyAbsentFromInputs(frame.key)?71:0;
  CHECK(KeyAbsentFromInputs(frame.key));
  pid_t input_child=fork();CHECK(input_child>=0);if(!input_child){execl("/proc/self/exe","handoff-key-negative","11111111111111111111111111111111",nullptr);_exit(72);}
  int input_status;CHECK(waitpid(input_child,&input_status,0)==input_child&&input_status==0);
  CHECK(Valid(frame,kProvision,getpid(),getuid(),getuid()));
  auto bad=frame;bad.version=2;CHECK(!Valid(bad,kProvision,getpid(),getuid(),getuid()));
  CHECK(!Valid(frame,kProvision,getpid()+1,getuid(),getuid()));CHECK(!Valid(frame,kProvision,getpid(),getuid()+1,getuid()));
  bad=frame;bad.epoch[4]='z';CHECK(!Valid(bad,kProvision,getpid(),getuid(),getuid()));
  bad=frame;bad.reserved[0]=1;CHECK(!Valid(bad,kProvision,getpid(),getuid(),getuid()));
  Frame ready{};ready.kind=kReady;ready.pid=getpid();ready.challenge=frame.challenge;
  CHECK(Ready(ready,frame.challenge,getpid(),getuid(),getuid()));bad=ready;bad.challenge[0]^=1;CHECK(!Ready(bad,frame.challenge,getpid(),getuid(),getuid()));
  bad=ready;bad.key[0]=1;CHECK(!Ready(bad,frame.challenge,getpid(),getuid(),getuid()));
  for(int error:{EINTR,EAGAIN,ECONNRESET}){
    int failed[2];CHECK(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,failed)==0);CHECK(Send(failed[0],frame));
    Frame output{};Peer sender{};receive_error=error;CHECK(!Receive(failed[1],&output,&sender,50));receive_error=0;close(failed[0]);close(failed[1]);
  }
  for(int mode=0;mode<7;mode++){
    int pair[2];CHECK(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,pair)==0);int yes=1;
    if(mode!=3)CHECK(setsockopt(pair[1],SOL_SOCKET,SO_PASSCRED,&yes,sizeof yes)==0);
    Frame incoming{};Peer peer{};
    if(mode==0){CHECK(Send(pair[0],frame));CHECK(Receive(pair[1],&incoming,&peer,50));CHECK(peer.pid==getpid()&&peer.uid==getuid()&&incoming.key==frame.key);}
    if(mode==1){CHECK(send(pair[0],&frame,sizeof frame-1,MSG_NOSIGNAL)>0);CHECK(!Receive(pair[1],&incoming,&peer,50));}
    if(mode==2){std::array<unsigned char,sizeof(Frame)+1>large{};CHECK(send(pair[0],large.data(),large.size(),MSG_NOSIGNAL)>0);CHECK(!Receive(pair[1],&incoming,&peer,50));}
    if(mode==3){CHECK(Send(pair[0],frame));CHECK(!Receive(pair[1],&incoming,&peer,50));}
    if(mode==4){close(pair[0]);pair[0]=-1;CHECK(!Receive(pair[1],&incoming,&peer,50));}
    if(mode==5){CHECK(!Receive(pair[1],&incoming,&peer,20));}
    if(mode==6){CHECK(Send(pair[1],frame));close(pair[0]);pair[0]=-1;CHECK(!Receive(pair[1],&incoming,&peer,50));}
    if(pair[0]>=0)close(pair[0]);close(pair[1]);
  }
  int pair[2];CHECK(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,pair)==0);int yes=1;CHECK(setsockopt(pair[0],SOL_SOCKET,SO_PASSCRED,&yes,sizeof yes)==0);
  pid_t child=fork();CHECK(child>=0);if(!child){close(pair[0]);ready.pid=getpid();_exit(Send(pair[1],ready)?0:1);}close(pair[1]);Frame incoming{};Peer peer{};CHECK(Receive(pair[0],&incoming,&peer,1000));CHECK(peer.pid==child&&Ready(incoming,frame.challenge,child,peer.uid,getuid()));int status;CHECK(waitpid(child,&status,0)==child&&status==0);close(pair[0]);
  int rights[2];CHECK(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,rights)==0);CHECK(setsockopt(rights[1],SOL_SOCKET,SO_PASSCRED,&yes,sizeof yes)==0);
  int sentfd=open("/dev/null",O_RDONLY|O_CLOEXEC);CHECK(sentfd>=0);int would_leak=dup(sentfd);CHECK(would_leak>=0);close(would_leak);
  iovec io{&frame,sizeof frame};alignas(cmsghdr) char ancillary[CMSG_SPACE(sizeof(int))]{};msghdr message{};message.msg_iov=&io;message.msg_iovlen=1;message.msg_control=ancillary;message.msg_controllen=sizeof ancillary;
  auto* c=CMSG_FIRSTHDR(&message);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int));*reinterpret_cast<int*>(CMSG_DATA(c))=sentfd;
  CHECK(sendmsg(rights[0],&message,MSG_NOSIGNAL)==sizeof frame);CHECK(!Receive(rights[1],&incoming,&peer,100));CHECK(fcntl(would_leak,F_GETFD)==-1);close(sentfd);close(rights[0]);close(rights[1]);
  // Kernel truncation must still close every installed SCM_RIGHTS descriptor.
  int truncated[2];CHECK(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,truncated)==0);CHECK(setsockopt(truncated[1],SOL_SOCKET,SO_PASSCRED,&yes,sizeof yes)==0);
  sentfd=open("/dev/null",O_RDONLY|O_CLOEXEC);CHECK(sentfd>=0);would_leak=dup(sentfd);CHECK(would_leak>=0);close(would_leak);
  alignas(cmsghdr) char many_rights[CMSG_SPACE(sizeof(int)*20)]{};message.msg_control=many_rights;message.msg_controllen=sizeof many_rights;
  c=CMSG_FIRSTHDR(&message);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int)*20);
  std::fill_n(reinterpret_cast<int*>(CMSG_DATA(c)),20,sentfd);CHECK(sendmsg(truncated[0],&message,MSG_NOSIGNAL)==sizeof frame);CHECK(!Receive(truncated[1],&incoming,&peer,100));
  for(int i=0;i<20;i++)CHECK(fcntl(would_leak+i,F_GETFD)==-1);
  close(sentfd);close(truncated[0]);close(truncated[1]);
  // A stalled healthy peer must never make the writer wait without a bound.
  int full[2];CHECK(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,full)==0);
  child=fork();CHECK(child>=0);if(!child){close(full[1]);alarm(1);for(int i=0;i<100000;i++)if(!Send(full[0],frame))_exit(0);_exit(2);}
  close(full[0]);CHECK(waitpid(child,&status,0)==child&&status==0);close(full[1]);
  Clear(frame.key.data(),frame.key.size());CHECK(std::all_of(frame.key.begin(),frame.key.end(),[](auto b){return b==0;}));
  std::cout<<"PASS handoff version/epoch/reserved/UID/PID/challenge/key-clear controls; actual exact/short/oversize/no-credential/EOF/deadline/forked-peer packets; unexpected/truncated FD rejection/closure; reset/EINTR/EAGAIN failures without invalid ancillary iteration; nonblocking backpressure\n";
}
