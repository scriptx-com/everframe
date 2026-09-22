// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Drift guard: sdk-core's BreadcrumbsConfig must accept/reject exactly the
// same cases as the server's BreadcrumbsBlockSchema (config-route.ts) — see
// the server breadcrumbs parity suite,
// which replays the SAME fixture against the server schema.
import { describe, it, expect } from 'vitest';
import { BreadcrumbsConfig } from '../src/types/replay/config-provider.js';
import fixture from '../../protocol/__tests__/fixtures/breadcrumbs-config-parity.v1.json';

describe('breadcrumbs config block parity (sdk-core side)', () => {
  for (const [i, block] of (fixture.valid as unknown[]).entries()) {
    it(`accepts valid case ${i}`, () => {
      expect(BreadcrumbsConfig.safeParse(block).success).toBe(true);
    });
  }
  for (const [i, block] of (fixture.invalid as unknown[]).entries()) {
    it(`rejects invalid case ${i}`, () => {
      expect(BreadcrumbsConfig.safeParse(block).success).toBe(false);
    });
  }
});
