// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The JWT rule must match real tokens (base64url JSON header, so `eyJ`), also URL-encoded or
// glued to the text before them, and leave dotted class, package and module names alone: they
// are the stack frames a crash report is for. It must stay linear on hostile input.
import { describe, expect, it } from 'vitest';
import { redactStringContent } from '../src/redaction/engine.js';

const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const dirJwe = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4vpzs9tX_EFShS8iB7j6jiSdiwkIr3ajwQzaBtQD_A.XFBoMYUZodetZdvTiFvSkQ';
const redact = (value: string) => redactStringContent(value, {});
const b64 = (text: string) => Buffer.from(text).toString('base64url');
// A JSON header with whitespace encodes to eyA ({ ), ewo ({\n), ewk ({\t) or ew0 ({\r).
const spaced = [b64('{ "alg": "HS256" }'), b64('{\n  "alg": "HS256"\n}'), b64('{\t"alg":"HS256"}'), b64('{\r\n"alg":"HS256"}')]
  .map((header) => `${header}.${b64('{"sub":"1234567890"}')}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`);
const rsaJwe = 'eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.OKOawDo13gRp2ojaHV7LFpZcgV7T6DVZKTyKOMTYUmKoTCVJRgckCL9kiMT03JGeipsEdY3mx_etLbbWSrFr05kLzc.48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4.XFBoMYUZodetZdvTiFvSkQ';

describe('JWT redaction shape', () => {
  it.each([
    [`token ${jwt}`, 'token [REDACTED:JWT]'],
    [`Authorization failed for ${jwt}.`, 'Authorization failed for [REDACTED:JWT].'],
    [`url?id_token=${jwt}&x=1`, 'url?id_token=[REDACTED:JWT]&x=1'],
    [`"${jwt}"`, '"[REDACTED:JWT]"'],
    [`redirect?state%3D${jwt}`, 'redirect?state%3D[REDACTED:JWT]'],
    [`%22${jwt}%22`, '%22[REDACTED:JWT]%22'],
    [`Bearer%20${jwt}`, 'Bearer%20[REDACTED:JWT]'],
    [`session_${jwt}`, 'session_[REDACTED:JWT]'],
    [`_${jwt}`, '_[REDACTED:JWT]'],
    [String.raw`{"line":"auth\n${jwt}"}`, String.raw`{"line":"auth\n[REDACTED:JWT]"}`],
    [`jwe=${dirJwe}`, 'jwe=[REDACTED:JWT]'],
    ...spaced.flatMap((token) => [[`token ${token}`, 'token [REDACTED:JWT]'], [`id%3D${token}`, 'id%3D[REDACTED:JWT]']]),
    [`token%3D${rsaJwe}`, 'token%3D[REDACTED:JWT]'],
    [`session${rsaJwe}`, 'session[REDACTED:JWT]'],
    [`x_${dirJwe}`, 'x_[REDACTED:JWT]'],
  ])('redacts a real token in %s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });
  it.each([
    'dev.everframe.crashdefault.MainActivity$onCreate$2.run$lambda$0(SourceFile:5)',
    'kotlinx.coroutines.internal.DispatchedContinuation.resumeWith(DispatchedContinuation.kt:42)',
    'androidx.recyclerview.widget.RecyclerView.onLayout(RecyclerView.java:4577)',
    'MyAppModule.CheckoutViewModel.submitOrder(_:) + 120',
    'com.example.survey.SurveyJobScheduler.schedule.invokeSuspend(SurveyJobScheduler.kt:30)',
    'com.example.survey.SurveyJobScheduler$schedule$1.invokeSuspend$lambda$0(SurveyJobScheduler.kt:30)',
    'com.example.money.HoneyJarFactory.createInstance.something',
    'com.example.app.extension',
    'ewok.something.else',
    'eyAudit.Foo.Bar',
    'SurveyKit.SurveyJobScheduler.scheduleNextRun(_:)',
    '-[SurveyJobScheduler scheduleWithCompletion:]',
    '$s9SurveyKit18SurveyJobSchedulerC8scheduleyyFTf4n_g',
    'at SurveyJobScheduler.schedule (https://cdn.example.com/static/js/main.4f2a9c1e.chunk.js:1:2045)',
  ])('keeps the dotted name %s', (frame) => {
    expect(redact(frame)).toBe(frame);
  });
  it('redacts a megabyte of eyJ- in linear time', () => {
    const value = 'eyJ-'.repeat(262_144);
    const started = performance.now();
    expect(redact(value)).toBe(value);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
