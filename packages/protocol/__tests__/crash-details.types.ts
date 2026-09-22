// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Compile-time contract fixture. Vitest does not select `.types.ts`; the
// protocol tsconfig includes it, so `pnpm typecheck` verifies every expected
// error remains an error.
import type { CrashDetails, JsonObject, JsonValue } from '../src/index.js';

const nestedJson: JsonObject = {
  string: 'value',
  number: 3,
  boolean: true,
  nullable: null,
  array: [1, 'two', false, null, { nested: ['value'] }],
};
const acceptedDetails: CrashDetails = { metadata: nestedJson };
const acceptedValue: JsonValue = acceptedDetails.metadata!;

const functionMetadataRejected: NonNullable<CrashDetails['metadata']> = {
  // @ts-expect-error — output metadata contains JSON values only.
  callback: () => null,
};
const bigintMetadataRejected: NonNullable<CrashDetails['metadata']> = {
  // @ts-expect-error — bigint is not a JSON value.
  amount: 1n,
};
const undefinedMetadataRejected: NonNullable<CrashDetails['metadata']> = {
  // @ts-expect-error — undefined is omitted during normalization, not emitted.
  missing: undefined,
};
const symbolMetadataRejected: NonNullable<CrashDetails['metadata']> = {
  // @ts-expect-error — symbols are not JSON values.
  marker: Symbol('marker'),
};
const classMetadataRejected: NonNullable<CrashDetails['metadata']> = {
  // @ts-expect-error — class instances are not JSON objects.
  instance: new (class Example { value = 1; })(),
};

void [
  acceptedValue,
  functionMetadataRejected,
  bigintMetadataRejected,
  undefinedMetadataRejected,
  symbolMetadataRejected,
  classMetadataRejected,
];
