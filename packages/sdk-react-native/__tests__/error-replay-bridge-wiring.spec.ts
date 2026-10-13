// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays on errors (spec 2026-10-11). The bridge tests run only in an Xcode host or Gradle, so this file pins the
// source: which native entry point each JavaScript error takes. An error the app survives asks the native side for a
// replay; a fatal one never does. The native side still decides whether the session qualifies, whether a bug report
// owns the buffer, and the per-session cap.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ANDROID = 'android/src/main/java/dev/everframe/rn/EverframeModule.kt';
const SWIFT = 'ios/Sources/EverframeBridge.swift';
const OBJC = 'ios/Sources/EverframeModule.mm';

/** One Swift function, from its signature to the closing brace at the class's indentation. */
function swiftFunction(swift: string, signature: string): string {
  const start = swift.indexOf(signature);
  expect(start, `${signature} is missing`).toBeGreaterThan(-1);
  const end = swift.indexOf('\n    }\n', start);
  expect(end, `${signature} has no closing brace`).toBeGreaterThan(start);
  return swift.slice(start, end);
}

describe('Android bridge: which core entry point a JavaScript error takes', () => {
  const kotlin = source(ANDROID);
  const start = kotlin.indexOf('val accepted = when {');
  const end = kotlin.indexOf('// Scheduling is best-effort after acceptance');
  const [, handled = '', fatal = '', otherwise = ''] = kotlin
    .slice(start, end)
    .split(/\n\s+(?:handled|fatal|else) ->/);

  it('selects the entry point with one when over handled, then fatal, then everything else', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect([handled, fatal, otherwise].every((branch) => branch.length > 0)).toBe(true);
  });
  it('hands an explicit capture to the entry point that may attach a replay', () => {
    expect(handled).toContain('CrashReporter.captureHandledFactsWithReplay(');
    expect(handled).toContain('"everframe-android"');
  });
  it('keeps a fatal error on the entry point that never takes a replay', () => {
    expect(fatal).toContain('CrashReporter.captureFactsAcceptedWithCauses(');
    expect(fatal).not.toContain('WithReplay');
  });
  it('hands every other automatic error, such as a non-fatal error or a rejection, to the replay entry point', () => {
    expect(otherwise).toContain('CrashReporter.captureFactsAcceptedWithReplay(');
    expect(otherwise).not.toContain('captureFactsAcceptedWithCauses');
  });
  it('decides on the parsed fatal flag, with an explicit capture never fatal', () => {
    expect(kotlin).toContain('val fatal = !handled && obj.optBoolean("fatal", false)');
  });
  it('no longer calls the handled entry point without a replay, and still drains a survivable error at once', () => {
    expect(kotlin).not.toContain('captureHandledFactsWithCauses');
    expect(kotlin).toContain('if (accepted && !fatal) runCatching { __drainRequester() }');
  });
});

describe('iOS bridge: which attachReplay value a JavaScript error passes', () => {
  const swift = source(SWIFT);
  const reportCrash = swiftFunction(swift, '@objc public static func reportCrash(');
  const captureHandled = swiftFunction(swift, '@objc public static func captureHandledException(');

  it('asks for a replay on an explicit capture', () => {
    expect(captureHandled).toContain(
      'CrashReporter.captureHandledFacts(json: crashJson as String, sdkName: "everframe-react-native", attachReplay: true)',
    );
  });
  it('asks for a replay on an automatic error only after the facts are read as an error the app survives', () => {
    // The fatal branch comes first and says false; the survivable call after the guard says true.
    expect(reportCrash).toMatch(
      /guard appSurvivesError\(facts\) else \{\s*return CrashReporter\.captureFacts\([^)]*attachReplay: false\)\s*\}\s*return CrashReporter\.captureFacts\([^)]*attachReplay: true\)/,
    );
  });
  it('reads the fatal flag as a JSON boolean, treating anything unreadable as fatal', () => {
    const helper = swiftFunction(swift, 'static func appSurvivesError(');
    expect(helper).toContain('JSONSerialization.jsonObject(with: data)');
    expect(helper).toContain('else { return false }');
    expect(helper).toContain('guard let flag = object["fatal"] else { return true }');
    expect(helper).toContain('CFGetTypeID(boolean) == CFBooleanGetTypeID()');
    expect(helper).toContain('return !boolean.boolValue');
  });
  it('passes attachReplay explicitly on all three native calls: true for the two survivable ones, false for the fatal one', () => {
    const calls = [...swift.matchAll(/CrashReporter\.capture(?:Handled)?Facts\(([^)]*)\)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(calls).toHaveLength(3);
    for (const args of calls) expect(args).toMatch(/attachReplay: (?:true|false)/);
    expect(calls.filter((args) => args.includes('attachReplay: false'))).toHaveLength(1);
    expect(calls.filter((args) => args.includes('attachReplay: true'))).toHaveLength(2);
  });
  it('leaves the Objective-C++ module forwarding the JSON string and choosing nothing', () => {
    const objc = source(OBJC);
    expect(objc).toContain('[EverframeBridge reportCrash:(crashJson ?: @"")]');
    expect(objc).toContain('[EverframeBridge captureHandledException:(crashJson ?: @"")]');
    expect(objc).not.toContain('attachReplay');
  });
});
