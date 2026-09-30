// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AttachmentKind, AttachmentRef } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.resolve(here, rel), 'utf8');

function findById(node: unknown, id: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findById(child, id);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;
  if (rec.$id === id) return rec;
  for (const value of Object.values(rec)) {
    const hit = findById(value, id);
    if (hit) return hit;
  }
  return null;
}

describe('dom-snapshot attachment kind', () => {
  it('is an AttachmentKind', () => {
    expect(AttachmentKind.safeParse('dom-snapshot').success).toBe(true);
  });

  it('parses a gzip JSON snapshot ref for a later shot', () => {
    const ref = AttachmentRef.safeParse({
      partName: 'dom-snapshot-2',
      kind: 'dom-snapshot',
      contentType: 'application/gzip',
      byteLength: 24_000,
      sha256: 'a'.repeat(64),
    });
    expect(ref.success).toBe(true);
  });

  it('is in the published envelope JSON Schema', () => {
    const schema = JSON.parse(read('../schemas-json/envelope.v1.schema.json')) as unknown;
    const kind = findById(schema, 'AttachmentKind');
    expect(kind?.enum).toContain('dom-snapshot');
  });

  it('is generated into the Swift model', () => {
    expect(read('../../sdk-ios/Sources/EverframeProtocol/Generated.swift')).toContain(
      'case domSnapshot = "dom-snapshot"',
    );
  });

  it('is generated into the Kotlin model', () => {
    expect(
      read(
        '../../sdk-android/android/everframe-protocol/src/main/kotlin/dev/everframe/protocol/generated/Generated.kt',
      ),
    ).toContain('@SerialName("dom-snapshot") DOMSnapshot("dom-snapshot")');
  });
});
