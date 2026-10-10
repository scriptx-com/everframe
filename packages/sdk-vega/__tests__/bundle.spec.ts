// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { captureKey, jsBundleFor, probeBundleId, stripBuildPath, vegaFingerprint } from '../src/bundle.js';
import { JsBundleMetadata } from '@everframe/protocol';
import { BUILD_DIR, BUNDLE_ID, vegaStack } from './fakes.js';

const OTHER_ID = 'a'.repeat(64);

describe('bundle identity', () => {
  it('reads the 64-hex bundle id from a release stack', () => {
    expect(probeBundleId(vegaStack('Error: probe'))).toBe(BUNDLE_ID);
  });

  it('finds no id in a Debug stack served by Metro', () => {
    expect(probeBundleId('Error: probe\n    at probe (http://localhost:8081/index.bundle//&platform=kepler&dev=true:120:5)')).toBeUndefined();
    expect(probeBundleId(undefined)).toBeUndefined();
  });

  it('describes the bundle with the protocol shape', () => {
    expect(JsBundleMetadata.parse(jsBundleFor(BUNDLE_ID))).toEqual({
      engine: 'hermes', platform: 'vega', buildId: BUNDLE_ID, bundleName: `${BUNDLE_ID}.bundle`,
    });
  });
});

describe('stripBuildPath', () => {
  it.each([
    [`at onPress (${BUILD_DIR}/${BUNDLE_ID}.bundle:41237:24)`, `at onPress (${BUNDLE_ID}.bundle:41237:24)`],
    [`at onPress (file://${BUILD_DIR}/${BUNDLE_ID}.bundle:1:2)`, `at onPress (${BUNDLE_ID}.bundle:1:2)`],
    [`at /Users/Jane Doe/app/build/${BUNDLE_ID}.bundle:3:4`, `at ${BUNDLE_ID}.bundle:3:4`],
    [`at onPress (/Users/Jane Doe/app/${BUNDLE_ID}.bundle:3:4)`, `at onPress (${BUNDLE_ID}.bundle:3:4)`],
  ])('drops the build directory: %s', (raw, expected) => {
    expect(stripBuildPath(raw)).toBe(expected);
  });

  it.each([
    `at onPress (${BUNDLE_ID}.bundle:41237:24)`,
    `at onPress (address at ${BUILD_DIR}/${BUNDLE_ID}.bundle:1:9012)`,
    'at callTimer (node_modules/@amzn/react-native-kepler/Libraries/Core/Timers/JSTimers.js:248:14)',
    'at fn (/Users/dev/app/other.js:1:2)',
    'at render (native)',
  ])('leaves other frames unchanged: %s', (raw) => {
    expect(stripBuildPath(raw)).toBe(raw);
  });
});

describe('grouping keys', () => {
  const frames = (id: string, line: number) => [
    { raw: `at onPress (${id}.bundle:${line}:24)` },
    { raw: `at anonymous (${id}.bundle:${line + 13}:9)` },
  ];

  it('groups one error across two builds', () => {
    expect(vegaFingerprint('Error', frames(BUNDLE_ID, 41237), 'boom')).toBe(vegaFingerprint('Error', frames(OTHER_ID, 50001), 'boom'));
    expect(captureKey('Error', [frames(BUNDLE_ID, 1)[0]!.raw], 'boom')).toBe(captureKey('Error', [frames(OTHER_ID, 2)[0]!.raw], 'boom'));
  });

  it('separates different functions and types', () => {
    const other = [{ raw: `at onSelect (${BUNDLE_ID}.bundle:41237:24)` }];
    expect(vegaFingerprint('Error', frames(BUNDLE_ID, 1), 'boom')).not.toBe(vegaFingerprint('Error', other, 'boom'));
    expect(vegaFingerprint('TypeError', frames(BUNDLE_ID, 1), 'boom')).not.toBe(vegaFingerprint('Error', frames(BUNDLE_ID, 1), 'boom'));
    expect(vegaFingerprint('Error', [], 'boom')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the message out of the key when the top frame names a function', () => {
    expect(vegaFingerprint('Error', frames(BUNDLE_ID, 1), 'asset A-1 failed')).toBe(vegaFingerprint('Error', frames(BUNDLE_ID, 1), 'asset B-2 failed'));
    expect(captureKey('Error', [frames(BUNDLE_ID, 1)[0]!.raw], 'one')).toBe(captureKey('Error', [frames(BUNDLE_ID, 1)[0]!.raw], 'two'));
  });

  // Seen on the Vega Virtual Device: a rejection and a fatal, each thrown in a
  // timer callback, both had the single frame `at anonymous (<id>.bundle:L:C)`.
  it('tells apart two errors thrown in anonymous callbacks', () => {
    const rejection = [{ raw: `at anonymous (${BUNDLE_ID}.bundle:11213:37)` }];
    const fatal = [{ raw: `at anonymous (${BUNDLE_ID}.bundle:11228:28)` }];
    expect(vegaFingerprint('Error', rejection, 'acceptance unhandled rejection'))
      .not.toBe(vegaFingerprint('Error', fatal, 'acceptance fatal timer error'));
    expect(captureKey('Error', [rejection[0]!.raw], 'acceptance unhandled rejection'))
      .not.toBe(captureKey('Error', [fatal[0]!.raw], 'acceptance fatal timer error'));
    // Still one group across builds and across digits in the message.
    expect(vegaFingerprint('Error', [{ raw: `at anonymous (${OTHER_ID}.bundle:9:1)` }], 'load 7 failed'))
      .toBe(vegaFingerprint('Error', [{ raw: `at anonymous (${BUNDLE_ID}.bundle:11:2)` }], 'load 8 failed'));
    for (const top of [`at global (${BUNDLE_ID}.bundle:1:1)`, `at ${BUNDLE_ID}.bundle:1:1`]) {
      expect(vegaFingerprint('Error', [{ raw: top }], 'a')).not.toBe(vegaFingerprint('Error', [{ raw: top }], 'b'));
    }
  });
});
