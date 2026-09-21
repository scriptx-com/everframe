// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays the cross-SDK parity fixture. Swift (sdk-ios) and Kotlin
// (sdk-android) run the SAME cases in Plan 4 — if this fixture changes, all
// three suites must change together.
import { describe, it, expect } from 'vitest';
import { trimBreadcrumbs } from '../src/breadcrumbs/trim.js';
import type { Breadcrumb } from '@traceitx/protocol';
import fixture from '../../protocol/__tests__/fixtures/breadcrumb-trim.v1.json';

interface Case {
  name: string;
  options: { byteBudget: number; consoleEntryCap: number };
  input: Breadcrumb[];
  expected: Breadcrumb[];
}

describe('breadcrumb-trim.v1.json parity', () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => {
      expect(trimBreadcrumbs(c.input, c.options)).toEqual(c.expected);
    });
  }
});
