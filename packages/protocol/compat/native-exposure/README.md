<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Native exposure compatibility callers

Compile `OldDiagnosticCaller.kt`, `OldConfigCaller.kt` and
`OldJavaConstructors.java` against the pre-exposure protocol and SDK config.
Keep the resulting caller bytecode unchanged when running against a candidate.
`ConfigMain.kt` passes a new opt-in configuration through the old copy call and
checks that release health remains enabled. The diagnostic caller takes a JSON
fixture with a native exposure pointer and prints the result of an old copy call;
the entire pointer, including `loadedBuildId: null`, must survive.

For Swift, compile `OldDiagnosticCaller.swift` to an object against the previous
protocol library with library evolution enabled. Link that unchanged object and
`SwiftMain.swift` against the candidate protocol library. The output must preserve
the fixture's full native exposure pointer. The fixture's explicit date codec
preserves fractional seconds; it does not change SDK date handling.

Also recompile the unchanged Java source against the candidate to exercise the
previous public constructor signatures. Recompiling only Kotlin or Swift source
with default arguments does not test the old binary boundary.
