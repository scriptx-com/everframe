// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "minimal_handler.h"
#include "authority.h"
#include "handler/linux/capture_snapshot.h"
#include "handler/linux/exception_handler_server.h"
#include "snapshot/linux/process_snapshot_linux.h"
#include "snapshot/sanitized/process_snapshot_sanitized.h"
#include "util/linux/direct_ptrace_connection.h"
#include "util/linux/ptrace_client.h"
namespace everframe_qualification {
class MinimalDelegate final : public crashpad::ExceptionHandlerServer::Delegate {
 public:
  MinimalDelegate(const std::string& directory, const FrozenIdentity& identity, const Key& key)
      : directory_(directory), identity_(identity), key_(key) {}
  bool HandleException(pid_t pid, uid_t uid, const crashpad::ExceptionHandlerProtocol::ClientInformation& info,
      crashpad::VMAddress stack, pid_t* thread, crashpad::UUID*) override {
    crashpad::DirectPtraceConnection connection;
    return connection.Initialize(pid) && Capture(&connection, uid, info, stack, thread);
  }
  bool HandleExceptionWithBroker(pid_t pid, uid_t uid, const crashpad::ExceptionHandlerProtocol::ClientInformation& info,
      int socket, crashpad::UUID*) override {
    crashpad::PtraceClient connection;
    return connection.Initialize(socket, pid) && Capture(&connection, uid, info, 0, nullptr);
  }
  bool committed() const { return committed_; }
 private:
  bool Capture(crashpad::PtraceConnection* connection, uid_t uid,
      const crashpad::ExceptionHandlerProtocol::ClientInformation& info, crashpad::VMAddress stack, pid_t* thread) {
    if (committed_) return false;
    std::unique_ptr<crashpad::ProcessSnapshotLinux> snapshot;
    std::unique_ptr<crashpad::ProcessSnapshotSanitized> sanitized;
    if (!crashpad::CaptureSnapshot(connection, info, {}, uid, stack, thread, &snapshot, &sanitized)) return false;
    const auto projected = ProjectSnapshot(*snapshot, identity_);
    if (!projected) return false;
    const auto cipher = SealRecord(*projected, key_);
    if (!cipher) return false;
    Authority authority(directory_, key_);
    const auto result = authority.Commit(identity_.epoch, *cipher);
    committed_ = result == CommitResult::committed || result == CommitResult::existing;
    return committed_;
  }
  const std::string directory_;
  const FrozenIdentity identity_;
  const Key key_;
  bool committed_ = false;
};
bool RunHandler(int socket, const std::string& directory, const FrozenIdentity& identity, const Key& key) {
  crashpad::ExceptionHandlerServer server;
  // SetHandlerSocket clients speak the shared-connection protocol: after a request they wait
  // for SIGCONT and never read a completion message, so single-client mode holds them 5 s.
  if (!server.InitializeWithClient(crashpad::ScopedFileHandle(socket), true)) return false;
  MinimalDelegate delegate(directory, identity, key);
  server.Run(&delegate);
  return delegate.committed();
}
}
