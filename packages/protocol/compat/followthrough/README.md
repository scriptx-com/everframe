<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Independent diagnostic Payload callers

Compile each caller against its corresponding predecessor before testing the combined model. Apple callers target the Apple-diagnostic 13-field Payload; Observer callers target the recovered-stall 13-field Payload. Retain the compiled JVM jar/Swift object unchanged, then link and run against the candidate. The candidate roundtrip must preserve all diagnostic fields, including fields unknown to the old caller. These model-only roundtrips do not imply that mixed diagnostic envelopes are valid.

The component callers freeze Kotlin destructuring and direct `component13()` calls for both predecessor layouts. The combined model keeps Apple's `component13` for newly compiled source and appends recovered stalls as `component14`; a JVM bridge preserves the observer predecessor's distinct return descriptor for old binaries. Source that uses the old observer positional destructuring must move to named `recoveredStall` access or the new position when recompiling.
