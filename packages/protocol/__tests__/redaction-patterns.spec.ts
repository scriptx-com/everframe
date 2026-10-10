// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The shared JWT rule: real JWS and JWE tokens, also glued to the text before them, and never a
// dotted class, package or module name. One string for every engine, applied in linear time.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JWT_PATTERN, JWT_REPLACEMENT, redactJwt } from '../src/redaction.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const shared = read('../data/redaction-patterns.json');
const jwtRule = shared.patterns.find((p: { id: string }) => p.id === 'jwt');
const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
// A `dir` JWE: the encrypted-key segment is empty (ECDH-ES leaves it empty too).
const dirJwe = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4vpzs9tX_EFShS8iB7j6jiSdiwkIr3ajwQzaBtQD_A.XFBoMYUZodetZdvTiFvSkQ';
const rsaJwe = 'eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.OKOawDo13gRp2ojaHV7LFpZcgV7T6DVZKTyKOMTYUmKoTCVJRgckCL9kiMT03JGeipsEdY3mx_etLbbWSrFr05kLzcSr4qKAq7YN7e9jwQRb23nfa6c9d-StnImGyFDbSv04uVuxIp5Zms1gNxKKK2Da14B8S4rzVRltdYwam_lDp5XnZAYpQdb76FdIKLaVmqgfwX7XWRxv2322i-vDxRfqNzo_tETKzpVLzfiwQyeyPGLBIO56YJ7eObdv0je81860ppamavo35UgoRdbYaBcoh9QcfylQr66oc6vFWXRcZ_ZT2LawVCWTIy3brGPi6UklfCpIMfIjf7iGdXKHzg.48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4vpzs9tX_EFShS8iB7j6jiSdiwkIr3ajwQzaBtQD_A.XFBoMYUZodetZdvTiFvSkQ';
const plain = (value: string) => value.replace(new RegExp(JWT_PATTERN, 'g'), JWT_REPLACEMENT);
const b64 = (text: string) => Buffer.from(text).toString('base64url');
const claims = b64('{"sub":"1234567890","name":"John"}');
const signature = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
// A header's `{` encodes to `e`, then `y` (`"`, space) or `w` (newline, tab, carriage return).
const spacedHeaders = {
  'eyA ({ )': b64('{ "alg": "HS256" }'),
  'ewo ({\\n)': b64('{\n  "alg": "HS256"\n}'),
  'ewk ({\\t)': b64('{\t"alg":"HS256"}'),
  'ew0 ({\\r)': b64('{\r\n"alg":"HS256"}'),
};

describe('shared JWT redaction pattern', () => {
  it('ships the same rule string in the data file and in redaction.ts', () => {
    expect(jwtRule.regex).toBe(JWT_PATTERN);
    expect(jwtRule.replacement).toBe(JWT_REPLACEMENT);
  });
  it.each([
    '../../sdk-android/android/everframe-core/src/main/assets/everframe/redaction-patterns.json',
    '../../sdk-ios/Sources/Everframe/Resources/redaction-patterns.json',
  ])('ships the same bytes in %s', (copy) => {
    expect(readFileSync(new URL(copy, import.meta.url), 'utf8'))
      .toBe(readFileSync(new URL('../data/redaction-patterns.json', import.meta.url), 'utf8'));
  });

  it.each([
    [`token ${jwt}`, 'token [REDACTED:JWT]'],
    [`Authorization failed for ${jwt}.`, 'Authorization failed for [REDACTED:JWT].'],
    // URL-encoded and glued: no word boundary before eyJ, so the second branch needs the eyJ payload.
    [`id_token%3D${jwt}&x=1`, 'id_token%3D[REDACTED:JWT]&x=1'],
    [`%22${jwt}%22`, '%22[REDACTED:JWT]%22'],
    [`Authorization: Bearer%20${jwt}`, 'Authorization: Bearer%20[REDACTED:JWT]'],
    [`x_${jwt}`, 'x_[REDACTED:JWT]'],
    [`_${jwt}`, '_[REDACTED:JWT]'],
    [String.raw`{"log":"session\n${jwt}"}`, String.raw`{"log":"session\n[REDACTED:JWT]"}`],
    [`jwe ${dirJwe}`, 'jwe [REDACTED:JWT]'],
    [`token=${dirJwe}&next=1`, 'token=[REDACTED:JWT]&next=1'],
    [`jwe ${rsaJwe} end`, 'jwe [REDACTED:JWT] end'],
  ])('redacts %s', (input, expected) => {
    expect(plain(input)).toBe(expected);
    expect(redactJwt(input)).toBe(expected);
  });

  it.each([
    'com.example.survey.SurveyJobScheduler.schedule.invokeSuspend(SurveyJobScheduler.kt:30)',
    'com.example.app.extension',
    'dev.everframe.crashdefault.MainActivity.onCreate',
    'dev.everframe.crashdefault.ProofActivity$onCreate$2.run$lambda$0(SourceFile:5)',
    'com.example.survey.SurveyJobScheduler$schedule$1.invokeSuspend$lambda$0(SurveyJobScheduler.kt:30)',
    'kotlinx.coroutines.internal.DispatchedContinuation.resumeWith(DispatchedContinuation.kt:42)',
    'androidx.recyclerview.widget.RecyclerView',
    'SurveyKit.SurveyJobScheduler.scheduleNextRun(_:)',
    'MyAppModule.CheckoutViewModel.submitOrder(_:) + 120',
    '-[SurveyJobScheduler scheduleWithCompletion:]',
    '+[EVFSurveyJobScheduler sharedScheduler]',
    '$s9SurveyKit0A15JobSchedulerC8schedule4withyAA0C0V_tF',
    '$s9SurveyKit18SurveyJobSchedulerC8scheduleyyFTf4n_g',
    'SurveyKit`specialized SurveyJobScheduler.schedule(with:) + 1184',
  ])('keeps %s', (name) => {
    expect(plain(name)).toBe(name);
    expect(redactJwt(name)).toBe(name);
  });

  it.each(Object.entries(spacedHeaders))('redacts a token whose JSON header has whitespace: %s', (_label, header) => {
    const token = `${header}.${claims}.${signature}`;
    for (const [input, expected] of [
      [`token ${token}`, 'token [REDACTED:JWT]'],
      [`id_token%3D${token}&x=1`, 'id_token%3D[REDACTED:JWT]&x=1'],
      [`x_${token}`, 'x_[REDACTED:JWT]'],
      [`x_${header}.${b64('{ "sub": "1" }')}.${signature}`, 'x_[REDACTED:JWT]'],
    ]) {
      expect(plain(input!), input).toBe(expected);
      expect(redactJwt(input!), input).toBe(expected);
    }
  });

  it.each([
    ['URL-encoded', `token%3D${rsaJwe}`, 'token%3D[REDACTED:JWT]'],
    ['after =', `token=${rsaJwe}&next=1`, 'token=[REDACTED:JWT]&next=1'],
    ['glued to text', `session${rsaJwe}`, 'session[REDACTED:JWT]'],
    ['glued after _', `x_${rsaJwe}`, 'x_[REDACTED:JWT]'],
    ['dir, URL-encoded', `token%3D${dirJwe}`, 'token%3D[REDACTED:JWT]'],
    ['dir, glued after _', `x_${dirJwe}`, 'x_[REDACTED:JWT]'],
    ['dir, spaced header, glued', `x_${b64('{ "alg": "dir", "enc": "A256GCM" }')}..48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4.XFBoMYUZodetZdvTiFvSkQ`, 'x_[REDACTED:JWT]'],
  ])('redacts a JWE with no word boundary before it: %s', (_label, input, expected) => {
    expect(plain(input)).toBe(expected);
    expect(redactJwt(input)).toBe(expected);
  });

  // Decided: a dotted name is kept unless it has a JWT's shape. A name that starts a word with one
  // of the five prefixes, has a first segment of at least 8 characters and two more segments, the
  // last of at least 8, is masked: that is the price of catching headers with whitespace, and such
  // names (a lowercase `e` then `yJ`, `yA`, `wo`, `wk` or `w0`) are rare.
  it.each([
    'ewok.something.else',
    'eyAudit.Foo.Bar',
    'ewok.village.TreehouseBuilder.build(Treehouse.kt:12)',
    'com.example.ewokFactory.create(EwokFactory.kt:7)',
    'eyAuditLogger.log(eyAuditLogger.kt:40)',
    'ew0rker.queue.dispatch',
    'com.example.SurveyJobScheduler.schedule.invokeSuspend(SurveyJobScheduler.kt:30)',
  ])('keeps the dotted name %s', (name) => {
    expect(plain(name)).toBe(name);
    expect(redactJwt(name)).toBe(name);
  });
  it.each([
    ['ewokFactory.createInstance.something', '[REDACTED:JWT]'],
    ['com.example.SurveyJobScheduler.internal.coroutines.dispatcher.something', 'com.example.Surv[REDACTED:JWT]'],
  ])('masks the token-shaped name %s (the accepted cost)', (name, expected) => {
    expect(plain(name)).toBe(expected);
    expect(redactJwt(name)).toBe(expected);
  });

  it('gives exactly the regex result on random token-shaped text', () => {
    // Near-tokens: segments of 0..12 characters, often starting with eyJ, joined by dots and
    // glued to boundary and non-boundary characters, so matches and misses both stay common.
    let seed = 0x2545f491;
    const random = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    const alphabet = 'aZ09_-eyJwAok';
    const glue = ['', ' ', '_', '-', 'x', '%3D', 'é', String.raw`\n`, '.', '=', '..'];
    const prefixes = ['eyJ', 'eyA', 'ewo', 'ewk', 'ew0'];
    const segment = () => {
      let text = random(2) === 0 ? prefixes[random(prefixes.length)]! : '';
      for (let k = random(13); k > 0; k--) text += alphabet[random(alphabet.length)];
      return text;
    };
    let redacted = 0;
    for (let round = 0; round < 20_000; round++) {
      let value = '';
      for (let part = 1 + random(3); part > 0; part--) {
        value += glue[random(glue.length)];
        const segments = [];
        for (let k = 1 + random(6); k > 0; k--) segments.push(segment());
        value += segments.join('.');
      }
      const expected = plain(value);
      expect(redactJwt(value), value).toBe(expected);
      if (expected !== value) redacted++;
    }
    // The corpus has to exercise matches, not only misses.
    expect(redacted).toBeGreaterThan(2_000);
  });

  it.each([
    ['eyJ- repeated', 'eyJ-'.repeat(262_144)],
    ['-eyJ repeated, then a dot', '-eyJ'.repeat(262_143) + '.abcdefgh'],
    ['headers that each fail at the signature', 'eyJabcde.eyJabcde.'.repeat(58_254)],
    ['glued headers', 'x'.repeat(8) + 'eyJ'.repeat(349_522)],
    ['spaced header prefixes', 'ewo-eyA-ewk-ew0-'.repeat(65_536)],
    ['glued JWE-like headers', 'xewoabcde..abcdefgh.abcdefgh.'.repeat(36_158)],
  ])('masks a megabyte of %s within budget', (_label, value) => {
    expect(value.length).toBeGreaterThanOrEqual(1_000_000);
    const started = performance.now();
    const out = redactJwt(value);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(out.length).toBeLessThanOrEqual(value.length);
  });

  it('masks every token in a megabyte of real tokens within budget', () => {
    const value = `${jwt} `.repeat(Math.ceil(1_048_576 / (jwt.length + 1)));
    const started = performance.now();
    const out = redactJwt(value);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(out).not.toContain('eyJ');
  });
});
