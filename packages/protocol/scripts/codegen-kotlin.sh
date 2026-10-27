#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# PROTO-01 Kotlin codegen — generates packages/sdk-android/android/everframe-protocol/.../Generated.kt
# from packages/protocol/schemas-json/envelope.v1.schema.json via quicktype.
#
# Drift gate: CI runs `pnpm -w codegen && git diff --exit-code packages/sdk-android/android/everframe-protocol/`.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCHEMA_PATH="$REPO_ROOT/packages/protocol/schemas-json/envelope.v1.schema.json"
OUT_PATH="$REPO_ROOT/packages/sdk-android/android/everframe-protocol/src/main/kotlin/dev/everframe/protocol/generated/Generated.kt"

if [[ ! -f "$SCHEMA_PATH" ]]; then
  echo "schema.json missing at $SCHEMA_PATH; run 'pnpm schema:generate' first" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_PATH")"

# quicktype@23 Kotlin invocation — kotlinx-serialization framework matches our
# :everframe-protocol module's runtime (see packages/sdk-android/android/everframe-protocol/build.gradle.kts).
npx --yes quicktype@23 \
  --src-lang schema \
  --src "$SCHEMA_PATH" \
  --lang kotlin \
  --top-level ReportEnvelope \
  --framework kotlinx \
  --package dev.everframe.protocol.generated \
  --out "$OUT_PATH"

# quicktype alphabetizes Kotlin properties, which would insert new optional
# fields into Crash's positional primary constructor. Keep the required fields
# first and append jvm, details, causeChain, native and androidNative last.
# Locate Crash by its own declaration boundary because generated supporting
# declarations can appear between Crash and Frame.
node --input-type=module - "$OUT_PATH" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
let source = readFileSync(path, 'utf8');
// quicktype's sealed union uses polymorphic objects, but state values are JSON primitives.
const stateValuePattern = /@Serializable\nsealed class StateValue \{[\s\S]*?\n\}/;
if (!stateValuePattern.test(source)) throw new Error('codegen-kotlin: StateValue missing');
source = source.replace(stateValuePattern, `@Serializable(with = StateValueSerializer::class)
sealed class StateValue {
    data class BoolValue(val value: Boolean) : StateValue()
    data class DoubleValue(val value: Double) : StateValue()
    data class StringValue(val value: String) : StateValue()
}

object StateValueSerializer : KSerializer<StateValue> {
    override val descriptor: SerialDescriptor = JsonPrimitive.serializer().descriptor
    override fun serialize(encoder: Encoder, value: StateValue) {
        val primitive = when (value) {
            is StateValue.BoolValue -> JsonPrimitive(value.value)
            is StateValue.DoubleValue -> JsonPrimitive(value.value)
            is StateValue.StringValue -> JsonPrimitive(value.value)
        }
        (encoder as JsonEncoder).encodeJsonElement(primitive)
    }
    override fun deserialize(decoder: Decoder): StateValue {
        val primitive = (decoder as JsonDecoder).decodeJsonElement() as? JsonPrimitive
            ?: throw SerializationException("State value must be a primitive")
        if (primitive is JsonNull) throw SerializationException("State value cannot be null")
        if (primitive.isString) return StateValue.StringValue(primitive.content)
        primitive.booleanOrNull?.let { return StateValue.BoolValue(it) }
        primitive.doubleOrNull?.takeIf { it.isFinite() }?.let { return StateValue.DoubleValue(it) }
        throw SerializationException("Invalid state value")
    }
}`);
// Adding a sibling schema must not rename the already published Android types.
for (const [generated, stable] of Object.entries({ DiagnosticAttribution: 'Attribution',
  PurpleProcess: 'Process', SessionEnum: 'Session', DiagnosticOutcome: 'Outcome',
  DiagnosticProvenance: 'Provenance', DiagnosticScope: 'Scope' })) {
  source = source.replace(new RegExp(`\\b${generated}\\b`, 'g'), stable);
}
const blockPattern = /data class Crash \(\n([\s\S]*?)\n\)(?=\n\n@Serializable)/;
const match = source.match(blockPattern);
if (!match) throw new Error('codegen-kotlin: Crash block shape changed');

const jvmProperty = '    val jvm: JVMCrashMetadata? = null';
const detailsProperty = '    val details: CrashDetails? = null';
const causeChainProperty = '    val causeChain: CrashCauseChain? = null';
const nativeProperty = '    val native: NativeCrashMetadata? = null';
const androidNativeProperty = '    val androidNative: AndroidNativeCrashMetadata? = null';
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
const nativeIndex = properties.indexOf(`${nativeProperty},`);
if (nativeIndex < 0) throw new Error('codegen-kotlin: Crash.native property missing or moved');
properties.splice(nativeIndex, 1);
const androidNativeIndex = properties.indexOf(`${androidNativeProperty},`);
if (androidNativeIndex < 0) throw new Error('codegen-kotlin: Crash.androidNative property missing or moved');
properties.splice(androidNativeIndex, 1);

const lastIndex = properties.length - 1;
if (!properties[lastIndex].startsWith('    val threadName:')) {
  throw new Error('codegen-kotlin: expected Crash.threadName to be the final quicktype property');
}
properties[lastIndex] = `${properties[lastIndex]},`;
properties.push(`${jvmProperty},`, `${detailsProperty},`, `${causeChainProperty},`, `${nativeProperty},`, androidNativeProperty);


let rewritten = source.replace(
  blockPattern,
  `data class Crash (\n${properties.join('\n')}\n)`
);
// Keep Payload's positional order stable: the optional diagnostic evidence comes last.
const payloadPattern = /data class Payload \(\n([\s\S]*?)\n\)(?=\n\n@Serializable)/;
const payloadMatch = rewritten.match(payloadPattern);
if (!payloadMatch) throw new Error('codegen-kotlin: Payload block shape changed');
const payloadProperties = payloadMatch[1].split('\n');
const additions = ['diagnostic', 'appleDiagnostic', 'recoveredStall', 'inferredTermination', 'state'];
for (const name of additions) {
  const index = payloadProperties.findIndex(line => line.trim().startsWith(`val ${name}:`));
  if (index < 0) throw new Error(`codegen-kotlin: Payload.${name} missing`);
  payloadProperties.splice(index, 1);
}
const propertiesWithAdditions = [...payloadProperties.map(line => line.replace(/,$/, '')),
  '    val diagnostic: DiagnosticEvidence? = null', '    val appleDiagnostic: AppleDiagnosticEvidence? = null',
  '    val recoveredStall: RecoveredStallEvidence? = null', '    val inferredTermination: InferredTerminationEvidence? = null',
  '    val state: ReportState? = null'];
rewritten = rewritten.replace(payloadPattern, `data class Payload (\n${propertiesWithAdditions.join(',\n')}\n)`);
for (const [generated, stable] of Object.entries({ DiagnosticAndroid: 'Android',
  TraceClass: 'Trace', TraceEnum: 'RecoveredStallTrace', Clock: 'RecoveredStallClock', Eligibility: 'RecoveredStallEligibility',
})) rewritten = rewritten.replace(new RegExp(`\\b${generated}\\b`, 'g'), stable);
// Keep the diagnostic's positional order stable; append the optional exposure.
const evidencePattern = /data class DiagnosticEvidence \(\n([\s\S]*?)\n\)(?=\n\n@Serializable)/;
const evidenceMatch = rewritten.match(evidencePattern);
if (!evidenceMatch) throw new Error('codegen-kotlin: DiagnosticEvidence block shape changed');
const exposureProperty = '    val nativeExposure: NativeExposure? = null,';
const evidenceProperties = evidenceMatch[1].split('\n');
const exposureIndex = evidenceProperties.indexOf(exposureProperty);
if (exposureIndex < 0) throw new Error('codegen-kotlin: DiagnosticEvidence.nativeExposure missing');
evidenceProperties.splice(exposureIndex, 1);
evidenceProperties[evidenceProperties.length - 1] += ',';
evidenceProperties.push('    val nativeExposure: NativeExposure? = null');
rewritten = rewritten.replace(evidencePattern, `data class DiagnosticEvidence (\n${evidenceProperties.join('\n')}\n)`);
// Keep the native metadata's positional order stable; append the release-health evidence.
const nativePattern = /data class NativeCrashMetadata \(\n([\s\S]*?)\n\)(?=\n\n@Serializable)/;
const nativeMatch = rewritten.match(nativePattern);
if (!nativeMatch) throw new Error('codegen-kotlin: NativeCrashMetadata block missing');
const nativeProperties = nativeMatch[1].split('\n');
const healthIndex = nativeProperties.findIndex(p => p.trim().startsWith('val releaseHealthEvidence:'));
if (healthIndex < 0) throw new Error('codegen-kotlin: native health evidence missing');
nativeProperties.splice(healthIndex, 1);
nativeProperties[nativeProperties.length - 1] += ',';
nativeProperties.push('    val releaseHealthEvidence: NativeCrashReleaseHealthEvidence? = null');
rewritten = rewritten.replace(nativePattern, `data class NativeCrashMetadata (\n${nativeProperties.join('\n')}\n)`);
// These nullable fields are required on the wire: the API matches a crash to its
// session by the exact frozen pointer, so a null must be written, never omitted
// by the default encoder configuration.
const exposurePattern = /data class NativeExposure \(\n([\s\S]*?)\n\)/;
const exposureMatch = rewritten.match(exposurePattern);
if (!exposureMatch || !exposureMatch[1].includes('    val loadedBuildID: String? = null,')) {
  throw new Error('codegen-kotlin: NativeExposure.loadedBuildID shape changed');
}
if (!exposureMatch[1].includes('    val app: NativeExposureApp,')) {
  throw new Error('codegen-kotlin: NativeExposure.app missing; the schema must name it NativeExposureApp');
}
rewritten = rewritten.replace(exposurePattern, exposureMatch[0].replace(
  '    val loadedBuildID: String? = null,', '    @Required\n    val loadedBuildID: String? = null,'));
const exposureAppPattern = /data class NativeExposureApp \(\n([\s\S]*?)\n\)/;
const exposureAppMatch = rewritten.match(exposureAppPattern);
if (!exposureAppMatch || !exposureAppMatch[1].includes('    val build: String? = null,')) {
  throw new Error('codegen-kotlin: NativeExposureApp.build shape changed');
}
rewritten = rewritten.replace(exposureAppPattern, exposureAppMatch[0].replace(
  '    val build: String? = null,', '    @Required\n    val build: String? = null,'));
// Append optional app identity to preserve existing positional constructors.
const appPattern = /data class App \(\n([\s\S]*?)\n\)/;
const appMatch = rewritten.match(appPattern);
if (!appMatch) throw new Error('codegen-kotlin: App block missing');
const appProperties = appMatch[1].split('\n');
const bundleIndex = appProperties.indexOf('    val jsBundle: JSBundle? = null,');
if (bundleIndex < 0) throw new Error('codegen-kotlin: App.jsBundle missing');
appProperties.splice(bundleIndex, 1);
appProperties[appProperties.length - 1] += ',';
appProperties.push('    val jsBundle: JSBundle? = null');
// Static app identity (2026-10-26) goes after it, for the same reason.
for (const name of ['id', 'installerPackage']) {
  const index = appProperties.indexOf(`    val ${name}: String? = null,`);
  if (index < 0) throw new Error(`codegen-kotlin: App.${name} missing`);
  appProperties.splice(index, 1);
}
appProperties[appProperties.length - 1] += ',';
appProperties.push('    val id: String? = null,', '    val installerPackage: String? = null');
rewritten = rewritten.replace(appPattern, `data class App (\n${appProperties.join('\n')}\n)`);
// The pointer's app must not take the envelope app's published name.
if (!/\n@Serializable\ndata class App \(\n    val build: String\? = null,\n    val debug: Boolean\? = null,\n    val name: String,\n    val version: String,\n    val jsBundle: JSBundle\? = null,\n    val id: String\? = null,\n    val installerPackage: String\? = null\n\)/.test(rewritten)) {
  throw new Error('codegen-kotlin: App was renamed or reshaped');
}
// Static device identity (2026-10-26) is appended after the existing positional properties.
const devicePattern = /data class Device \(\n([\s\S]*?)\n\)/;
const deviceMatch = rewritten.match(devicePattern);
if (!deviceMatch) throw new Error('codegen-kotlin: Device block missing');
let deviceBody = deviceMatch[1];
const deviceAdditions = [
  ['    val brand: String? = null,\n', '    val brand: String? = null'],
  ['\n    @SerialName("cpuAbi")\n    val cpuABI: List<String>? = null,\n\n',
    '\n    @SerialName("cpuAbi")\n    val cpuABI: List<String>? = null'],
  ['    val emulator: Boolean? = null,\n', '    val emulator: Boolean? = null'],
  ['    val manufacturer: String? = null,\n', '    val manufacturer: String? = null'],
  ['    val runtimeVersions: Map<String, String>? = null,\n', '    val runtimeVersions: Map<String, String>? = null'],
  ['    val totalMemory: Long? = null,\n', '    val totalMemory: Long? = null'],
];
for (const [generated] of deviceAdditions) {
  if (!deviceBody.includes(generated)) throw new Error(`codegen-kotlin: Device field moved: ${generated.trim()}`);
  deviceBody = deviceBody.replace(generated, '');
}
deviceBody = deviceBody.replace(/^\n+/, '');
rewritten = rewritten.replace(devicePattern, `data class Device (\n${deviceBody},\n${deviceAdditions.map(([, appended]) => appended).join(',\n')}\n)`);
if (!/\ndata class Device \(\n    val locale: String,\n    val model: String\? = null,\n    val os: String,\n    val osVersion: String,\n    val pixelRatio: Double,\n    val screenSize: ScreenSize,\n    val timezone: String,\n    val userAgent: String\? = null,\n    val brand/.test(rewritten)) {
  throw new Error('codegen-kotlin: Device was reshaped');
}
const formatPattern = /@Serializable\nenum class Format\(val value: String\) \{[\s\S]*?\n\}\n/u;
if (!formatPattern.test(rewritten)) {
  throw new Error('codegen-kotlin: Format block shape changed');
}
rewritten = rewritten.replace(formatPattern, `@Serializable(with = EverframeFormatSerializer::class)
enum class Format(val value: String) {
    @SerialName("everframe-video-v1") EverframeVideoV1("everframe-video-v1"),
    @SerialName("everframe-vtree-v1") EverframeVtreeV1("everframe-vtree-v1"),
    @SerialName("rrweb") Rrweb("rrweb"),
    @SerialName("traceitx-video-v1") LegacyVideoV1("traceitx-video-v1"),
    @SerialName("traceitx-vtree-v1") LegacyVtreeV1("traceitx-vtree-v1");
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
            Format.LegacyVideoV1 -> "everframe-video-v1"
            Format.LegacyVtreeV1 -> "everframe-vtree-v1"
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
HEADER=$'// SPDX-License-Identifier: MIT\n// SPDX-FileCopyrightText: 2026 ScriptX\n// AUTOGENERATED by packages/protocol/scripts/codegen-kotlin.sh \xe2\x80\x94 DO NOT EDIT.\n// To regenerate: pnpm -w codegen\n// CI gate: pnpm -w codegen && git diff --exit-code packages/sdk-android/android/everframe-protocol/\n\n'
BODY="$(cat "$OUT_PATH")"
printf '%s%s\n' "$HEADER" "$BODY" > "$OUT_PATH"
