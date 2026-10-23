// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from '../src/quick-capture/credentials.js';

const TOKEN = `evf_cap_${'a'.repeat(32)}`;
const creds = { token: TOKEN, url: 'https://everframe.dev', email: 'a@b.co' };
const home = () => mkdtempSync(join(tmpdir(), 'evf-creds-'));

describe('credentials', () => {
  it('round-trips and uses ~/.everframe/credentials', () => {
    const h = home();
    writeCredentials(creds, h);
    expect(credentialsPath(h)).toBe(join(h, '.everframe', 'credentials'));
    expect(readCredentials(h)).toEqual(creds);
  });

  it('writes 0700 directory and 0600 file', () => {
    const h = home();
    writeCredentials(creds, h);
    expect(statSync(join(h, '.everframe')).mode & 0o777).toBe(0o700);
    expect(statSync(credentialsPath(h)).mode & 0o777).toBe(0o600);
  });

  it('treats missing, malformed and wrong-format files as not logged in', () => {
    const h = home();
    expect(readCredentials(h)).toBeNull();
    mkdirSync(join(h, '.everframe'));
    writeFileSync(credentialsPath(h), '{nope');
    expect(readCredentials(h)).toBeNull();
    writeFileSync(credentialsPath(h), JSON.stringify({ ...creds, token: 'evf_cap_short' }));
    expect(readCredentials(h)).toBeNull();
    writeFileSync(credentialsPath(h), '"str"');
    expect(readCredentials(h)).toBeNull();
  });

  it('leaves no temp file after an overwrite', () => {
    const h = home();
    writeCredentials(creds, h);
    writeCredentials({ ...creds, email: 'c@d.co' }, h);
    expect(readdirSync(join(h, '.everframe'))).toEqual(['credentials']);
    expect(readCredentials(h)?.email).toBe('c@d.co');
  });

  it('deletes and reports whether a file existed', () => {
    const h = home();
    expect(deleteCredentials(h)).toBe(false);
    writeCredentials(creds, h);
    expect(deleteCredentials(h)).toBe(true);
    expect(readCredentials(h)).toBeNull();
  });
});
