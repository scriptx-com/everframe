// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, expect, it, beforeEach } from 'vitest';
import {
  start,
  stop,
  __getCompanionRunning,
  __onCompanionRunning,
} from '../../src/companion/singleton.js';

describe('companion running intent', () => {
  beforeEach(() => stop());

  it('is false before anything starts', () => {
    expect(__getCompanionRunning()).toBe(false);
  });

  it('is true after start and false after stop', () => {
    start({});
    expect(__getCompanionRunning()).toBe(true);
    stop();
    expect(__getCompanionRunning()).toBe(false);
  });

  it('is idempotent — a second stop() call is a harmless no-op', () => {
    start({});
    stop();
    stop();
    expect(__getCompanionRunning()).toBe(false);
  });

  it('notifies subscribers on each change and not on a repeat', () => {
    const seen: boolean[] = [];
    const off = __onCompanionRunning((r) => seen.push(r));
    start({});
    start({});
    stop();
    off();
    expect(seen).toEqual([true, false]);
  });
});
