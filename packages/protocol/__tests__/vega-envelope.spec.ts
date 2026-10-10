// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ReportEnvelope, JsBundleMetadata } from '../src/index.js';
import vega from './fixtures/vega-crash-envelope.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AjvCtor = (Ajv as unknown as { default: typeof Ajv }).default ?? Ajv;
const addFormatsFn = (addFormats as unknown as { default: typeof addFormats }).default ?? addFormats;

describe('Vega OS envelope', () => {
  const schema = JSON.parse(readFileSync(path.resolve(__dirname, '../schemas-json/envelope.v1.schema.json'), 'utf8'));
  const ajv = new AjvCtor({ strict: false, allErrors: true });
  addFormatsFn(ajv);
  const validate = ajv.compile(schema);

  it('parses with the zod schema', () => {
    const r = ReportEnvelope.safeParse(vega);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('validates against the generated JSON schema', () => {
    expect(validate(vega), JSON.stringify(validate.errors)).toBe(true);
  });

  it('carries a vega Hermes bundle identity', () => {
    expect(JsBundleMetadata.parse(vega.payload.crash.jsBundle).platform).toBe('vega');
  });

  it('rejects an unknown sdk name and the kepler platform spelling in both validators', () => {
    for (const bad of [
      { ...vega, sdk: { ...vega.sdk, name: 'everframe-kepler' } },
      { ...vega, sdk: { ...vega.sdk, platform: 'kepler' } },
      {
        ...vega,
        payload: { ...vega.payload, crash: { ...vega.payload.crash, jsBundle: { ...vega.payload.crash.jsBundle, platform: 'kepler' } } },
      },
    ]) {
      expect(ReportEnvelope.safeParse(bad).success).toBe(false);
      expect(validate(bad)).toBe(false);
    }
  });
});
