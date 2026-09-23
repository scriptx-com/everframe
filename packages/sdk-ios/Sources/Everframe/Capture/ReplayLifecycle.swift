// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/// Shared coordinator state; native capture is owned by NativeVideoSession.
public enum ReplayState: Equatable {
    case idle
    case buffering
    case frozen
    case submitted
    case discarded
}
