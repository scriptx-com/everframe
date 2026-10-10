// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Builds the shared JWT redaction corpus (fixtures/jwt-redaction-corpus.v1.json): named cases
// with hand-written expectations, then seeded random near-tokens whose expectation is the
// reference implementation's output. The Kotlin and Swift scanners read the same file.
import { Buffer } from 'node:buffer';
import { referenceRedactJwt } from './jwt-reference.js';

export interface JwtCorpusCase { name: string; input: string; expected: string }
export interface JwtCorpus { version: 1; replacement: string; cases: JwtCorpusCase[] }

const R = '[REDACTED:JWT]';
export const b64 = (text: string) => Buffer.from(text, 'latin1').toString('base64url');
const sig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const claims = b64('{"sub":"1234567890","name":"John"}');
export const headers = {
  compact: b64('{"alg":"HS256","typ":"JWT"}'),
  spaced: b64('{ "alg": "HS256" }'),
  leadingSpace: b64(' {"alg":"HS256"}'),
  leadingNewline: b64('\n{"alg":"HS256"}'),
  crlf: b64('{\r\n"alg":"HS256"}'),
  none: b64('{"alg":"none"}'),
  dir: b64('{"alg":"dir","enc":"A256GCM"}'),
  rsa: b64('{"alg":"RSA-OAEP","enc":"A256GCM"}'),
};
const jws = (header: string, payload = claims, signature = sig) => `${header}.${payload}.${signature}`;
// "alg" after the first 768 decoded bytes: a long key ID, and a certificate chain (x5c) of several KB.
const longKid = b64(JSON.stringify({ kid: 'k'.repeat(800), alg: 'HS256' }));
const certificate = b64('certificate-der-'.repeat(70)).replace(/[-_]/g, 'A');
const x5c = b64(JSON.stringify({ typ: 'JWT', x5c: [certificate, certificate, certificate], alg: 'RS256' }));
const noAlg = b64(JSON.stringify({ kid: 'k'.repeat(900) }));
const dirJwe = `${headers.dir}..48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4.XFBoMYUZodetZdvTiFvSkQ`;
const rsaJwe = `${headers.rsa}.OKOawDo13gRp2ojaHV7LFpZcgV7T6DVZKTyKOMTYUmKoTCVJRgckCL9kiMT03JGeipsEdY3mx_etLbbWSrFr05kLzc.48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4.XFBoMYUZodetZdvTiFvSkQ`;

const named: Array<[string, string, string]> = [
  // Headers, with and without whitespace before and inside the object.
  ['header {"alg"', `token ${jws(headers.compact)}`, `token ${R}`],
  ['header { "alg"', `token ${jws(headers.spaced)}`, `token ${R}`],
  ['header  {"alg" (leading space)', `token ${jws(headers.leadingSpace)}`, `token ${R}`],
  ['header \\n{"alg" (leading newline)', `token ${jws(headers.leadingNewline)}`, `token ${R}`],
  ['header {\\r\\n"alg"', `token ${jws(headers.crlf)}`, `token ${R}`],
  // Payloads and signatures.
  ['payload {} (e30)', `token ${jws(headers.compact, 'e30')}`, `token ${R}`],
  ['payload with leading whitespace', `token ${jws(headers.compact, b64(' {"sub":"1"}'))}`, `token ${R}`],
  ['unsecured token with an empty signature', `token ${jws(headers.none, claims, '')} next`, `token ${R} next`],
  // Glued to the text before it: only the token is replaced.
  ['glued after x_', `x_${jws(headers.compact)}`, `x_${R}`],
  ['glued after token', `token${jws(headers.compact)}`, `token${R}`],
  ['glued after %3D', `id_token%3D${jws(headers.compact)}&x=1`, `id_token%3D${R}&x=1`],
  ['glued after =', `id_token=${jws(headers.compact)}&x=1`, `id_token=${R}&x=1`],
  ['glued after a literal \\n in JSON', `{"log":"auth\\n${jws(headers.compact)}"}`, `{"log":"auth\\n${R}"}`],
  ['glued after %3D, payload {}', `token%3D${jws(headers.compact, 'e30')}`, `token%3D${R}`],
  ['glued after \\n, payload {}', `{"log":"auth\\n${jws(headers.compact, 'e30')}"}`, `{"log":"auth\\n${R}"}`],
  ['glued after %3D, payload with leading whitespace', `token%3D${jws(headers.compact, b64(' {"sub":"1"}'))}`, `token%3D${R}`],
  ['glued after %3D, header with leading whitespace', `token%3D${jws(headers.leadingSpace)}`, `token%3D${R}`],
  ['glue of 64 characters', `${'g'.repeat(64)}${jws(headers.compact)}`, `${'g'.repeat(64)}${R}`],
  ['glue past 64 characters is not searched', `${'g'.repeat(65)}${jws(headers.compact)}`, `${'g'.repeat(65)}${jws(headers.compact)}`],
  // Long headers decode whole: "alg" can sit kilobytes in.
  ['"alg" after an 800-character kid', `token ${jws(longKid)}`, `token ${R}`],
  ['"alg" after an 800-character kid, glued after %3D', `token%3D${jws(longKid)}`, `token%3D${R}`],
  ['"alg" after a certificate chain (x5c) of several KB', `Bearer ${jws(x5c)}`, `Bearer ${R}`],
  ['a long JSON header without "alg"', `${jws(noAlg)}`, ''],
  // At most four starts of a run get a full decode; glue that passes the prefix check four times uses them up.
  // (A glue of whole 4-character groups keeps the header aligned, so the first start already verifies.)
  ['four prefix-passing starts before an unaligned header', `${'eyJi'.repeat(4)}x${jws(headers.compact)}`, ''],
  ['three prefix-passing starts before an unaligned header', `${'eyJi'.repeat(3)}x${jws(headers.compact)}`, `${'eyJi'.repeat(3)}x${R}`],
  ['aligned glue that opens JSON objects', `${'eyJi'.repeat(4)}${jws(headers.compact)}`, R],
  // JWE: five segments, the second empty for dir.
  ['dir JWE', `jwe ${dirJwe}`, `jwe ${R}`],
  ['dir JWE glued after x_', `x_${dirJwe}`, `x_${R}`],
  ['dir JWE glued after %3D', `token%3D${dirJwe}`, `token%3D${R}`],
  ['RSA JWE', `jwe ${rsaJwe} end`, `jwe ${R} end`],
  ['RSA JWE glued after %3D', `token%3D${rsaJwe}`, `token%3D${R}`],
  ['RSA JWE glued after session', `session${rsaJwe}`, `session${R}`],
  ['RSA JWE after =', `token=${rsaJwe}&next=1`, `token=${R}&next=1`],
  // Contexts.
  ['Bearer header', `Authorization: Bearer ${jws(headers.compact)}`, `Authorization: Bearer ${R}`],
  ['URL query', `https://auth.example.com/cb?id_token=${jws(headers.compact)}&state=abc`, `https://auth.example.com/cb?id_token=${R}&state=abc`],
  ['two tokens', `a ${jws(headers.compact)} b ${jws(headers.spaced, 'e30')} c`, `a ${R} b ${R} c`],
  // Kept: names, paths and versions that never decode to a JOSE header.
  ['Kotlin lambda frame', 'dev.everframe.crashdefault.ProofActivity$onCreate$2.run$lambda$0(SourceFile:5)', ''],
  ['ewokFactory', 'ewokFactory.createInstance.something', ''],
  ['SurveyJobScheduler frame', 'com.example.survey.SurveyJobScheduler.schedule.invokeSuspend(SurveyJobScheduler.kt:30)', ''],
  ['SurveyJobScheduler package path', 'com.example.SurveyJobScheduler.internal.coroutines.dispatcher.something', ''],
  ['com.example.app.extension', 'com.example.app.extension', ''],
  ['kotlinx DispatchedTask', 'kotlinx.coroutines.internal.DispatchedTask.run(DispatchedTask.kt:108)', ''],
  ['Swift module path', 'SurveyKit.SurveyJobScheduler.scheduleNextRun(_:)', ''],
  ['Swift mangled name', '$s9SurveyKit18SurveyJobSchedulerC8scheduleyyFTf4n_g', ''],
  ['ObjC selector', '-[SurveyJobScheduler scheduleWithCompletion:]', ''],
  ['bundle ID', 'com.example.surveyjobs.extension.widget', ''],
  ['short names that start like a header', 'ewok.something.else eyAudit.Foo.Bar', ''],
  ['version string', 'version 1.2.3.4567890', ''],
  ['build string', 'app-release-2026.10.10.1234567890', ''],
  ['base64 segments that are not JSON', 'QUJDREVGR0hJSktMTU5PUA.UVJTVFVWV1hZWg.YWJjZGVmZ2hpams', ''],
  ['a JSON header without "alg"', `${b64('{"foo":"bar"}')}.e30.${sig}`, ''],
  ['a JSON array header', `${b64('[{"alg":"HS256"}]')}.e30.${sig}`, ''],
  ['long base64 runs with dots', `${'Zm9vYmFy'.repeat(40)}.${'YmF6'.repeat(30)}.${'cXV4'.repeat(30)}`, ''],
];

function random(seed: number) {
  let state = seed >>> 0;
  return (n: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
}

export function buildJwtCorpus(): JwtCorpus {
  const cases: JwtCorpusCase[] = named.map(([name, input, expected]) => ({ name, input, expected: expected === '' ? input : expected }));
  const pick = random(0x2545f491);
  const glue = ['', 'x_', 'token', '%3D', '=', '\\n', ' ', 'Bearer ', 'id_token=', 'a.', '-', 'abc', 'é', '"'];
  const headerChoices = [...Object.values(headers), b64('{"foo":1}'), b64('hello world!'), b64('[1,2,3]'), '', 'eyJ', 'ewokFactory',
    'eyJieyJi', longKid, noAlg];
  const payloads = ['e30', claims, '', 'a', b64(' {"sub":"1"}'), 'OKOawDo13gRp2ojaHV7LF'];
  const thirds = ['', sig, 'x', '48V1_ALb6US04U3b'];
  const alphabet = 'aZ09_-eyJwAokIC.';
  const segment = () => { let text = ''; for (let k = pick(14); k > 0; k--) text += alphabet[pick(alphabet.length)]; return text; };
  for (let round = 0; round < 400; round++) {
    let input = '';
    for (let part = 1 + pick(3); part > 0; part--) {
      input += glue[pick(glue.length)];
      input += pick(4) === 0 ? segment() : headerChoices[pick(headerChoices.length)];
      input += `.${pick(3) === 0 ? segment() : payloads[pick(payloads.length)]}.${thirds[pick(thirds.length)]}`;
      if (pick(3) === 0) input += `.${segment()}.${pick(2) ? '5eym8TW_c8SuK0lt' : segment()}`;
      input += ['', ' ', '&x=1', '.tail', '"'][pick(5)];
    }
    if (pick(5) === 0) {
      const at = pick(input.length);
      input = input.slice(0, at) + '.- x'[pick(4)] + input.slice(at + 1);
    }
    cases.push({ name: `random ${round}`, input, expected: referenceRedactJwt(input, R) });
  }
  return { version: 1, replacement: R, cases };
}
