// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import type { ReplayConfig } from '@everframe/sdk-core';
import {
  decideGesture,
  forcesReplay,
  isGestureArmed,
  quickCaptureEnabled,
  type GestureInput,
} from '../../src/devicelink/gesture-rule.js';

const USER = { kind: 'user' as const, name: 'Aurimas' };
const base: GestureInput = {
  quickCaptureEnabled: true,
  linkingEnabled: true,
  owner: null,
  debugBuild: false,
};
const NOTHING = { capture: false, sendHello: false, swallowKeys: false };

describe('capture gesture rule (contract table)', () => {
  it('linked user: capture and swallow, no hello', () => {
    const i = { ...base, owner: USER };
    expect(decideGesture(i)).toEqual({ capture: true, sendHello: false, swallowKeys: true });
    expect(isGestureArmed(i)).toBe(true);
  });

  it('linked team: capture and swallow, no hello', () => {
    const i = { ...base, owner: { kind: 'team' as const }, linkingEnabled: false };
    expect(decideGesture(i)).toEqual({ capture: true, sendHello: false, swallowKeys: true });
    expect(isGestureArmed(i)).toBe(true);
  });

  it('unlinked debug with linking on: capture and hello', () => {
    const i = { ...base, debugBuild: true };
    expect(decideGesture(i)).toEqual({ capture: true, sendHello: true, swallowKeys: false });
    expect(isGestureArmed(i)).toBe(true);
  });

  it('unlinked debug with linking off: capture only', () => {
    const i = { ...base, debugBuild: true, linkingEnabled: false };
    expect(decideGesture(i)).toEqual({ capture: true, sendHello: false, swallowKeys: false });
    expect(isGestureArmed(i)).toBe(true);
  });

  it('unlinked release with linking on: hello only', () => {
    expect(decideGesture(base)).toEqual({ capture: false, sendHello: true, swallowKeys: false });
    expect(isGestureArmed(base)).toBe(true);
  });

  it('unlinked release with linking off: nothing, and not armed', () => {
    const i = { ...base, linkingEnabled: false };
    expect(decideGesture(i)).toEqual(NOTHING);
    expect(isGestureArmed(i)).toBe(false);
  });

  it('quick capture off: nothing, and not armed', () => {
    for (const i of [
      { ...base, quickCaptureEnabled: false },
      { ...base, quickCaptureEnabled: false, owner: USER },
      { ...base, quickCaptureEnabled: false, debugBuild: true },
    ]) {
      expect(decideGesture(i)).toEqual(NOTHING);
      expect(isGestureArmed(i)).toBe(false);
    }
  });

  it('quickCaptureEnabled needs captureHotkey.enabled and no local or kill veto', () => {
    const on: ReplayConfig = {
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      captureHotkey: { enabled: true, binding: 'Shift+B', replay: true },
    };
    const off: ReplayConfig = {
      ...on,
      captureHotkey: { enabled: false, binding: 'x', replay: true },
    };
    const absent: ReplayConfig = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1 };
    const cfg = { sdkKey: 'k' };
    expect(quickCaptureEnabled(cfg, on, false)).toBe(true);
    expect(quickCaptureEnabled(cfg, off, false)).toBe(false);
    expect(quickCaptureEnabled(cfg, absent, false)).toBe(false);
    expect(quickCaptureEnabled(cfg, on, true)).toBe(false);
    expect(quickCaptureEnabled({ ...cfg, disabled: true }, on, false)).toBe(false);
    expect(quickCaptureEnabled({ ...cfg, quickCapture: { disabled: true } }, on, false)).toBe(
      false,
    );
    expect(quickCaptureEnabled({ ...cfg, reporter: { disabled: true } }, on, false)).toBe(false);
  });

  it('forcesReplay only for linked or debug with captureHotkey.replay', () => {
    expect(forcesReplay({ ...base, owner: USER, replay: true })).toBe(true);
    expect(forcesReplay({ ...base, debugBuild: true, replay: true })).toBe(true);
    expect(forcesReplay({ ...base, owner: USER, replay: false })).toBe(false);
    expect(forcesReplay({ ...base, replay: true })).toBe(false); // unlinked release
    expect(forcesReplay({ ...base, owner: USER, replay: true, quickCaptureEnabled: false })).toBe(
      false,
    );
  });
});
