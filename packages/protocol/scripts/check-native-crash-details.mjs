// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CrashDetails } from '../dist/index.js';

assert.equal(
  process.argv.length,
  3,
  'Usage: check-native-crash-details.mjs <native-export.json>',
);
const record = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const exactKeys = (value, keys) => {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  assert.deepEqual(Object.keys(value).sort(), keys.slice().sort());
};
exactKeys(record, ['schemaVersion', 'cases']);
assert.equal(record.schemaVersion, 1);
assert.ok(Array.isArray(record.cases));
const required = new Set([
  'normal',
  'expanding-redactor',
  'repaired-text',
  'capped',
  'prototype-keys',
  'numeric-boundary',
]);
const seen = new Set();
for (const entry of record.cases) {
  exactKeys(entry, ['name', 'detailsJson']);
  assert.equal(typeof entry.name, 'string');
  assert.ok(required.has(entry.name), `Unknown case: ${entry.name}`);
  assert.ok(!seen.has(entry.name), `Duplicate case: ${entry.name}`);
  seen.add(entry.name);
  assert.equal(typeof entry.detailsJson, 'string');
  const bytes = Buffer.byteLength(entry.detailsJson, 'utf8');
  assert.ok(bytes <= 8192, `${entry.name}: ${bytes} bytes exceeds 8192`);
  const value = JSON.parse(entry.detailsJson);
  const parsed = CrashDetails.safeParse(value);
  assert.ok(parsed.success, `${entry.name}: protocol rejected native details`);
  const sharedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.ok(
    sharedBytes <= 8192,
    `${entry.name}: ${sharedBytes} shared JSON bytes exceeds 8192`,
  );
  if (entry.name === 'numeric-boundary') {
    assert.equal(value.truncated, true);
    const numbers = typeof value.metadata?.number === 'number'
      ? [value.metadata.number]
      : value.metadata?.a;
    assert.ok(Array.isArray(numbers) && numbers.length > 0);
    assert.ok(numbers.every(number => number === 1e20));
  }
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(parsed.data)),
    value,
    `${entry.name}: protocol lost JSON semantics`,
  );
  console.log(
    `${entry.name}: ${bytes} native UTF-8 bytes, ${sharedBytes} shared JSON bytes; schema and semantics preserved`,
  );
}
assert.deepEqual(seen, required, 'Missing required native cases');
