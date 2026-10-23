// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Credentials {
  token: string;
  url: string;
  email: string;
}

export const CAPTURE_TOKEN_PATTERN = /^evf_cap_[0-9A-Za-z]{32}$/;

export const credentialsPath = (home: string = homedir()): string =>
  join(home, '.everframe', 'credentials');

/** Missing, unparsable or malformed-token files all mean "not logged in". */
export function readCredentials(home: string = homedir()): Credentials | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialsPath(home), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { token, url, email } = parsed as Record<string, unknown>;
    if (typeof token !== 'string' || !CAPTURE_TOKEN_PATTERN.test(token)) return null;
    return {
      token,
      url: typeof url === 'string' ? url : '',
      email: typeof email === 'string' ? email : '',
    };
  } catch {
    return null;
  }
}

/** Atomic write: a temp file in the same directory, then rename. */
export function writeCredentials(c: Credentials, home: string = homedir()): void {
  const file = credentialsPath(home);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = join(dir, `.credentials.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ token: c.token, url: c.url, email: c.email }), {
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Returns true when a file was removed. */
export function deleteCredentials(home: string = homedir()): boolean {
  try {
    readFileSync(credentialsPath(home));
  } catch {
    return false;
  }
  rmSync(credentialsPath(home), { force: true });
  return true;
}
