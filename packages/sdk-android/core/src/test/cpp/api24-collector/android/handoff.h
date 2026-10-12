// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#ifndef EVERFRAME_QUALIFICATION_HANDOFF_H_
#define EVERFRAME_QUALIFICATION_HANDOFF_H_
#include <array>
#include <cstddef>
#include <cstdint>
#include <sys/types.h>
namespace everframe_qualification::android {
constexpr uint32_t kProvision=1,kReady=2,kRevoke=3,kRevoked=4;
struct Frame {
  uint32_t magic=0x45564644,version=1,kind=0;int32_t pid=0;
  uint64_t expected_pc=0;
  std::array<uint8_t,32> key{};
  std::array<uint8_t,16> challenge{};
  std::array<char,32> epoch{};
  std::array<uint8_t,24> reserved{};
};
static_assert(sizeof(Frame)==128);
struct Peer {pid_t pid=-1;uid_t uid=static_cast<uid_t>(-1);};
void Clear(void* bytes,size_t size);
bool KeyAbsentFromInputs(const std::array<uint8_t,32>& key);
bool Valid(const Frame&,uint32_t kind,pid_t expected_pid,uid_t sender_uid,uid_t own_uid);
bool Ready(const Frame&,const std::array<uint8_t,16>& challenge,pid_t expected_pid,uid_t sender_uid,uid_t own_uid);
bool Send(int fd,const Frame&);
bool Receive(int fd,Frame*,Peer*,int timeout_ms=5000);
}
#endif
