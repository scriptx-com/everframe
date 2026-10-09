// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "authority.h"
#include <fcntl.h>
#include <dirent.h>
#include <openssl/sha.h>
#include <openssl/crypto.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <utility>
namespace everframe_native {
namespace {
struct File {
  int fd;
  explicit File(int value):fd(value){}
  ~File(){if(fd>=0)close(fd);}
  File(const File&)=delete; File& operator=(const File&)=delete;
};
constexpr size_t kJournalSize=96, kDigestAt=64;
constexpr std::array<uint8_t,8> kMagic={'E','V','A','U',1,0,0,0};
struct State { std::string epoch; bool enabled=false,used=false; };
bool Epoch(const std::string& s){return s.size()==32&&std::all_of(s.begin(),s.end(),[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');});}
int Directory(const std::string& path){
  int fd=open(path.c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);struct stat s{};
  if(fd>=0&&(fstat(fd,&s)!=0||s.st_uid!=geteuid()||(s.st_mode&0077))){close(fd);return -1;}return fd;
}
bool Regular(int fd){struct stat s{};return fstat(fd,&s)==0&&S_ISREG(s.st_mode)&&s.st_uid==geteuid()&&s.st_nlink==1&&(s.st_mode&0077)==0;}
bool Lock(int fd){if(fd<0||!Regular(fd))return false;int r;do{r=flock(fd,LOCK_EX);}while(r<0&&errno==EINTR);return r==0;}
bool Current(int dir,int fd){struct stat a{},b{};return fstat(fd,&a)==0&&fstatat(dir,"authority",&b,AT_SYMLINK_NOFOLLOW)==0&&a.st_dev==b.st_dev&&a.st_ino==b.st_ino&&S_ISREG(b.st_mode);}
std::optional<State> ReadState(int fd){
  struct stat s{};if(fstat(fd,&s)!=0||s.st_size!=kJournalSize)return std::nullopt;
  std::array<uint8_t,kJournalSize>b{};if(pread(fd,b.data(),b.size(),0)!=static_cast<ssize_t>(b.size()))return std::nullopt;
  std::array<uint8_t,SHA256_DIGEST_LENGTH>digest{};SHA256(b.data(),kDigestAt,digest.data());
  if(!std::equal(kMagic.begin(),kMagic.end(),b.begin())||!std::equal(digest.begin(),digest.end(),b.begin()+kDigestAt)||b[40]>1||b[41]>1||
      !std::all_of(b.begin()+42,b.begin()+kDigestAt,[](uint8_t v){return v==0;}))return std::nullopt;
  State state{std::string(b.begin()+8,b.begin()+40),b[40]!=0,b[41]!=0};if(!Epoch(state.epoch))return std::nullopt;return state;
}
bool WriteState(int fd,const State& s){
  std::array<uint8_t,kJournalSize>b{};std::copy(kMagic.begin(),kMagic.end(),b.begin());std::copy(s.epoch.begin(),s.epoch.end(),b.begin()+8);b[40]=s.enabled;b[41]=s.used;
  SHA256(b.data(),kDigestAt,b.data()+kDigestAt);
  size_t offset=0;while(offset<b.size()){ssize_t n=pwrite(fd,b.data()+offset,b.size()-offset,offset);if(n<0&&errno==EINTR)continue;if(n<=0)return false;offset+=n;}
  return ftruncate(fd,b.size())==0&&fsync(fd)==0;
}
bool Absent(int dir,const std::string& name){struct stat s{};return fstatat(dir,name.c_str(),&s,AT_SYMLINK_NOFOLLOW)!=0&&errno==ENOENT;}
// Initial bootstrap is permitted only in an otherwise empty owned directory.
// A missing journal must not discard a retained record's cleanup obligation.
bool OnlyJournal(int dir){
  int scan=openat(dir,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(scan<0)return false;
  DIR* entries=fdopendir(scan);if(!entries){close(scan);return false;}
  bool empty=true;errno=0;
  while(auto* entry=readdir(entries)){
    std::string name(entry->d_name);
    if(name!="."&&name!=".."&&name!="authority"){empty=false;break;}
  }
  const bool read_ok=errno==0;closedir(entries);return empty&&read_ok;
}
bool Remove(int dir,const std::string& name){return unlinkat(dir,name.c_str(),0)==0||errno==ENOENT;}
std::optional<std::vector<uint8_t>> ReadCipher(int dir,const std::string& name){
  File file(openat(dir,name.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW));if(file.fd<0||!Regular(file.fd))return std::nullopt;
  struct stat s{};if(fstat(file.fd,&s)!=0||s.st_size<36||s.st_size>static_cast<off_t>(kRecordLimit))return std::nullopt;
  std::vector<uint8_t>b(s.st_size);size_t offset=0;while(offset<b.size()){ssize_t n=read(file.fd,b.data()+offset,b.size()-offset);if(n<0&&errno==EINTR)continue;if(n<=0)return std::nullopt;offset+=n;}return b;
}
}
Authority::Authority(std::string directory,const Key& key,std::function<void(AuthorityStage)> barrier,bool fail_cleanup)
 :directory_(std::move(directory)),key_(key),barrier_(std::move(barrier)),fail_cleanup_(fail_cleanup){}
Authority::~Authority(){OPENSSL_cleanse(key_.data(),key_.size());}
bool Authority::Enable(const std::string& epoch){
  if(!Epoch(epoch))return false;File dir(Directory(directory_));if(dir.fd<0)return false;
  int value=openat(dir.fd,"authority",O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW,0600);const bool created=value>=0;
  if(value<0&&errno==EEXIST)value=openat(dir.fd,"authority",O_RDWR|O_CLOEXEC|O_NOFOLLOW);
  File journal(value);if(!Lock(journal.fd)||!Current(dir.fd,journal.fd))return false;
  if(created&&!OnlyJournal(dir.fd))return false;
  if(!created){auto old=ReadState(journal.fd);if(!old||old->enabled||old->epoch==epoch||!Absent(dir.fd,old->epoch)||!Absent(dir.fd,old->epoch+".partial"))return false;}
  return WriteState(journal.fd,State{epoch,true,false})&&fsync(dir.fd)==0;
}
CommitResult Authority::Commit(const std::string& epoch,const std::vector<uint8_t>& encrypted){
  if(!Epoch(epoch))return CommitResult::error;auto incoming=OpenRecord(encrypted,key_);
  if(!incoming||incoming->find("\"epoch\":\""+epoch+"\"")==std::string::npos)return CommitResult::error;
  if(barrier_)barrier_(AuthorityStage::before_lock);
  File dir(Directory(directory_));if(dir.fd<0)return CommitResult::error;
  File journal(openat(dir.fd,"authority",O_RDWR|O_CLOEXEC|O_NOFOLLOW));if(!Lock(journal.fd)||!Current(dir.fd,journal.fd))return CommitResult::error;
  auto state=ReadState(journal.fd);if(!state)return CommitResult::error;if(!state->enabled||state->epoch!=epoch)return CommitResult::denied;
  if(barrier_)barrier_(AuthorityStage::inside_lock);
  if(!Absent(dir.fd,epoch)){
    auto existing=ReadCipher(dir.fd,epoch);if(!existing)return CommitResult::error;auto plain=OpenRecord(*existing,key_);
    if(!plain||*plain!=*incoming)return CommitResult::error;
    if(!state->used){state->used=true;if(!WriteState(journal.fd,*state))return CommitResult::error;}
    return CommitResult::existing;
  }
  if(state->used)return CommitResult::denied;
  if(!Remove(dir.fd,epoch+".partial")||!WriteEncryptedRecord(directory_,epoch,encrypted))return CommitResult::error;
  if(barrier_)barrier_(AuthorityStage::after_record_commit);
  state->used=true;return WriteState(journal.fd,*state)?CommitResult::committed:CommitResult::error;
}
RevokeResult Authority::Revoke(){
  File dir(Directory(directory_));if(dir.fd<0)return RevokeResult::error;
  File journal(openat(dir.fd,"authority",O_RDWR|O_CLOEXEC|O_NOFOLLOW));if(!Lock(journal.fd)||!Current(dir.fd,journal.fd))return RevokeResult::error;
  auto state=ReadState(journal.fd);if(!state)return RevokeResult::error;
  state->enabled=false;if(!WriteState(journal.fd,*state))return RevokeResult::error;
  if(fail_cleanup_)return RevokeResult::cleanup_pending;
  const bool record=Remove(dir.fd,state->epoch),temporary=Remove(dir.fd,state->epoch+".partial");
  return record&&temporary&&fsync(dir.fd)==0?RevokeResult::revoked:RevokeResult::cleanup_pending;
}
}
