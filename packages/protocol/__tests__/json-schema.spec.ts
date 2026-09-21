// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ReportEnvelope } from '../src/index.js';
import hermes from './fixtures/crash-report-hermes.json';
import jvmCrash from './fixtures/jvm-crash-envelope.json';
import minimal from './fixtures/v1-minimal.json';
import full from './fixtures/v1-full.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(
  __dirname,
  '../schemas-json/envelope.v1.schema.json'
);
const jsonSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

// ajv & ajv-formats publish dual ESM/CJS — under verbatimModuleSyntax we get
// the namespace; the constructor lives on `.default` for ajv and the plugin
// fn on `.default` for ajv-formats.
const AjvCtor = (Ajv as unknown as { default: typeof Ajv }).default ?? Ajv;
const addFormatsFn =
  (addFormats as unknown as { default: typeof addFormats }).default ??
  addFormats;

describe('SDK-04: generated JSON Schema', () => {
  it('is Draft 2020-12', () => {
    expect(jsonSchema.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema'
    );
  });

  it('validates v1-minimal fixture via ajv (independent validator)', () => {
    const ajv = new AjvCtor({ strict: false, allErrors: true });
    addFormatsFn(ajv);
    const validate = ajv.compile(jsonSchema);
    const ok = validate(minimal);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  it('validates v1-full fixture via ajv', () => {
    const ajv = new AjvCtor({ strict: false, allErrors: true });
    addFormatsFn(ajv);
    const validate = ajv.compile(jsonSchema);
    const ok = validate(full);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });
});

describe('Hermes build identity schema parity', () => {
  const ajv = new AjvCtor({ strict: false, allErrors: true });
  addFormatsFn(ajv);
  const validate = ajv.compile(jsonSchema);

  it.each([
    ['100 astral pairs', '😀'.repeat(100), true],
    ['101 astral pairs', '😀'.repeat(101), false],
    ['200 astral pairs', '😀'.repeat(200), false],
    ['200 BMP units', 'a'.repeat(200), true],
    ['201 BMP units', 'a'.repeat(201), false],
    ['mixed 200 units', 'a😀'.repeat(66) + 'xy', true],
    ['mixed 201 units', 'a😀'.repeat(67), false],
    ['odd BMP prefix within 200', 'a' + '😀'.repeat(99) + 'b', true],
    ['odd BMP prefix over 200', 'a' + '😀'.repeat(100), false],
    ['exact spaces preserved', ' release 7 ', true],
    ['blank', ' ', false],
    ['NUL', 'a\0b', false],
    ['lone surrogate', '\ud800', false],
  ] as const)('%s has the same explicit result in Ajv and Zod', (_name, buildId, accepted) => {
    const envelope = structuredClone(hermes);
    envelope.payload.crash.jsBundle.buildId = buildId;
    expect(ReportEnvelope.safeParse(envelope).success).toBe(accepted);
    expect(validate(envelope)).toBe(accepted);
  });
});

describe('JVM crash metadata schema parity', () => {
  const ajv = new AjvCtor({ strict: false, allErrors: true });
  addFormatsFn(ajv);
  const validate = ajv.compile(jsonSchema);

  it('accepts the shared JVM fixture in Ajv and Zod', () => {
    expect(ReportEnvelope.safeParse(jvmCrash).success).toBe(true);
    expect(validate(jvmCrash)).toBe(true);
  });

  it.each([
    ['valid 1-character mapping ID', 'a', true],
    ['valid 128-character mapping ID', `a${'b'.repeat(127)}`, true],
    ['empty mapping ID', '', false],
    ['invalid initial character', '-release', false],
    ['invalid slash', 'invalid/id', false],
    ['trailing newline', 'release\n', false],
    ['trailing carriage return', 'release\r', false],
    ['129-character mapping ID', `a${'b'.repeat(128)}`, false],
  ] as const)('%s has the same result in Ajv and Zod', (_name, mappingId, accepted) => {
    const envelope = structuredClone(jvmCrash);
    envelope.payload.crash.jvm.mappingId = mappingId;
    expect(ReportEnvelope.safeParse(envelope).success).toBe(accepted);
    expect(validate(envelope)).toBe(accepted);
  });

  it('rejects malformed required flags and bounded arrays in Ajv and Zod', () => {
    const malformed = [
      (() => {
        const envelope = structuredClone(jvmCrash) as any;
        delete envelope.payload.crash.jvm.causesTruncated;
        return envelope;
      })(),
      (() => {
        const envelope = structuredClone(jvmCrash) as any;
        delete envelope.payload.crash.jvm.causes[0].framesTruncated;
        return envelope;
      })(),
      (() => {
        const envelope = structuredClone(jvmCrash) as any;
        envelope.payload.crash.jvm.causes = Array.from({ length: 9 }, () => envelope.payload.crash.jvm.causes[0]);
        return envelope;
      })(),
      (() => {
        const envelope = structuredClone(jvmCrash) as any;
        envelope.payload.crash.jvm.causes[0].frames = Array.from({ length: 33 }, () => ({ raw: 'at x' }));
        return envelope;
      })(),
    ];
    for (const envelope of malformed) {
      expect(ReportEnvelope.safeParse(envelope).success).toBe(false);
      expect(validate(envelope)).toBe(false);
    }
  });

  it.each([
    ['exact ASCII cause text limits', 256, 4096, true],
    ['overlong exception type', 257, 4096, false],
    ['overlong cause message', 256, 4097, false],
  ] as const)('%s has the same result in Ajv and Zod', (_name, typeLength, messageLength, accepted) => {
    const envelope = structuredClone(jvmCrash);
    const firstCause = envelope.payload.crash.jvm.causes[0]!;
    firstCause.exceptionType = 'x'.repeat(typeLength);
    firstCause.message = 'x'.repeat(messageLength);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(accepted);
    expect(validate(envelope)).toBe(accepted);
  });
});

describe('Crash details exported schema', () => {
  const ajv = new AjvCtor({ strict: false, allErrors: true });
  addFormatsFn(ajv);
  const validate = ajv.compile(jsonSchema);

  it('accepts structured details in Ajv and Zod', () => {
    const envelope = structuredClone(hermes) as any;
    envelope.payload.crash.details = {
      severity: 'warning',
      context: 'checkout',
      metadata: { retry: 2, flags: [true, null] },
    };
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(validate(envelope)).toBe(true);
  });

  it.each([
    ['invalid severity', { severity: 'fatal' }],
    ['overlong ASCII context', { context: 'x'.repeat(257) }],
    ['overlong metadata key', { metadata: { ['k'.repeat(129)]: true } }],
    ['unknown details property', { future: true }],
  ] as const)('rejects %s in Ajv and Zod', (_name, details) => {
    const envelope = structuredClone(hermes) as any;
    envelope.payload.crash.details = details;
    expect(ReportEnvelope.safeParse(envelope).success).toBe(false);
    expect(validate(envelope)).toBe(false);
  });

  it.each([
    ['context at 256 UTF-16 units', { context: '😀'.repeat(128) }, true],
    ['context at 257 UTF-16 units', { context: `x${'😀'.repeat(128)}` }, false],
    ['key at 128 UTF-16 units', { metadata: { ['😀'.repeat(64)]: true } }, true],
    ['key at 129 UTF-16 units', { metadata: { [`x${'😀'.repeat(64)}`]: true } }, false],
  ] as const)('%s has the same result in Ajv and Zod', (_name, details, accepted) => {
    const envelope = structuredClone(hermes) as any;
    envelope.payload.crash.details = details;
    expect(ReportEnvelope.safeParse(envelope).success).toBe(accepted);
    expect(validate(envelope)).toBe(accepted);
  });
});
