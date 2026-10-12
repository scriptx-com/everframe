<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Frozen Payload callers before inferred terminations

Both callers freeze the Payload constructors and copy/`with` entry points that existed immediately before `inferredTermination` was added: Kotlin's 14-argument positional constructor and its `copy(diagnostic, appleDiagnostic, recoveredStall, …)`, and Swift's 14-label memberwise initializer and `with(extra:)`. Compile each caller against that predecessor protocol and keep the compiled JVM class/Swift object unchanged. Then link and run it against the candidate with a payload that carries `inferredTermination`. The copied output must keep the complete evidence and change only `extra`. Never recompile the saved caller against the candidate: that would hide a missing initializer, copy descriptor or default mask.

Run them as `compat/diagnostic/README.md` documents for its callers. For Kotlin, `check-crash-model-compat.mjs --model Payload` also compares the full old public descriptor set with the candidate. Swift keeps the old initializer through `PayloadCompat.swift`; its compat `with` overloads carry `inferredTermination` through unchanged.
