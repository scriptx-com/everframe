// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "authority.h"
#include <fcntl.h>
#include <openssl/rand.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <filesystem>
#include <fstream>
#include <iostream>
namespace eq = everframe_qualification;
namespace {
#define Check(ok) do { if (!(ok)) { std::cerr<<"authority assertion line "<<__LINE__<<"\n"; _exit(70); } } while(false)
void Send(int fd) { char b=1; Check(write(fd,&b,1)==1); }
void Receive(int fd) { pollfd p{fd,POLLIN,0}; Check(poll(&p,1,5000)==1); char b; Check(read(fd,&b,1)==1); }
void Wait(pid_t pid,int code) { int s; Check(waitpid(pid,&s,0)==pid && WIFEXITED(s) && WEXITSTATUS(s)==code); }
std::string Epoch() { unsigned char b[16]; Check(RAND_bytes(b,sizeof b)==1); const char* h="0123456789abcdef"; std::string s; for (auto c:b) { s+=h[c>>4]; s+=h[c&15]; } return s; }
std::vector<uint8_t> Bytes(const eq::Key& key,const std::string& epoch) {
  eq::MinimalRecord r{{"fixture-report",epoch,"opaque-owner","frozen-release"},11,4,0x1234,0x1000,0x234,"fixture","aabbccdd"};
  auto result=eq::SealRecord(r,key); Check(result.has_value()); return *result;
}
size_t Records(const std::string& d) { size_t n=0; for(const auto& p:std::filesystem::directory_iterator(d)) if(p.path().filename()!="authority") ++n; return n; }
}
bool AuthorityControls(const std::string& root,const eq::Key& key) {
  using R=eq::CommitResult; using V=eq::RevokeResult; using S=eq::AuthorityStage;
  {
    auto make=[&](const char* name){ auto d=root+"/"+name; std::filesystem::create_directory(d); return d; };
    {
      auto d=make("normal"),e=Epoch(); eq::Authority a(d,key); Check(a.Enable(e)); auto b=Bytes(key,e);
      Check(a.Commit(e,b)==R::committed); Check(a.Commit(e,Bytes(key,e))==R::existing); Check(Records(d)==1);
      auto bad=b; bad.back()^=1; Check(a.Commit(e,bad)==R::error); Check(Records(d)==1);
      Check(a.Revoke()==V::revoked); Check(a.Commit(e,b)==R::denied); Check(Records(d)==0);
    }
    {
      auto d=make("before"),e=Epoch(); eq::Authority a(d,key); Check(a.Enable(e)); auto b=Bytes(key,e);
      int ready[2],go[2]; Check(pipe(ready)==0 && pipe(go)==0); pid_t p=fork(); Check(p>=0);
      if(!p) { eq::Authority child(d,key,[&](S s){if(s==S::before_lock){Send(ready[1]);Receive(go[0]);}}); _exit(child.Commit(e,b)==R::denied?0:30); }
      Receive(ready[0]); Check(a.Revoke()==V::revoked); Send(go[1]); Wait(p,0); Check(Records(d)==0);
      for(int fd:{ready[0],ready[1],go[0],go[1]})close(fd);
    }
    {
      auto d=make("locked"),e=Epoch(); eq::Authority a(d,key); Check(a.Enable(e)); auto b=Bytes(key,e);
      int ready[2],go[2],started[2],done[2]; Check(pipe(ready)==0&&pipe(go)==0&&pipe(started)==0&&pipe(done)==0);
      pid_t writer=fork(); Check(writer>=0);
      if(!writer){eq::Authority child(d,key,[&](S s){if(s==S::inside_lock){Send(ready[1]);Receive(go[0]);}});_exit(child.Commit(e,b)==R::committed?0:31);}
      Receive(ready[0]); pid_t revoker=fork(); Check(revoker>=0);
      if(!revoker){Send(started[1]); auto v=a.Revoke();Send(done[1]);_exit(v==V::revoked?0:32);}
      Receive(started[0]);pollfd wait{done[0],POLLIN,0};Check(poll(&wait,1,150)==0);
      Send(go[1]);Wait(writer,0);Receive(done[0]);Wait(revoker,0);Check(Records(d)==0);Check(a.Commit(e,b)==R::denied);
      for(int fd:{ready[0],ready[1],go[0],go[1],started[0],started[1],done[0],done[1]})close(fd);
    }
    {
      auto d=make("failed-cleanup"),e=Epoch(),next=Epoch();eq::Authority a(d,key);Check(a.Enable(e));auto b=Bytes(key,e);Check(a.Commit(e,b)==R::committed);
      struct stat first{},last{};Check(stat((d+"/authority").c_str(),&first)==0);
      eq::Authority failing(d,key,{},true);Check(failing.Revoke()==V::cleanup_pending);Check(a.Commit(e,b)==R::denied);Check(!a.Enable(next));
      Check(a.Revoke()==V::revoked);Check(!a.Enable(e));eq::Key new_key=key;new_key[0]^=1;eq::Authority fresh(d,new_key);Check(fresh.Enable(next));
      Check(a.Commit(e,b)==R::denied);Check(fresh.Commit(next,Bytes(new_key,next))==R::committed);
      Check(stat((d+"/authority").c_str(),&last)==0&&first.st_ino==last.st_ino);Check(Records(d)==1);
    }
    for(const char* mode:{"missing-retained-record","missing-retained-temporary"}) {
      auto d=make(mode),e=Epoch();eq::Authority a(d,key);Check(a.Enable(e));auto b=Bytes(key,e);
      if(std::string(mode)=="missing-retained-record")Check(a.Commit(e,b)==R::committed);
      else {std::ofstream partial(d+"/"+e+".partial",std::ios::binary);partial.write(reinterpret_cast<const char*>(b.data()),10);}
      eq::Authority failing(d,key,{},true);Check(failing.Revoke()==V::cleanup_pending);
      Check(unlink((d+"/authority").c_str())==0);Check(Records(d)==1);
      eq::Key next_key=key;next_key[0]^=1;eq::Authority fresh(d,next_key);
      Check(!fresh.Enable(Epoch()));Check(Records(d)==1);Check(!fresh.Enable(Epoch()));
      Check(a.Commit(e,b)==R::error);Check(fresh.Revoke()==V::error);Check(Records(d)==1);
    }
    for(const char* mode:{"missing","malformed","partial"}) {
      auto d=make(mode),e=Epoch();eq::Authority a(d,key);Check(a.Enable(e));auto b=Bytes(key,e);
      if(std::string(mode)=="missing") Check(unlink((d+"/authority").c_str())==0);
      else {int fd=open((d+"/authority").c_str(),O_WRONLY);Check(fd>=0);const char poison[]="not-an-authority";Check(pwrite(fd,poison,sizeof poison,0)==sizeof poison);if(std::string(mode)=="partial")Check(ftruncate(fd,12)==0);close(fd);}
      Check(a.Commit(e,b)==R::error);Check(Records(d)==0);Check(a.Revoke()==V::error);
    }
    {
      auto d=make("committed-interruption"),e=Epoch();eq::Authority a(d,key);Check(a.Enable(e));auto b=Bytes(key,e);pid_t p=fork();Check(p>=0);
      if(!p){eq::Authority child(d,key,[](S s){if(s==S::after_record_commit)_exit(41);});child.Commit(e,b);_exit(42);}
      Wait(p,41);Check(Records(d)==1);Check(a.Commit(e,Bytes(key,e))==R::existing);Check(Records(d)==1);
      int fd=open((d+"/"+e).c_str(),O_WRONLY);Check(fd>=0);char bad=0;Check(pwrite(fd,&bad,1,0)==1);close(fd);
      Check(a.Commit(e,b)==R::error);Check(Records(d)==1);
    }
    {
      auto d=make("temporary-interruption"),e=Epoch();eq::Authority a(d,key);Check(a.Enable(e));auto b=Bytes(key,e);
      std::ofstream partial(d+"/"+e+".partial",std::ios::binary);partial.write(reinterpret_cast<char*>(b.data()),10);partial.close();
      Check(a.Commit(e,b)==R::committed);Check(Records(d)==1);
    }
    {
      auto d=make("concurrent"),e=Epoch();eq::Authority a(d,key);Check(a.Enable(e));auto b=Bytes(key,e);int ready[2],go[2];Check(pipe(ready)==0&&pipe(go)==0);
      pid_t children[2];for(auto& p:children){p=fork();Check(p>=0);if(!p){eq::Authority child(d,key,[&](S s){if(s==S::before_lock){Send(ready[1]);Receive(go[0]);}});auto r=child.Commit(e,b);_exit(r==R::committed?10:r==R::existing?11:12);}}
      Receive(ready[0]);Receive(ready[0]);Send(go[1]);Send(go[1]);int sum=0;for(auto p:children){int s;Check(waitpid(p,&s,0)==p&&WIFEXITED(s));sum+=WEXITSTATUS(s);}Check(sum==21);Check(Records(d)==1);
      for(int fd:{ready[0],ready[1],go[0],go[1]})close(fd);
    }
    std::cout<<"{\"authenticatedReplay\":true,\"revokeBeforeAdmission\":true,\"revokeWaitsForCommit\":true,\"failedEraseBlocksEnable\":true,\"staleEpochDenied\":true,\"stableAuthorityInode\":true,\"missingJournalRetainedCleanupDenied\":true,\"invalidJournalDenied\":true,\"commitInterruptionDeduplicated\":true,\"temporaryInterruptionRecovered\":true,\"concurrentCommitDeduplicated\":true}\n";
    return true;
  }
}
