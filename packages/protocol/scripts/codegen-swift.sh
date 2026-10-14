#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# PROTO-01 Swift codegen — generates packages/sdk-ios/Sources/EverframeProtocol/Generated.swift
# from packages/protocol/schemas-json/envelope.v1.schema.json via quicktype.
#
# Drift gate: CI runs `pnpm -w codegen && git diff --exit-code packages/sdk-ios/Sources/EverframeProtocol/`.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCHEMA_PATH="$REPO_ROOT/packages/protocol/schemas-json/envelope.v1.schema.json"
OUT_PATH="$REPO_ROOT/packages/sdk-ios/Sources/EverframeProtocol/Generated.swift"

if [[ ! -f "$SCHEMA_PATH" ]]; then
  echo "schema.json missing at $SCHEMA_PATH; run 'pnpm schema:generate' first" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_PATH")"

# Plan-locked invocation adjusted for quicktype@23 valid flags.
# See the implementation notes for rationale.
npx --yes quicktype@23 \
  --src-lang schema \
  --src "$SCHEMA_PATH" \
  --lang swift \
  --top-level ReportEnvelope \
  --struct-or-class struct \
  --density dense \
  --access-level public \
  --type-prefix Everframe \
  --out "$OUT_PATH"

# quicktype's --type-prefix covers schema-derived declarations but leaves its
# two open-JSON helper classes unprefixed. They are public generated types too,
# so normalize both their declarations and every reference before adding the
# provenance header.
node --input-type=module - "$OUT_PATH" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
let source = readFileSync(path, 'utf8')
  .replace(/\bJSONNull\b/g, 'EverframeJSONNull')
  .replace(/\bJSONAny\b/g, 'EverframeJSONAny');
// Preserve published Android diagnostic type identities after sibling-schema naming.
for (const [generated, stable] of Object.entries({ DiagnosticAttribution: 'Attribution',
  PurpleProcess: 'Process', SessionEnum: 'Session', DiagnosticOutcome: 'Outcome',
  DiagnosticProvenance: 'Provenance', DiagnosticScope: 'Scope' })) {
  source = source.replace(new RegExp(`\\bEverframe${generated}\\b`, 'g'), `Everframe${stable}`);
}
source = source.replace(/jsBundle: EverframeJSBundle\?,/g, 'jsBundle: EverframeJSBundle? = nil,');
source = source.replace(/state: EverframeReportState\?,/g, 'state: EverframeReportState? = nil,');
// Optional diagnostic evidence defaults to nil, so SDK call sites name only what they carry.
source = source.replace(/diagnostic: EverframeDiagnosticEvidence\?,/g, 'diagnostic: EverframeDiagnosticEvidence? = nil,');
source = source.replace(/appleDiagnostic: EverframeAppleDiagnosticEvidence\?,/g, 'appleDiagnostic: EverframeAppleDiagnosticEvidence? = nil,');
source = source.replace(/nativeExposure: EverframeNativeExposure\?,/g, 'nativeExposure: EverframeNativeExposure? = nil,');
// Codable's synthesized optional encoder omits nil. The frozen pointer's nullable
// fields are required: the API matches a crash to its session by the exact
// pointer, so preserve every explicit JSON null.
const exposurePattern = /public struct EverframeNativeExposure: Codable \{[\s\S]*?\n\}/;
const exposureBlock = source.match(exposurePattern)?.[0];
if (!exposureBlock) throw new Error('codegen-swift: NativeExposure block missing');
if (!exposureBlock.includes('    public let app: EverframeNativeExposureApp\n')) {
  throw new Error('codegen-swift: NativeExposure.app missing; the schema must name it NativeExposureApp');
}
source = source.replace(exposurePattern, block => block.slice(0, -1) + `
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(app, forKey: .app)
        try container.encode(exposureID, forKey: .exposureID)
        try container.encode(loadedBuildID, forKey: .loadedBuildID)
        try container.encode(loadedBundleStatus, forKey: .loadedBundleStatus)
        try container.encode(processLaunchID, forKey: .processLaunchID)
        try container.encode(startedAt, forKey: .startedAt)
    }
}`);
const exposureAppPattern = /public struct EverframeNativeExposureApp: Codable \{[\s\S]*?\n\}/;
const exposureAppBlock = source.match(exposureAppPattern)?.[0];
if (!exposureAppBlock || !exposureAppBlock.includes('    public let build: String?\n')
  || !exposureAppBlock.includes('    public let debug: Bool\n')
  || !exposureAppBlock.includes('    public let version: String\n')) {
  throw new Error('codegen-swift: NativeExposureApp block missing or reshaped');
}
source = source.replace(exposureAppPattern, block => block.slice(0, -1) + `
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(build, forKey: .build)
        try container.encode(debug, forKey: .debug)
    }
}`);
// The pointer's app must not take the envelope app's published name.
if (!source.includes('public struct EverframeApp: Codable {\n    public let build: String?\n    public let debug: Bool?\n    public let jsBundle: EverframeJSBundle?\n    public let name, version: String\n')) {
  throw new Error('codegen-swift: EverframeApp was renamed or reshaped');
}
source = source.replace(/recoveredStall: EverframeRecoveredStallEvidence\?,/g, 'recoveredStall: EverframeRecoveredStallEvidence? = nil,');
for (const [generated, stable] of Object.entries({
  DiagnosticAndroid: 'Android', DiagnosticAttribution: 'Attribution',
  DiagnosticOutcome: 'Outcome', DiagnosticProvenance: 'Provenance', DiagnosticScope: 'Scope',
  TraceClass: 'Trace', TraceEnum: 'RecoveredStallTrace', Clock: 'RecoveredStallClock', Eligibility: 'RecoveredStallEligibility',
})) source = source.replace(new RegExp(`\\bEverframe${generated}\\b`, 'g'), `Everframe${stable}`);
const formatPattern = /public enum EverframeFormat: String, Codable \{[\s\S]*?\n\}/u;
if (!formatPattern.test(source)) {
  throw new Error('codegen-swift: EverframeFormat block shape changed');
}
source = source.replace(formatPattern, `public enum EverframeFormat: String, Codable {
    case everframeVideoV1 = "everframe-video-v1"
    case everframeVtreeV1 = "everframe-vtree-v1"
    case rrweb = "rrweb"
    case legacyVideoV1 = "traceitx-video-v1"
    case legacyVtreeV1 = "traceitx-vtree-v1"

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let value = EverframeFormat(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unknown Everframe replay format '\\(raw)'"
            )
        }
        self = value
    }

    public func encode(to encoder: Encoder) throws {
        let encoded: String
        switch self {
        case .legacyVideoV1: encoded = "everframe-video-v1"
        case .legacyVtreeV1: encoded = "everframe-vtree-v1"
        default: encoded = rawValue
        }
        var container = encoder.singleValueContainer()
        try container.encode(encoded)
    }
}`);
writeFileSync(path, source);
NODE

# Prepend the AUTOGENERATED header marker so CI drift detection and humans
# both see provenance at the top of the file.
# REUSE-IgnoreStart
HEADER=$'// SPDX-License-Identifier: MIT\n// SPDX-FileCopyrightText: 2026 ScriptX\n// AUTOGENERATED by packages/protocol/scripts/codegen-swift.sh \xe2\x80\x94 DO NOT EDIT.\n// To regenerate: pnpm -w codegen\n// CI gate: pnpm -w codegen && git diff --exit-code packages/sdk-ios/Sources/EverframeProtocol/\n\n'
# REUSE-IgnoreEnd
BODY="$(cat "$OUT_PATH")"
printf '%s%s\n' "$HEADER" "$BODY" > "$OUT_PATH"
