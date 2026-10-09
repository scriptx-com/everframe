// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "minimal_record.h"
#include <fcntl.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <sys/stat.h>
#if defined(__ANDROID__) || defined(EVERFRAME_NATIVE_ANDROID_PUBLICATION)
#include <sys/syscall.h>
#include <linux/fs.h>
#endif
#include <unistd.h>
#include <algorithm>
#include <iomanip>
#include <memory>
#include <sstream>
#include "snapshot/process_snapshot.h"
#include "snapshot/exception_snapshot.h"
#include "snapshot/cpu_context.h"
#include "snapshot/module_snapshot.h"
namespace everframe_native {
namespace {
constexpr std::array<uint8_t, 8> kHeader = {'E','V','Q','C',1,0,0,0};
constexpr size_t kNonce = 12, kTag = 16, kPrefix = kHeader.size() + kNonce;
bool Atom(const std::string& text, size_t max) {
  return !text.empty() && text.size() <= max && std::all_of(text.begin(), text.end(), [](unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
  });
}
bool Hex(const std::string& text, size_t max) {
  return !text.empty() && text.size() % 2 == 0 && text.size() <= max && std::all_of(text.begin(), text.end(), [](unsigned char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
  });
}
// The report protocol's module name: well-formed UTF-8 without '/', '\', C0
// controls or DEL. Crashpad names modules by DT_SONAME, so '+', '@' and other
// characters occur (libc++_shared.so, HIDL passthrough libraries).
bool ModuleName(const std::string& text) {
  if (text.empty() || text.size() > 255) return false;
  for (size_t i = 0; i < text.size();) {
    const auto c = static_cast<unsigned char>(text[i]);
    if (c < 0x80) {
      if (c < 0x20 || c == 0x7f || c == '/' || c == '\\') return false;
      i++; continue;
    }
    size_t length = 0; uint32_t point = 0;
    if (c >= 0xc2 && c <= 0xdf) { length = 2; point = c & 0x1f; }
    else if (c >= 0xe0 && c <= 0xef) { length = 3; point = c & 0x0f; }
    else if (c >= 0xf0 && c <= 0xf4) { length = 4; point = c & 0x07; }
    else return false;
    if (length > text.size() - i) return false;
    for (size_t j = 1; j < length; j++) {
      const auto next = static_cast<unsigned char>(text[i + j]);
      if ((next & 0xc0) != 0x80) return false;
      point = (point << 6) | (next & 0x3f);
    }
    // Overlong forms, UTF-16 surrogates and code points above U+10FFFF are invalid.
    if ((length == 3 && point < 0x800) || (length == 4 && (point < 0x10000 || point > 0x10ffff)) ||
        (point >= 0xd800 && point <= 0xdfff)) return false;
    i += length;
  }
  return true;
}
void Quote(std::ostringstream& out, const std::string& text) {
  constexpr char kDigits[] = "0123456789abcdef";
  out << '"';
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') out << '\\' << static_cast<char>(c);
    else if (c < 0x20) out << "\\u00" << kDigits[c >> 4] << kDigits[c & 0xf];
    else out << static_cast<char>(c);
  }
  out << '"';
}
using Cipher = std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)>;
}
std::optional<MinimalRecord> ProjectSnapshot(const crashpad::ProcessSnapshot& snapshot, const FrozenIdentity& identity) {
  const auto* exception = snapshot.Exception();
  if (!exception || !exception->Context()) return std::nullopt;
  MinimalRecord record;
  record.identity = identity; record.signal = exception->Exception();
  // Linux exception snapshots carry si_code here; user-sent signals are negative.
  record.signal_code = static_cast<int32_t>(exception->ExceptionInfo());
  record.thread_id = exception->ThreadID();
  timeval snapshot_time{}; snapshot.SnapshotTime(&snapshot_time);
  if (snapshot_time.tv_sec <= 0 || snapshot_time.tv_usec < 0 || snapshot_time.tv_usec >= 1000000) return std::nullopt;
  record.snapshot_time_ms = static_cast<uint64_t>(snapshot_time.tv_sec) * 1000 + snapshot_time.tv_usec / 1000;
  record.architecture = static_cast<uint32_t>(exception->Context()->architecture);
  const uint64_t pc = exception->Context()->InstructionPointer();
  // A fault outside every module (a null or wild call, JIT or anonymous code), in
  // overlapping modules, or in a module whose name the report cannot carry still
  // commits a frameless record. No caller frame is inferred.
  const crashpad::ModuleSnapshot* match = nullptr;
  bool unique = true;
  for (const auto* module : snapshot.Modules()) {
    if (pc >= module->Address() && pc - module->Address() < module->Size()) {
      if (match) unique = false;
      match = module;
    }
  }
  if (pc && match && unique) {
    const auto name = match->Name();
    auto base = name.substr(name.find_last_of('/') + 1);
    if (ModuleName(base)) {
      record.frame = true; record.pc = pc; record.module_base = match->Address();
      record.module_offset = pc - record.module_base; record.module = std::move(base);
      // A module without a GNU build ID keeps its frame; it cannot be symbolized.
      const auto build = match->BuildID();
      if (!build.empty() && build.size() <= 64) {
        std::ostringstream hex; hex << std::hex << std::setfill('0');
        for (uint8_t byte : build) hex << std::setw(2) << static_cast<unsigned>(byte);
        record.build_id = hex.str();
      }
    }
  }
  if (!SerializeRecord(record)) return std::nullopt;
  return record;
}
std::optional<std::string> SerializeRecord(const MinimalRecord& r) {
  if (!Atom(r.identity.report_id,64) || !Atom(r.identity.epoch,64) || !Atom(r.identity.owner,128) ||
      !Atom(r.identity.release,200)) return std::nullopt;
  if (r.frame ? !r.pc || r.pc < r.module_base || r.pc - r.module_base != r.module_offset || !ModuleName(r.module) ||
          (!r.build_id.empty() && !Hex(r.build_id,128))
      : r.pc || r.module_base || r.module_offset || !r.module.empty() || !r.build_id.empty()) return std::nullopt;
  std::ostringstream out;
  out << "{\"version\":1,\"reportId\":"; Quote(out, r.identity.report_id);
  out << ",\"epoch\":"; Quote(out, r.identity.epoch);
  out << ",\"owner\":"; Quote(out, r.identity.owner);
  out << ",\"release\":"; Quote(out, r.identity.release);
  out << ",\"threadId\":" << r.thread_id << ",\"snapshotTimeMs\":" << r.snapshot_time_ms << ",\"signal\":" << r.signal
      << ",\"signalCode\":" << r.signal_code << ",\"architecture\":" << r.architecture;
  if (r.frame) {
    out << ",\"pc\":" << r.pc << ",\"moduleBase\":" << r.module_base << ",\"moduleOffset\":" << r.module_offset << ",\"module\":";
    Quote(out, r.module);
    if (!r.build_id.empty()) { out << ",\"buildId\":"; Quote(out, r.build_id); }
  }
  out << ",\"partial\":true}";
  return out.str();
}
std::optional<std::vector<uint8_t>> SealRecord(const MinimalRecord& record, const Key& key) {
  const auto plain = SerializeRecord(record);
  if (!plain || plain->size() > kRecordLimit - kPrefix - kTag) return std::nullopt;
  std::vector<uint8_t> output(kPrefix + plain->size() + kTag);
  std::copy(kHeader.begin(), kHeader.end(), output.begin());
  if (RAND_bytes(output.data()+kHeader.size(), kNonce) != 1) return std::nullopt;
  Cipher ctx(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free); int count = 0, final = 0;
  if (!ctx || EVP_EncryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(), output.data()+kHeader.size()) != 1 ||
      EVP_EncryptUpdate(ctx.get(), nullptr, &count, output.data(), kHeader.size()) != 1 ||
      EVP_EncryptUpdate(ctx.get(), output.data()+kPrefix, &count, reinterpret_cast<const uint8_t*>(plain->data()), plain->size()) != 1 ||
      static_cast<size_t>(count) != plain->size() || EVP_EncryptFinal_ex(ctx.get(), output.data()+kPrefix+count, &final) != 1 || final != 0 ||
      EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG, kTag, output.data()+output.size()-kTag) != 1) return std::nullopt;
  return output;
}
std::optional<std::string> OpenRecord(const std::vector<uint8_t>& input, const Key& key) {
  if (input.size() < kPrefix+kTag || input.size() > kRecordLimit || !std::equal(kHeader.begin(), kHeader.end(), input.begin())) return std::nullopt;
  const size_t length = input.size()-kPrefix-kTag;
  std::string plain(length, '\0'); int count=0, final=0;
  Cipher ctx(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
  if (!ctx || EVP_DecryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(), input.data()+kHeader.size()) != 1 ||
      EVP_DecryptUpdate(ctx.get(), nullptr, &count, input.data(), kHeader.size()) != 1 ||
      EVP_DecryptUpdate(ctx.get(), reinterpret_cast<uint8_t*>(plain.data()), &count, input.data()+kPrefix, length) != 1 ||
      static_cast<size_t>(count) != length || EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_TAG, kTag, const_cast<uint8_t*>(input.data()+input.size()-kTag)) != 1 ||
      EVP_DecryptFinal_ex(ctx.get(), reinterpret_cast<uint8_t*>(plain.data())+count, &final) != 1 || final != 0) return std::nullopt;
  return plain;
}
bool WriteEncryptedRecord(const std::string& directory, const std::string& name, const std::vector<uint8_t>& bytes) {
  if (!Atom(name,64) || bytes.size() < kPrefix+kTag || bytes.size() > kRecordLimit) return false;
  const int dir = open(directory.c_str(), O_DIRECTORY|O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  if (dir < 0) return false;
  const std::string temporary = name + ".partial";
  const int fd = openat(dir, temporary.c_str(), O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW, 0600);
  if (fd < 0) { close(dir); return false; }
  size_t offset=0; bool ok=true;
  while (offset < bytes.size()) {
    const ssize_t written=write(fd, bytes.data()+offset, bytes.size()-offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) { ok=false; break; }
    offset += written;
  }
  ok = ok && fsync(fd)==0;
  if (close(fd) != 0) ok=false;
  // Android untrusted_app cannot create hard links in app_data_file. The
  // kernel's no-replace rename preserves immutable publication without that
  // SELinux permission. Unsupported kernels fail closed; never fall back to
  // ordinary replacing rename. The macro qualifies this exact adapter on Linux.
#if defined(__ANDROID__) || defined(EVERFRAME_NATIVE_ANDROID_PUBLICATION)
  if (ok) ok=syscall(SYS_renameat2,dir,temporary.c_str(),dir,name.c_str(),static_cast<unsigned int>(RENAME_NOREPLACE))==0;
#else
  if (ok) ok=linkat(dir, temporary.c_str(), dir, name.c_str(), 0)==0;
#endif
  if (unlinkat(dir, temporary.c_str(), 0) != 0 && errno != ENOENT) ok=false;
  if (ok) ok=fsync(dir)==0;
  close(dir); return ok;
}
}
