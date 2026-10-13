// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it } from 'vitest';
import { createWebHealthSession } from '../../src/release-health/session.js';
import { exposure, at } from './fixture.js';
it('allows a late failure to dominate completion without changing immutable observations', () => {
 const input = exposure(), s = createWebHealthSession(input);
 const start = s.start(); input.app.version = 'other';
 expect(s.start()).toEqual(start); expect(start.exposure.app.version).toBe('12.3.5-12-web');
 expect(s.complete(at)).toMatchObject({ sequence: 1, outcome: 'completed', elapsedMs: 60000 });
 expect(s.fail('onerror', at)).toMatchObject({ sequence: 2, outcome: 'crashed' });
 expect(s.fail('unhandledrejection', at)).toBeNull(); expect(s.complete(at)).toBeNull();
});
it('never completes after failure and tolerates wall clock rollback', () => {
 const s = createWebHealthSession(exposure());
 expect(s.fail('unhandledrejection', new Date(0))).toMatchObject({ capturedAt:'2026-10-13T12:00:00.000Z', elapsedMs:0 });
 expect(s.complete(at)).toBeNull();
});
