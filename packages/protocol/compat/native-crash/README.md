<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Frozen Crash callers

Compile these callers against the protocol module immediately before native crash
metadata was added, then keep the object/class bytes unchanged when testing the new
module. Recompiling callers against the candidate would hide ABI regressions.

- Swift: compile the predecessor Generated.swift and CrashCompat.swift as an
  EverframeProtocol module with library evolution enabled. Compile both OldCrash
  caller sources against it. Link SwiftMain.swift and those saved objects against
  the candidate library. Pass the crash object from the apple-native-crash fixture;
  both JSON output lines must preserve its complete native sidecar.
- Kotlin: compile OldCrashCaller.kt against the predecessor protocol jar. Run the
  saved class with only the candidate protocol jar and matching Kotlin/serialization
  runtime dependencies. Pass the same crash object; output must retain its sidecar.
  check-crash-model-compat.mjs additionally checks the complete public descriptor
  superset and saved-caller hashes.

The explicit causeChain copy and older copy overloads are both intentional. Old
constructors must still work, and copying an instance created by newer code must
retain native metadata that the old caller cannot name.
