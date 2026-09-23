// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Guards the physical copies of each cross-SDK-parity fixture against
// drift. Runs in `pnpm --filter @everframe/protocol test`, which the main
// ci.yml protocol lane executes on every PR — so a PR editing any copy
// without syncing the others fails there. (The swift/android codegen-drift
// jobs don't run this suite; ci.yml is the guard.)
//
// To register a new fixture here: add one entry to `groups` below with the
// canonical path (under this dir's `fixtures/`) and its sibling copies under
// the iOS Tests/Fixtures and Android traceitx-protocol/src/test/resources
// dirs. Each entry gets its own `it()` so a failure names the offending
// fixture.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const groups = [
  {
    name: 'crash-causes.json',
    canonical: `${HERE}/fixtures/crash-causes.json`,
    siblings: [
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/crash-causes.json`,
      `${HERE}/../../sdk-android/android/traceitx-protocol/src/test/resources/crash-causes.json`,
    ],
  },
  {
    name: 'jvm-crash-envelope.json',
    canonical: `${HERE}/fixtures/jvm-crash-envelope.json`,
    siblings: [
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/jvm-crash-envelope.json`,
      `${HERE}/../../sdk-android/android/traceitx-protocol/src/test/resources/jvm-crash-envelope.json`,
    ],
  },
  {
    name: 'crash-report-hermes.json',
    canonical: `${HERE}/fixtures/crash-report-hermes.json`,
    siblings: [
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/crash-report-hermes.json`,
      `${HERE}/../../sdk-android/android/traceitx-protocol/src/test/resources/crash-report-hermes.json`,
    ],
  },
  {
    name: 'v1-cross-sdk-proto-02.json',
    canonical: `${HERE}/fixtures/v1-cross-sdk-proto-02.json`,
    siblings: [
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/v1-cross-sdk-proto-02.json`,
      `${HERE}/../../sdk-android/android/traceitx-protocol/src/test/resources/v1-cross-sdk-proto-02.json`,
    ],
  },
  {
    // Task 14 — crash/error-reporting cross-SDK parity (spec 2026-07-18).
    // Decoded by crash.spec.ts (TS), CrashReportCrossSDKTest (Kotlin), and
    // CrashReportCrossSDKTests (Swift).
    name: 'crash-report.json',
    canonical: `${HERE}/fixtures/crash-report.json`,
    siblings: [
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/crash-report.json`,
      `${HERE}/../../sdk-android/android/traceitx-protocol/src/test/resources/crash-report.json`,
    ],
  },
  {
    // Network request/response body parity (spec 2026-08-01). Decoded by
    // network-body.spec.ts (TS), NetworkBodyEnvelopeTest (Kotlin), and
    // NetworkBodyEnvelopeTests (Swift). Note the Android copy lives under
    // traceitx-core (not traceitx-protocol) — that's where its consumer is.
    name: 'network-bodies.v1.json',
    canonical: `${HERE}/fixtures/network-bodies.v1.json`,
    siblings: [
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/network-bodies.v1.json`,
      `${HERE}/../../sdk-android/android/traceitx-core/src/test/resources/network-bodies.v1.json`,
    ],
  },
  {
    // Native identity Task 9 — the cross-boundary contract (spec
    // 2026-08-13). Generated (not hand-edited) by
    // packages/identity/scripts/generate-native-fixture.mjs. Decoded by
    // identity-native-fixture.spec.ts (TS, against the REAL verifier),
    // IdentityFixtureTest (Kotlin), and IdentityFixtureTests (Swift). The
    // Android copy lives under traceitx-core (not traceitx-protocol) — that's
    // where IdentityTokenHolder.kt, its consumer, lives.
    name: 'identity-token-native.v1.json',
    canonical: `${HERE}/fixtures/identity-token-native.v1.json`,
    siblings: [
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/identity-token-native.v1.json`,
      `${HERE}/../../sdk-android/android/traceitx-core/src/test/resources/identity-token-native.v1.json`,
    ],
  },
  {
    // MAI meter Plan 2b-i — the install-identifier derivation vector (spec
    // 2026-08-27, Counting architecture as amended 2026-08-28). Replayed by
    // install-id-parity.spec.ts (TS), InstallIdentifierTests (Swift), and
    // InstallIdentifierTest (Kotlin). The Android copy lives under
    // traceitx-core (not traceitx-protocol) — that's where InstallIdentifier
    // .kt, its consumer, lives, matching network-bodies.v1.json above.
    name: 'install-id.v1.json',
    canonical: `${HERE}/fixtures/install-id.v1.json`,
    siblings: [
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/install-id.v1.json`,
      `${HERE}/../../sdk-android/android/traceitx-core/src/test/resources/install-id.v1.json`,
    ],
  },
  {
    // Android session vitals (spec 2026-09-05). Decoded by
    // vitals-android-fixture.spec.ts (TS) and VitalsFixtureParityTest (Kotlin,
    // under traceitx-core — that's where the wire types live).
    name: 'vitals-android.v1.json',
    canonical: `${HERE}/fixtures/vitals-android.v1.json`,
    siblings: [
      `${HERE}/../../sdk-android/android/traceitx-core/src/test/resources/vitals-android.v1.json`,
    ],
  },
  {
    // iOS session vitals (spec 2026-09-05, iOS). Decoded by
    // vitals-ios-fixture.spec.ts (TS) and VitalsFixtureParityTests (Swift).
    name: 'vitals-ios.v1.json',
    canonical: `${HERE}/fixtures/vitals-ios.v1.json`,
    siblings: [`${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/vitals-ios.v1.json`],
  },
  {
    // RN vitals bridge parity (spec 2026-09-06 §5): drives RemotePlayerIntegration
    // on BOTH natives with the same call script (RemotePlayerFixtureParityTest /
    // RemotePlayerFixtureParityTests).
    name: 'vitals-rn-bridge.v1.json',
    canonical: `${HERE}/fixtures/vitals-rn-bridge.v1.json`,
    siblings: [
      `${HERE}/../../sdk-android/android/traceitx-core/src/test/resources/vitals-rn-bridge.v1.json`,
      `${HERE}/../../sdk-ios/Tests/TraceItXTests/Fixtures/vitals-rn-bridge.v1.json`,
    ],
  },
];

describe('cross-SDK envelope fixture copies', () => {
  for (const { name, canonical, siblings } of groups) {
    it(`all physical copies of ${name} are byte-identical`, () => {
      const want = readFileSync(canonical, 'utf8');
      for (const p of siblings) expect(readFileSync(p, 'utf8'), p).toBe(want);
    });
  }
});
