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
// Additive optional evidence must not break existing source initializers.
source = source.replace(/diagnostic: EverframeDiagnosticEvidence\?,/g, 'diagnostic: EverframeDiagnosticEvidence? = nil,');
source = source.replace(/appleDiagnostic: EverframeAppleDiagnosticEvidence\?,/g, 'appleDiagnostic: EverframeAppleDiagnosticEvidence? = nil,');
source = source.replace(/nativeExposure: EverframeNativeExposure\?,/g, 'nativeExposure: EverframeNativeExposure? = nil,');
// Keep the old initializer/with symbols for separately compiled callers.
// A default argument on the new signature does not preserve the old symbol.
const evidencePattern = /(\/\/ MARK: - EverframeDiagnosticEvidence[\s\S]*?)(?=\/\/ MARK: - )/;
const evidenceMatch = source.match(evidencePattern);
if (!evidenceMatch) throw new Error('codegen-swift: DiagnosticEvidence block missing');
let evidence = evidenceMatch[1];
const initMatch = evidence.match(/public init\(([^\n]+)\) \{/);
const withMatch = evidence.match(/    func with\(\n([\s\S]*?)\n    \) -> EverframeDiagnosticEvidence \{/);
if (!initMatch || !withMatch) throw new Error('codegen-swift: DiagnosticEvidence signatures changed');
const initParameters = initMatch[1].split(', ');
const oldInit = initParameters.filter(parameter => !parameter.startsWith('nativeExposure:'));
const initArguments = initParameters.map(parameter => {
  const name = parameter.split(':')[0];
  return `${name}: ${name === 'nativeExposure' ? 'nil' : name}`;
});
const withParameters = withMatch[1].split('\n');
const oldWith = withParameters.filter(parameter => !parameter.trim().startsWith('nativeExposure:'));
const withArguments = withParameters.map(parameter => {
  const name = parameter.trim().split(':')[0];
  return `${name}: ${name === 'nativeExposure' ? '.some(self.nativeExposure)' : name}`;
});
evidence = evidence.replace('nativeExposure: EverframeNativeExposure? = nil,', 'nativeExposure: EverframeNativeExposure?,')
  .replace('nativeExposure: EverframeNativeExposure?? = nil,', 'nativeExposure: EverframeNativeExposure??,');
evidence += `public extension EverframeDiagnosticEvidence {
    init(${oldInit.join(', ')}) {
        self.init(${initArguments.join(', ')})
    }

    func with(
${oldWith.join('\n')}
    ) -> EverframeDiagnosticEvidence {
        return self.with(${withArguments.join(', ')})
    }
}

`;
source = source.replace(evidencePattern, evidence);
// Preserve the published native metadata initializer and with symbols.
const nativePattern = /(\/\/ MARK: - EverframeNativeCrashMetadata[\s\S]*?)(?=\/\/ MARK: - )/;
const nativeMatch = source.match(nativePattern);
if (!nativeMatch) throw new Error('codegen-swift: NativeCrashMetadata block missing');
let native = nativeMatch[1];
const nativeInit = native.match(/public init\(([^\n]+)\) \{/);
const nativeWith = native.match(/    func with\(\n([\s\S]*?)\n    \) -> EverframeNativeCrashMetadata \{/);
if (!nativeInit || !nativeWith) throw new Error('codegen-swift: NativeCrashMetadata signatures changed');
const nativeParams = nativeInit[1].split(', ');
const nativeOldInit = nativeParams.filter(p => !p.startsWith('releaseHealthEvidence:'));
const nativeInitArgs = nativeParams.map(p => {
  const name = p.split(':')[0]; return `${name}: ${name === 'releaseHealthEvidence' ? 'nil' : name}`;
});
const nativeWithParams = nativeWith[1].split('\n');
const nativeOldWith = nativeWithParams.filter(p => !p.trim().startsWith('releaseHealthEvidence:'));
const nativeWithArgs = nativeWithParams.map(p => {
  const name = p.trim().split(':')[0];
  return `${name}: ${name === 'releaseHealthEvidence' ? '.some(self.releaseHealthEvidence)' : name}`;
});
native = native.replace('releaseHealthEvidence: EverframeNativeCrashReleaseHealthEvidence?? = nil,',
  'releaseHealthEvidence: EverframeNativeCrashReleaseHealthEvidence??,');
native += `public extension EverframeNativeCrashMetadata {
    init(${nativeOldInit.join(', ')}) { self.init(${nativeInitArgs.join(', ')}) }
    func with(
${nativeOldWith.join('\n')}
    ) -> EverframeNativeCrashMetadata { return self.with(${nativeWithArgs.join(', ')}) }
}

`;
source = source.replace(nativePattern, native);
// Codable's synthesized optional encoder omits nil. The frozen pointer's
// nullable build field is required, so preserve its explicit JSON null.
const exposurePattern = /public struct EverframeNativeExposure: Codable \{[\s\S]*?\n\}/;
if (!exposurePattern.test(source)) throw new Error('codegen-swift: NativeExposure block missing');
source = source.replace(exposurePattern, block => block.slice(0, -1) + `
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(exposureID, forKey: .exposureID)
        try container.encode(loadedBuildID, forKey: .loadedBuildID)
        try container.encode(loadedBundleStatus, forKey: .loadedBundleStatus)
        try container.encode(nativeBuildID, forKey: .nativeBuildID)
        try container.encode(processLaunchID, forKey: .processLaunchID)
        try container.encode(startedAt, forKey: .startedAt)
    }
}`);
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
