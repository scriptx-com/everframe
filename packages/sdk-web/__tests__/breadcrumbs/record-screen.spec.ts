// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, expect, it, vi } from 'vitest';
import { createScreenRecorder } from '../../src/breadcrumbs/record-screen.js';

describe('createScreenRecorder', () => {
  it('emits nothing for the first screen — there is no transition yet', () => {
    const sink = vi.fn();
    createScreenRecorder(sink)('Home');
    expect(sink).not.toHaveBeenCalled();
  });

  it('emits from → to on the second screen', () => {
    const sink = vi.fn();
    const record = createScreenRecorder(sink);
    record('Home');
    record('Settings');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      kind: 'navigation',
      message: 'Home → Settings',
      data: { from: 'Home', to: 'Settings' },
    });
  });

  it('suppresses A → A so a refocus or remount is not a navigation', () => {
    const sink = vi.fn();
    const record = createScreenRecorder(sink);
    record('Home');
    record('Home');
    expect(sink).not.toHaveBeenCalled();
  });

  it('ignores a blank name without disturbing the chain', () => {
    const sink = vi.fn();
    const record = createScreenRecorder(sink);
    record('Home');
    record('   ');
    record('Settings');
    expect(sink).toHaveBeenCalledWith({
      kind: 'navigation',
      message: 'Home → Settings',
      data: { from: 'Home', to: 'Settings' },
    });
  });

  it('merges host data beneath from/to, which always win', () => {
    const sink = vi.fn();
    const record = createScreenRecorder(sink);
    record('Home');
    record('Settings', { tab: 'audio', from: 'ignored' });
    expect(sink).toHaveBeenCalledWith({
      kind: 'navigation',
      message: 'Home → Settings',
      data: { tab: 'audio', from: 'Home', to: 'Settings' },
    });
  });

  it('keeps separate chains per recorder instance', () => {
    const a = vi.fn();
    const b = vi.fn();
    const recordA = createScreenRecorder(a);
    const recordB = createScreenRecorder(b);
    recordA('Home');
    recordB('Login');
    recordA('Settings');
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ message: 'Home → Settings' }));
    expect(b).not.toHaveBeenCalled();
  });

  it('emits nothing while the navigation kind is gated off', () => {
    const sink = vi.fn();
    const gate = vi.fn().mockReturnValue(false);
    const record = createScreenRecorder(sink, gate);
    record('Home');
    record('Settings');
    expect(gate).toHaveBeenCalledWith('navigation');
    expect(sink).not.toHaveBeenCalled();
  });

  it('still advances the chain while gated, so un-gating mid-session reports the true previous screen', () => {
    const sink = vi.fn();
    let enabled = false;
    const gate = () => enabled;
    const record = createScreenRecorder(sink, gate);
    record('Home'); // gated: no emit, but `previous` becomes 'Home'
    record('Settings'); // still gated: no emit, but `previous` becomes 'Settings'
    expect(sink).not.toHaveBeenCalled();
    enabled = true;
    record('Details');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      kind: 'navigation',
      message: 'Settings → Details',
      data: { from: 'Settings', to: 'Details' },
    });
  });
});
