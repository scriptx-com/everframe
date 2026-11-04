// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateFiles } from '../src/tickets/files.js';

const dir = mkdtempSync(join(tmpdir(), 'ticket-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe('validateFiles', () => {
  it('passes a PNG and a JPEG', async () => {
    writeFileSync(join(dir, 'a.png'), png);
    writeFileSync(join(dir, 'b.jpg'), jpeg);
    const r = await validateFiles([join(dir, 'a.png'), join(dir, 'b.jpg')], 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files.map((f) => f.name)).toEqual(['a.png', 'b.jpg']);
  });
  it('names a missing file', async () => {
    const r = await validateFiles([join(dir, 'nope.png')], 10);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toContain('nope.png');
  });
  it('rejects a directory', async () => {
    mkdirSync(join(dir, 'sub'));
    const r = await validateFiles([join(dir, 'sub')], 10);
    expect(!r.ok && r.message).toContain('sub');
  });
  it('rejects 25 MiB + 1 byte', async () => {
    writeFileSync(join(dir, 'big.png'), Buffer.alloc(25 * 1024 * 1024 + 1));
    const r = await validateFiles([join(dir, 'big.png')], 10);
    expect(!r.ok && r.message).toContain('big.png');
  });
  it('accepts exactly 25 MiB', async () => {
    writeFileSync(join(dir, 'ok.png'), Buffer.alloc(25 * 1024 * 1024));
    expect((await validateFiles([join(dir, 'ok.png')], 10)).ok).toBe(true);
  });
  it('rejects 11 files and names the count', async () => {
    const r = await validateFiles(
      Array.from({ length: 11 }, () => join(dir, 'a.png')),
      10,
    );
    expect(!r.ok && r.message).toContain('11');
  });
});
