// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#ifndef EVERFRAME_QUALIFICATION_AUTHORITY_H_
#define EVERFRAME_QUALIFICATION_AUTHORITY_H_
#include "minimal_record.h"
#include <functional>
namespace everframe_qualification {
enum class CommitResult { committed, existing, denied, error };
enum class RevokeResult { revoked, cleanup_pending, error };
enum class AuthorityStage { before_lock, inside_lock, after_record_commit };
// Healthy-process qualification primitive only. All callers use this stable
// journal inode; callers generate a fresh random epoch/key after erasure.
class Authority {
 public:
  Authority(std::string directory, const Key& key,
      std::function<void(AuthorityStage)> barrier = {}, bool fail_cleanup = false);
  ~Authority();
  bool Enable(const std::string& new_epoch);
  CommitResult Commit(const std::string& expected_epoch, const std::vector<uint8_t>& encrypted);
  RevokeResult Revoke();
 private:
  const std::string directory_;
  Key key_;
  const std::function<void(AuthorityStage)> barrier_;
  const bool fail_cleanup_;
};
}
#endif
