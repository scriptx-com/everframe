// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#ifndef EVERFRAME_QUALIFICATION_MINIMAL_RECORD_H_
#define EVERFRAME_QUALIFICATION_MINIMAL_RECORD_H_
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
namespace crashpad { class ProcessSnapshot; }
namespace everframe_qualification {
constexpr size_t kRecordLimit = 256 * 1024;
using Key = std::array<uint8_t, 32>;
struct FrozenIdentity { std::string report_id, epoch, owner, release; };
struct MinimalRecord {
  FrozenIdentity identity;
  uint32_t signal = 0;
  uint32_t architecture = 0;
  uint64_t pc = 0, module_base = 0, module_offset = 0;
  std::string module, build_id;
};
std::optional<MinimalRecord> ProjectSnapshot(const crashpad::ProcessSnapshot&, const FrozenIdentity&);
std::optional<std::string> SerializeRecord(const MinimalRecord&);
std::optional<std::vector<uint8_t>> SealRecord(const MinimalRecord&, const Key&);
std::optional<std::string> OpenRecord(const std::vector<uint8_t>&, const Key&);
bool WriteEncryptedRecord(const std::string& directory, const std::string& name, const std::vector<uint8_t>&);
}
#endif
