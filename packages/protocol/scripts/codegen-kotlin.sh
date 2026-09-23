#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# PROTO-01 Kotlin codegen — generates packages/sdk-android/android/traceitx-protocol/.../Generated.kt
# from packages/protocol/schemas-json/envelope.v1.schema.json via quicktype.
#
# Drift gate: CI runs `pnpm -w codegen && git diff --exit-code packages/sdk-android/android/traceitx-protocol/`.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCHEMA_PATH="$REPO_ROOT/packages/protocol/schemas-json/envelope.v1.schema.json"
OUT_PATH="$REPO_ROOT/packages/sdk-android/android/traceitx-protocol/src/main/kotlin/com/traceitx/protocol/generated/Generated.kt"

if [[ ! -f "$SCHEMA_PATH" ]]; then
  echo "schema.json missing at $SCHEMA_PATH; run 'pnpm schema:generate' first" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_PATH")"

# quicktype@23 Kotlin invocation — kotlinx-serialization framework matches our
# :traceitx-protocol module's runtime (see packages/sdk-android/android/traceitx-protocol/build.gradle.kts).
npx --yes quicktype@23 \
  --src-lang schema \
  --src "$SCHEMA_PATH" \
  --lang kotlin \
  --top-level ReportEnvelope \
  --framework kotlinx \
  --package dev.everframe.protocol.generated \
  --out "$OUT_PATH"

# quicktype alphabetizes Kotlin properties, which would insert new optional
# fields into Crash's positional primary constructor. Keep every pre-details
# position stable, including the previously appended JVM and details fields, and
# append causeChain last. The visible legacy constructor and copy overload retain
# source/JVM compatibility; construction maps an old value to no generic cause,
# while copy keeps the receiver's cause. Locate Crash by its own declaration boundary because generated
# supporting declarations can appear between Crash and Frame.
node --input-type=module - "$OUT_PATH" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const source = readFileSync(path, 'utf8');
const blockPattern = /data class Crash \(\n([\s\S]*?)\n\)(?=\n\n@Serializable)/;
const match = source.match(blockPattern);
if (!match) throw new Error('codegen-kotlin: Crash block shape changed');

const jvmProperty = '    val jvm: JVMCrashMetadata? = null';
const detailsProperty = '    val details: CrashDetails? = null';
const causeChainProperty = '    val causeChain: CrashCauseChain? = null';
const properties = match[1].split('\n');
const jvmIndex = properties.indexOf(`${jvmProperty},`);
if (jvmIndex < 0) throw new Error('codegen-kotlin: Crash.jvm property missing or moved');
properties.splice(jvmIndex, 1);
const detailsIndex = properties.indexOf(`${detailsProperty},`);
if (detailsIndex < 0) throw new Error('codegen-kotlin: Crash.details property missing or moved');
properties.splice(detailsIndex, 1);
const causeChainIndex = properties.indexOf(`${causeChainProperty},`);
if (causeChainIndex < 0) throw new Error('codegen-kotlin: Crash.causeChain property missing or moved');
properties.splice(causeChainIndex, 1);

const lastIndex = properties.length - 1;
if (!properties[lastIndex].startsWith('    val threadName:')) {
  throw new Error('codegen-kotlin: expected Crash.threadName to be the final quicktype property');
}
properties[lastIndex] = `${properties[lastIndex]},`;
properties.push(`${jvmProperty},`, `${detailsProperty},`, causeChainProperty);

const compatibilityBody = ` {
    constructor(
        exceptionType: String,
        fatal: Boolean? = null,
        fingerprint: String,
        frames: List<Frame>,
        handled: Boolean,
        jsBundle: JSBundle? = null,
        mechanism: String,
        message: String,
        occurredAt: String,
        threadName: String? = null,
        jvm: JVMCrashMetadata? = null,
        details: CrashDetails? = null,
    ) : this(
        exceptionType, fatal, fingerprint, frames, handled, jsBundle, mechanism,
        message, occurredAt, threadName, jvm, details, null,
    )

    fun copy(
        exceptionType: String = this.exceptionType,
        fatal: Boolean? = this.fatal,
        fingerprint: String = this.fingerprint,
        frames: List<Frame> = this.frames,
        handled: Boolean = this.handled,
        jsBundle: JSBundle? = this.jsBundle,
        mechanism: String = this.mechanism,
        message: String = this.message,
        occurredAt: String = this.occurredAt,
        threadName: String? = this.threadName,
        jvm: JVMCrashMetadata? = this.jvm,
        details: CrashDetails? = this.details,
    ): Crash = Crash(
        exceptionType, fatal, fingerprint, frames, handled, jsBundle, mechanism,
        message, occurredAt, threadName, jvm, details, causeChain,
    )
}`;

let rewritten = source.replace(
  blockPattern,
  `data class Crash (\n${properties.join('\n')}\n)${compatibilityBody}`
);
const formatPattern = /@Serializable\nenum class Format\(val value: String\) \{[\s\S]*?\n\}\n/u;
if (!formatPattern.test(rewritten)) {
  throw new Error('codegen-kotlin: Format block shape changed');
}
rewritten = rewritten.replace(formatPattern, `@Serializable(with = EverframeFormatSerializer::class)
enum class Format(val value: String) {
    @SerialName("everframe-video-v1") EverframeVideoV1("everframe-video-v1"),
    @SerialName("everframe-vtree-v1") EverframeVtreeV1("everframe-vtree-v1"),
    @SerialName("rrweb") Rrweb("rrweb"),
    @SerialName("traceitx-video-v1") TraceitxVideoV1("traceitx-video-v1"),
    @SerialName("traceitx-vtree-v1") TraceitxVtreeV1("traceitx-vtree-v1");
}

object EverframeFormatSerializer : KSerializer<Format> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(
        "dev.everframe.protocol.generated.Format",
        PrimitiveKind.STRING,
    )

    override fun deserialize(decoder: Decoder): Format {
        val wire = decoder.decodeString()
        return Format.values().firstOrNull { it.value == wire }
            ?: throw SerializationException("Unknown Everframe replay format: $wire")
    }

    override fun serialize(encoder: Encoder, value: Format) {
        val encoded = when (value) {
            Format.TraceitxVideoV1 -> "everframe-video-v1"
            Format.TraceitxVtreeV1 -> "everframe-vtree-v1"
            else -> value.value
        }
        encoder.encodeString(encoded)
    }
}
`);
writeFileSync(path, rewritten);
NODE

# Prepend the AUTOGENERATED header marker so CI drift detection and humans
# both see provenance at the top of the file.
HEADER=$'// SPDX-License-Identifier: MIT\n// SPDX-FileCopyrightText: 2026 ScriptX\n// AUTOGENERATED by packages/protocol/scripts/codegen-kotlin.sh \xe2\x80\x94 DO NOT EDIT.\n// To regenerate: pnpm -w codegen\n// CI gate: pnpm -w codegen && git diff --exit-code packages/sdk-android/android/traceitx-protocol/\n\n'
BODY="$(cat "$OUT_PATH")"
printf '%s%s\n' "$HEADER" "$BODY" > "$OUT_PATH"
