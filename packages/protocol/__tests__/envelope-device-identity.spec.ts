// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '../src/envelope.js';
import minimal from './fixtures/v1-minimal.json' with { type: 'json' };

const here = path.dirname(fileURLToPath(import.meta.url));
const jsonSchema = JSON.parse(
  readFileSync(path.resolve(here, '../schemas-json/envelope.v1.schema.json'), 'utf8'),
);
const AjvCtor = (Ajv as unknown as { default: typeof Ajv }).default ?? Ajv;
const addFormatsFn =
  (addFormats as unknown as { default: typeof addFormats }).default ?? addFormats;
const ajv = new AjvCtor({ strict: false, allErrors: true });
addFormatsFn(ajv);
const validate = ajv.compile(jsonSchema);

const withContext = (app: Record<string, unknown>, device: Record<string, unknown>) => ({
  ...structuredClone(minimal),
  context: {
    ...minimal.context,
    app: { ...minimal.context.app, ...app },
    device: { ...minimal.context.device, ...device },
  },
});

const FULL_DEVICE = {
  manufacturer: 'Amazon',
  brand: 'Amazon',
  cpuAbi: ['armeabi-v7a', 'armeabi'],
  emulator: false,
  totalMemory: 2_147_483_648,
  runtimeVersions: { androidApiLevel: '25', reactNative: '0.86.2', hermes: '0.13.0' },
};

describe('static app and device identity', () => {
  it('keeps every field typed', () => {
    const parsed = ReportEnvelope.parse(
      withContext({ id: 'com.ekkl.apps', installerPackage: 'com.amazon.venezia' }, FULL_DEVICE),
    );
    expect(parsed.context.app.id).toBe('com.ekkl.apps');
    expect(parsed.context.app.installerPackage).toBe('com.amazon.venezia');
    expect(parsed.context.device).toMatchObject(FULL_DEVICE);
  });

  it('is optional', () => {
    const parsed = ReportEnvelope.parse(minimal);
    expect(parsed.context.app.id).toBeUndefined();
    expect(parsed.context.device.manufacturer).toBeUndefined();
  });

  it.each([
    ['all fields', {}, FULL_DEVICE, true],
    ['a 257-char app id', { id: 'a'.repeat(257) }, {}, false],
    ['a numeric emulator flag', {}, { emulator: 1 }, false],
    ['nine ABIs', {}, { cpuAbi: Array(9).fill('arm64-v8a') }, false],
    ['a fractional memory size', {}, { totalMemory: 1.5 }, false],
    ['a negative memory size', {}, { totalMemory: -1 }, false],
    ['a numeric runtime version', {}, { runtimeVersions: { chrome: 120 } }, false],
    [
      'seventeen runtime versions',
      {},
      { runtimeVersions: Object.fromEntries([...Array(17)].map((_, i) => [`k${i}`, '1'])) },
      false,
    ],
  ] as const)('%s has the same result in Ajv and Zod', (_name, app, device, accepted) => {
    const envelope = withContext(app, device);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(accepted);
    expect(validate(envelope)).toBe(accepted);
  });
});
