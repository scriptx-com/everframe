// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  __setCompanionDefaults,
  __resolveCompanionStartOptionsForTests,
} from '../../src/companion/singleton.js';

describe('companion start-option defaults', () => {
  beforeEach(() => __setCompanionDefaults(null));
  afterEach(() => __setCompanionDefaults(null));

  it('uses registered defaults when the caller passes nothing', () => {
    __setCompanionDefaults({ sdkKey: 'txx_live_provider', deviceLabel: 'Lobby TV' });
    const resolved = __resolveCompanionStartOptionsForTests({});
    expect(resolved.sdkKey).toBe('txx_live_provider');
    expect(resolved.deviceLabel).toBe('Lobby TV');
  });

  it('lets an explicit option win over the registered default', () => {
    __setCompanionDefaults({ sdkKey: 'txx_live_provider', deviceLabel: 'Lobby TV' });
    const resolved = __resolveCompanionStartOptionsForTests({
      sdkKey: 'txx_live_explicit',
      deviceLabel: 'Kiosk 4',
    });
    expect(resolved.sdkKey).toBe('txx_live_explicit');
    expect(resolved.deviceLabel).toBe('Kiosk 4');
  });

  it('leaves fields absent when nothing is registered — standalone @everframe/web is unchanged', () => {
    const resolved = __resolveCompanionStartOptionsForTests({});
    expect(resolved.sdkKey).toBeUndefined();
    expect(resolved.deviceLabel).toBeUndefined();
  });

  it('resolves each field independently', () => {
    __setCompanionDefaults({ sdkKey: 'txx_live_provider', deviceLabel: 'Lobby TV' });
    const resolved = __resolveCompanionStartOptionsForTests({ deviceLabel: 'Kiosk 4' });
    expect(resolved.sdkKey).toBe('txx_live_provider');
    expect(resolved.deviceLabel).toBe('Kiosk 4');
  });
});
