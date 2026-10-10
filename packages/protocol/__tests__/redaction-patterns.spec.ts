// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The shared JWT rule that the Android and iOS engines load: real tokens only, never dotted names.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const shared = read('../data/redaction-patterns.json');
const jwtRule = shared.patterns.find((p: { id: string }) => p.id === 'jwt');
const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('shared JWT redaction pattern', () => {
  const apply = (value: string) => value.replace(new RegExp(jwtRule.regex, 'g'), jwtRule.replacement);
  it('redacts a real token', () => {
    expect(apply(`token ${jwt}`)).toBe('token [REDACTED:JWT]');
  });
  it.each([
    'dev.everframe.crashdefault.MainActivity.onCreate',
    'kotlinx.coroutines.internal.DispatchedContinuation',
    'androidx.recyclerview.widget.RecyclerView',
    'com.example.survey.SurveyJobScheduler.schedule.invokeSuspend',
  ])('keeps %s', (name) => {
    expect(apply(name)).toBe(name);
  });
  it.each([
    '../../sdk-android/android/everframe-core/src/main/assets/everframe/redaction-patterns.json',
    '../../sdk-ios/Sources/Everframe/Resources/redaction-patterns.json',
  ])('ships the same rules in %s', (copy) => {
    expect(read(copy)).toEqual(shared);
  });
});
