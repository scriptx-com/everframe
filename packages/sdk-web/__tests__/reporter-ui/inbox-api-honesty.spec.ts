// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spec: the built-in inbox consumes exactly the public tx.threads.* API.
// If the UI needs something the facade does not expose, that is a bug in the
// facade — not a license to reach into adapter internals.
const INBOX_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/reporter-ui/inbox');
const BANNED = ['adapter.', '__', 'thread-client', 'reporter/api', 'dangerouslySetInnerHTML'];

describe('inbox API honesty', () => {
  it('inbox sources touch only the public threads facade', () => {
    for (const file of readdirSync(INBOX_DIR)) {
      const src = readFileSync(join(INBOX_DIR, file), 'utf8');
      for (const token of BANNED) {
        expect(src.includes(token), `${file} must not contain "${token}"`).toBe(false);
      }
    }
  });
});
