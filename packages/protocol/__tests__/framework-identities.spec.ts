// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ReportEnvelope } from '../src/index.js';
import { baseEnvelope } from './helpers/base-envelope.js';

const schema = JSON.parse(readFileSync(
  fileURLToPath(new URL('../schemas-json/envelope.v1.schema.json', import.meta.url)),
  'utf8',
));
const AjvCtor = (Ajv as unknown as { default: typeof Ajv }).default ?? Ajv;
const addFormatsFn = (addFormats as unknown as { default: typeof addFormats }).default ?? addFormats;
const ajv = new AjvCtor({ strict: false, allErrors: true });
addFormatsFn(ajv);
const validate = ajv.compile(schema);

describe('Flutter and Kotlin Multiplatform host identity', () => {
  it.each([
    ['everframe-flutter', 'android'],
    ['everframe-flutter', 'ios'],
    ['everframe-flutter', 'web'],
    ['everframe-kmp', 'android'],
    ['everframe-kmp', 'ios'],
    ['everframe-kmp', 'web'],
  ] as const)('preserves %s on %s through an envelope round trip', (name, platform) => {
    const envelope = baseEnvelope();
    envelope.sdk = { name, platform, formFactor: 'phone', version: '0.0.0' };
    const parsed = ReportEnvelope.parse(envelope);
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);
    expect(ReportEnvelope.parse(JSON.parse(JSON.stringify(parsed))).sdk).toEqual(
      envelope.sdk,
    );
  });

  it.each([
    ['everframe-android', 'android'],
    ['everframe-ios', 'ios'],
    ['everframe-react-native', 'android'],
    ['everframe-react-native', 'ios'],
  ] as const)('keeps existing %s on %s valid', (name, platform) => {
    const envelope = baseEnvelope();
    envelope.sdk = { name, platform, formFactor: 'phone', version: '0.5.0' };
    expect(ReportEnvelope.parse(envelope).sdk).toEqual(envelope.sdk);
  });
});
