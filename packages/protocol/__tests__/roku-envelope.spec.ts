// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ReportEnvelope } from '../src/index.js';
import roku from './fixtures/roku-crash-envelope.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AjvCtor = (Ajv as unknown as { default: typeof Ajv }).default ?? Ajv;
const addFormatsFn = (addFormats as unknown as { default: typeof addFormats }).default ?? addFormats;

describe('Roku envelope', () => {
  it('parses with the zod schema', () => {
    const r = ReportEnvelope.safeParse(roku);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('validates against the generated JSON schema', () => {
    const schema = JSON.parse(readFileSync(path.resolve(__dirname, '../schemas-json/envelope.v1.schema.json'), 'utf8'));
    const ajv = new AjvCtor({ strict: false, allErrors: true });
    addFormatsFn(ajv);
    const validate = ajv.compile(schema);
    expect(validate(roku), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects an unknown sdk name', () => {
    const bad = { ...roku, sdk: { ...roku.sdk, name: 'everframe-brightscript' } };
    expect(ReportEnvelope.safeParse(bad).success).toBe(false);
  });
});
