// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import Native from '../src/NativeEverframe.js';
import { createRuntime } from '../src/runtime.js';
let runtime: ReturnType<typeof createRuntime> | undefined;
afterEach(() => {
  runtime?.unmount();
  runtime = undefined;
  vi.clearAllMocks();
});
it('preserves legacy open and explicitly attributes host menu opens', async () => {
  runtime = createRuntime({ sdkKey: 'test-key' });
  runtime.mount();
  await runtime.open();
  expect(Native.openReporter).toHaveBeenCalledWith();
  await runtime.open({ trigger: 'menu' });
  expect(Native.openReporterWithTrigger).toHaveBeenCalledWith('menu');
  expect(Native.openReporter).toHaveBeenCalledTimes(1);
});
it('only the mounted owner can mark a host reporter interval, with bounded trigger values', () => {
  runtime = createRuntime({ sdkKey: 'test-key' });
  runtime.markReporterOpened('button');
  expect(Native.markReporterOpened).not.toHaveBeenCalled();
  runtime.mount();
  runtime.markReporterOpened('menu');
  runtime.markReporterOpened('playPause' as never);
  expect(Native.markReporterOpened).toHaveBeenCalledTimes(1);
  expect(Native.markReporterOpened).toHaveBeenCalledWith('menu');
  runtime.markReporterClosed();
  expect(Native.markReporterClosed).toHaveBeenCalledTimes(1);
  runtime.unmount();
  runtime.markReporterOpened('button');
  runtime.markReporterClosed();
  expect(Native.markReporterOpened).toHaveBeenCalledTimes(1);
  expect(Native.markReporterClosed).toHaveBeenCalledTimes(1);
});

it('waits for native marker publication before the host continues its reporter flow', async () => {
  runtime = createRuntime({ sdkKey: 'test-key' });
  runtime.mount();
  let publish!: () => void;
  vi.mocked(Native.markReporterOpened).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      publish = resolve;
    }),
  );
  let continued = false;
  const pending = Promise.resolve(runtime.markReporterOpened('menu')).then(() => {
    continued = true;
  });
  await Promise.resolve();
  expect(continued).toBe(false);
  publish();
  await pending;
  expect(continued).toBe(true);
});
