# Independent diagnostic Payload callers

Compile each caller against its corresponding predecessor before testing the combined model. Apple callers target the Apple-diagnostic 13-field Payload; Observer callers target the recovered-stall 13-field Payload. Retain the compiled JVM jar/Swift object unchanged, then link and run against the candidate. The candidate roundtrip must preserve all diagnostic fields, including fields unknown to the old caller. These model-only roundtrips do not imply that mixed diagnostic envelopes are valid.
