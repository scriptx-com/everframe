// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The JWT rule must match real tokens (base64url JSON header, so `eyJ`) and leave dotted
// class, package and module names alone: they are the stack frames a crash report is for.
import { describe, expect, it } from 'vitest';
import { redactStringContent } from '../src/redaction/engine.js';

const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const redact = (value: string) => redactStringContent(value, {});

describe('JWT redaction shape', () => {
  it.each([
    [`token ${jwt}`, 'token [REDACTED:JWT]'],
    [`Authorization failed for ${jwt}.`, 'Authorization failed for [REDACTED:JWT].'],
    [`url?id_token=${jwt}&x=1`, 'url?id_token=[REDACTED:JWT]&x=1'],
    [`"${jwt}"`, '"[REDACTED:JWT]"'],
  ])('redacts a real token in %s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });
  it.each([
    'dev.everframe.crashdefault.MainActivity$onCreate$2.run$lambda$0(SourceFile:5)',
    'kotlinx.coroutines.internal.DispatchedContinuation.resumeWith(DispatchedContinuation.kt:42)',
    'androidx.recyclerview.widget.RecyclerView.onLayout(RecyclerView.java:4577)',
    'MyAppModule.CheckoutViewModel.submitOrder(_:) + 120',
    'com.example.survey.SurveyJobScheduler.schedule.invokeSuspend(SurveyJobScheduler.kt:30)',
    'com.example.money.HoneyJarFactory.createInstance.something',
  ])('keeps the dotted name %s', (frame) => {
    expect(redact(frame)).toBe(frame);
  });
});
