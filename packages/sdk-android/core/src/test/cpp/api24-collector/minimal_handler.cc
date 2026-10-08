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
  MinimalDelegate(const std::string& directory, const FrozenIdentity& identity, const Key& key, const std::function<void(bool)>& after_commit)
      : directory_(directory), identity_(identity), key_(key), after_commit_(after_commit) {}
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
    if (after_commit_) after_commit_(committed_);
    return committed_;
  }
  const std::string directory_;
  const FrozenIdentity identity_;
  const Key key_;
  const std::function<void(bool)> after_commit_;
  bool committed_ = false;
};
class PreparedHandlerImpl final : public PreparedHandler {
 public:
  PreparedHandlerImpl(const std::string& directory, const FrozenIdentity& identity,
                      const Key& key, const std::function<void(bool)>& after_commit)
      : delegate_(directory, identity, key, after_commit) {}
  bool Initialize(int socket) {
    return server_.InitializeWithClient(crashpad::ScopedFileHandle(socket), false);
  }
  bool Run() override { server_.Run(&delegate_); return delegate_.committed(); }
 private:
  crashpad::ExceptionHandlerServer server_;
  MinimalDelegate delegate_;
};
std::unique_ptr<PreparedHandler> PrepareHandler(int socket, const std::string& directory,
    const FrozenIdentity& identity, const Key& key, const std::function<void(bool)>& after_commit) {
  auto handler = std::make_unique<PreparedHandlerImpl>(directory, identity, key, after_commit);
  if (!handler->Initialize(socket)) return nullptr;
  return handler;
}
bool RunHandler(int socket, const std::string& directory, const FrozenIdentity& identity,
                const Key& key, const std::function<void(bool)>& after_commit) {
  auto handler = PrepareHandler(socket, directory, identity, key, after_commit);
  return handler && handler->Run();
}
}
