// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Spec §2 tested invariant: breadcrumb `t` and replay frame `ts` live in the
// SAME clock domain (wall-clock epoch ms — buffer default Date.now; rrweb
// frames stamp Date.now), so the viewer aligns crumbs to replay frames by
// direct comparison, no per-report offset guessing. This test pins the
// ordering: a crumb stamped between two frames sorts between them.
import { describe, it, expect } from 'vitest';
import { createBreadcrumbBuffer } from '@traceitx/sdk-core';

describe('shared clock (spec §2)', () => {
  it('a crumb stamped between two wall-clock frame timestamps sorts between them', () => {
    const buf = createBreadcrumbBuffer(); // default now = Date.now (epoch ms)
    const frameBefore = Date.now(); // rrweb frames carry Date.now timestamps
    buf.add({ kind: 'tap', message: 'between frames' });
    const frameAfter = Date.now();
    buf.freeze();
    const [crumb] = buf.takeFrozen()!;
    expect(crumb!.t).toBeGreaterThanOrEqual(frameBefore);
    expect(crumb!.t).toBeLessThanOrEqual(frameAfter);
  });
});
