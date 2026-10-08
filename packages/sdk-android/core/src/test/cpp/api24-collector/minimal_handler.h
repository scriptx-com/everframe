// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#ifndef EVERFRAME_QUALIFICATION_MINIMAL_HANDLER_H_
#define EVERFRAME_QUALIFICATION_MINIMAL_HANDLER_H_
#include "minimal_record.h"
namespace everframe_qualification {
bool RunHandler(int socket, const std::string& directory, const FrozenIdentity&, const Key&);
}
#endif
