// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Regenerates every fixture case's `expected` from its `input` + `options`
// by running the ALGORITHM OF RECORD (sdk-core trim.ts, built to dist/).
// The oracle stays mechanical: never hand-compute an expected. Existing
// cases regenerating byte-identically is itself a regression check.
// Usage: pnpm --filter @everframe/sdk-core build && node packages/sdk-core/scripts/regen-trim-fixture-expected.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { trimBreadcrumbs } from '../dist/index.js';

const url = new URL('../../protocol/__tests__/fixtures/breadcrumb-trim.v1.json', import.meta.url);
const fixture = JSON.parse(readFileSync(url, 'utf8'));
for (const c of fixture.cases) {
  c.expected = trimBreadcrumbs(c.input, c.options ?? {});
}
writeFileSync(url, JSON.stringify(fixture, null, 2) + '\n');
console.log(`regenerated expected for ${fixture.cases.length} case(s)`);
