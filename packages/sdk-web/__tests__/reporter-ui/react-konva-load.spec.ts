// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, expect, it } from 'vitest';

// react-konva refuses to load when the installed React is older than the
// release line it was built for (19.3.0 throws unless React >= 19.3). The
// annotation canvas imports it lazily, so a mismatch only shows up as an
// annotation UI that never opens. Loading it here fails the suite instead.
describe('react-konva / React alignment', () => {
  it('loads against the React version that gets bundled', async () => {
    const mod = await import('react-konva');
    expect(mod.Stage).toBeDefined();
  });
});
