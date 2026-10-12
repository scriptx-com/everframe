// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12), React Native JS side. The host-facing
// `reporter: { disabled }` flattens onto the bridge's `reporterDisabled`, and
// a native `open()` refusal (`EVERFRAME_REPORTER_DISABLED`) surfaces as
// `EverframeReporterDisabledError`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NativeEverframe from '../src/NativeEverframe.js';
import { createRuntime, __extractBridgeConfigForTesting as extract } from '../src/runtime.js';
import { __setCurrentContext } from '../src/contextSeam.js';
import { EverframeReporterDisabledError } from '../src/reporter/types.js';
import * as nativeEntry from '../src/index.js';

const native = NativeEverframe as unknown as { openReporter: ReturnType<typeof vi.fn> };

function nativeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('reporter config flattening', () => {
  it('sends reporterDisabled: true when the reporter is disabled', () => {
    expect(extract({ sdkKey: 'k', reporter: { disabled: true } }).reporterDisabled).toBe(true);
  });

  it('omits the bridge field otherwise', () => {
    expect('reporterDisabled' in extract({ sdkKey: 'k' })).toBe(false);
    expect('reporterDisabled' in extract({ sdkKey: 'k', reporter: {} })).toBe(false);
    expect('reporterDisabled' in extract({ sdkKey: 'k', reporter: { disabled: false } })).toBe(false);
  });
});

describe('open() in a session with the reporter disabled', () => {
  beforeEach(() => {
    native.openReporter.mockReset();
  });

  afterEach(() => {
    __setCurrentContext(null);
  });

  it('maps the native EVERFRAME_REPORTER_DISABLED rejection to EverframeReporterDisabledError', async () => {
    native.openReporter.mockRejectedValue(
      nativeError('EVERFRAME_REPORTER_DISABLED', 'The reporter is disabled.'),
    );
    const rt = createRuntime({ sdkKey: 'k', reporter: { disabled: true } });
    rt.mount();
    const result = rt.open();
    await expect(result).rejects.toBeInstanceOf(EverframeReporterDisabledError);
    await expect(rt.open()).rejects.toMatchObject({ name: 'EverframeReporterDisabledError' });
    rt.unmount();
  });

  it('passes other native rejections through unchanged', async () => {
    const other = nativeError('E_SOMETHING_ELSE', 'boom');
    native.openReporter.mockRejectedValue(other);
    const rt = createRuntime({ sdkKey: 'k' });
    rt.mount();
    await expect(rt.open()).rejects.toBe(other);
    rt.unmount();
  });

  it('still resolves a normal result', async () => {
    native.openReporter.mockResolvedValue({ status: 'cancelled' });
    const rt = createRuntime({ sdkKey: 'k' });
    rt.mount();
    await expect(rt.open()).resolves.toEqual({ status: 'cancelled' });
    rt.unmount();
  });

  it('the top-level open() rejects the same way', async () => {
    native.openReporter.mockRejectedValue(
      nativeError('EVERFRAME_REPORTER_DISABLED', 'The reporter is disabled.'),
    );
    const rt = createRuntime({ sdkKey: 'k', reporter: { disabled: true } });
    rt.mount();
    await expect(nativeEntry.open()).rejects.toBeInstanceOf(EverframeReporterDisabledError);
    rt.unmount();
  });

  it('is exported from the package root', () => {
    expect(typeof EverframeReporterDisabledError).toBe('function');
    expect(nativeEntry.EverframeReporterDisabledError).toBe(EverframeReporterDisabledError);
  });
});
