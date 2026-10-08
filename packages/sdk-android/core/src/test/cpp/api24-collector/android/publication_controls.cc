// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "minimal_record.h"
#include <cerrno>
#include <cstdarg>
#include <fcntl.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <unistd.h>
#include <filesystem>
#include <fstream>
#include <iostream>
namespace eq=everframe_qualification;
bool AuthorityControls(const std::string&,const eq::Key&);
static bool unavailable=false;
extern "C" int __wrap_linkat(int,const char*,int,const char*,int){errno=EPERM;return -1;}
extern "C" long __real_syscall(long,...);
extern "C" long __wrap_syscall(long number,...){
  if(number!=SYS_renameat2||unavailable){errno=ENOSYS;return -1;}
  va_list args;va_start(args,number);int oldfd=va_arg(args,int);auto* oldname=va_arg(args,const char*);int newfd=va_arg(args,int);auto* newname=va_arg(args,const char*);unsigned int flags=va_arg(args,unsigned int);va_end(args);
  return __real_syscall(number,oldfd,oldname,newfd,newname,flags);
}
#define CHECK(x) do{if(!(x)){std::cerr<<"publication assertion "<<__LINE__<<"\n";return 70;}}while(false)
int main(int argc,char** argv){
  CHECK(argc==2);umask(0077);std::string root=argv[1];CHECK(std::filesystem::create_directory(root));
  std::string dir=root+"/writer";CHECK(std::filesystem::create_directory(dir));eq::Key key{};key.fill(0x37);
  eq::MinimalRecord record{{"report","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","anonymous","release"},11,4,0x1234,0x1000,0x234,"fixture","aabbccdd"};auto bytes=eq::SealRecord(record,key);CHECK(bytes);
  CHECK(eq::WriteEncryptedRecord(dir,"one",*bytes));
  auto different=*bytes;different.back()^=1;CHECK(!eq::WriteEncryptedRecord(dir,"one",different));
  std::ifstream input(dir+"/one",std::ios::binary);std::vector<uint8_t> original((std::istreambuf_iterator<char>(input)),{});CHECK(original==*bytes);
  unavailable=true;CHECK(!eq::WriteEncryptedRecord(dir,"unsupported",*bytes));CHECK(!std::filesystem::exists(dir+"/unsupported")&&!std::filesystem::exists(dir+"/unsupported.partial"));unavailable=false;
  CHECK(AuthorityControls(root,key));
  std::cout<<"PASS no-hardlink publication, immutable duplicate refusal, unsupported syscall fails closed, inherited authority interruption/revocation/concurrency controls\n";
}
