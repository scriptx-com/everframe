// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  captureException,
  useTraceItX,
  type CaptureExceptionOptions,
} from '@traceitx/react-native';

const options: CaptureExceptionOptions = {
  severity: 'warning',
  context: 'checkout',
  metadata: { attempt: 2, nested: { state: 'before' } },
};
const publicCapture: (
  error: unknown,
  options?: CaptureExceptionOptions,
) => void = captureException;
const hook: ReturnType<typeof useTraceItX> = {} as ReturnType<typeof useTraceItX>;

publicCapture(new Error('top-level'), options);
hook.captureException(new Error('hook'), options);

// @ts-expect-error CaptureExceptionOptions only accepts the shared severity enum.
captureException(new Error('invalid severity'), { severity: 'fatal' });
// @ts-expect-error CaptureExceptionOptions context is a string when supplied.
hook.captureException(new Error('invalid context'), { context: 42 });
