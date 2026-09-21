// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-i — RN sends the install identifier by INHERITANCE: both
// bridges call the native `start()`, which resolves and threads the
// identifier (sdk-ios TraceItX.swift / sdk-android TraceItX.kt). There is no
// RN-side derivation to test, which is exactly why this gate exists: if a
// bridge ever stopped routing through native start() — building its own
// ReplaySession or ReplayConfigProvider instead — RN would silently stop
// being counted, and nothing else in this package would notice.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `fileURLToPath(import.meta.url)` (not `new URL('.', import.meta.url)`) per
// this package's existing convention (see rbridge-no-surface.test.ts,
// companion-bridge-wiring.spec.ts) — the alternate form's `URLSearchParams`
// iterator type doesn't satisfy this package's node:url typings.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('RN install-identifier inheritance', () => {
  it('the iOS bridge configures through the native start()', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'ios', 'Sources', 'TraceItXBridge.swift'),
      'utf8',
    );
    expect(src).toContain('TraceItX.shared.start(config:');
    expect(src).not.toContain('ReplayConfigProvider(');
    // A regressed bridge could build its own provider through the factory
    // (`ReplayConfigProvider.make(`, ReplayConfigProvider.swift:549) instead
    // of the direct initializer — that call contains no `ReplayConfigProvider(`
    // substring and would otherwise slip past the assertion above.
    expect(src).not.toContain('ReplayConfigProvider.make(');
    expect(src).not.toContain('ReplaySession(');
    // Source gate standing in for a behavioural test on iOS specifically: no
    // unit test in this package (or in sdk-react-native's own suites) can
    // reach the native `configure()` path there — `.github/workflows/
    // react-native.yml`'s ios job only `xcodebuild build`s the host, never
    // `test`s it, because the suites under `ios/Tests/` have never compiled
    // (see that job's own comment). So this pins the polarity flip as text.
    // It matters because the flip is a PRIVACY VETO: if a future edit turned
    // this into `cfg.installIdentifierEnabled = installIdentifierDisabled`
    // (dropping the `!`), a host that set `installIdentifier: { disabled:
    // true }` — an explicit opt-out — would end up with
    // `installIdentifierEnabled = true` and the SDK would keep sending the
    // identifier: the veto would fail OPEN. The regex requires the `!`
    // immediately before `installIdentifierDisabled` on the right-hand side,
    // so removing it (or swapping in the bare identifier) fails this
    // assertion, while tolerating incidental whitespace changes around `=`.
    expect(src).toMatch(/installIdentifierEnabled\s*=\s*!installIdentifierDisabled\b/);
  });

  it('the Android bridge configures through the native start()', () => {
    const src = readFileSync(
      path.join(
        __dirname,
        '..',
        'android',
        'src',
        'main',
        'java',
        'com',
        'traceitx',
        'rn',
        'TraceItXModule.kt',
      ),
      'utf8',
    );
    expect(src).toContain('TraceItX.start(');
    expect(src).not.toContain('ReplayConfigProvider(');
    // Same factory-form gap as the iOS case above: Kotlin's
    // `ReplayConfigProvider.make(` (ReplayConfigProvider.kt:882) contains no
    // `ReplayConfigProvider(` substring either.
    expect(src).not.toContain('ReplayConfigProvider.make(');
    expect(src).not.toContain('ReplaySession(');
    // Unlike the iOS case above, Android's `configure()` path IS reachable
    // from a unit test: `android/src/test/java/com/traceitx/rn/
    // TraceItXModuleConfigureTest.kt` (a Robolectric suite CI runs via
    // `./gradlew testDebugUnitTest`, react-native.yml) drives
    // `TraceItXModule.configure()` directly and asserts on
    // `TraceItX.currentConfig!!.installIdentifierEnabled` for both veto
    // directions plus the absent-flag default. That behavioural coverage is
    // the primary guard against the fail-OPEN risk this regex describes; the
    // regex below stays as a second, cheaper check — it pins the polarity of
    // the LOCAL assignment (`installIdentifierEnabled = !installIdentifierDisabled`)
    // but, being local-variable-to-local-variable, cannot see a drift in the
    // untyped wire key (`takeIfHasBoolean("installIdentifierDisabled")`)
    // upstream of it — only the behavioural test above can.
    expect(src).toMatch(/installIdentifierEnabled\s*=\s*!installIdentifierDisabled\b/);
  });
});
