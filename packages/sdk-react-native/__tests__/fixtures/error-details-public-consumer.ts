// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  captureException,
  getPromiseRejectionStatus,
  useEverframe,
  type PromiseRejectionStatus,
  type EverframeProviderProps,
  type CaptureExceptionOptions,
} from '@everframe/react-native';

const status: PromiseRejectionStatus = getPromiseRejectionStatus();
const config: EverframeProviderProps['config'] = {
  apiKey: 'publishable', crashReporting: { promiseRejections: { enabled: true } },
};
void status; void config;

const options: CaptureExceptionOptions = {
  severity: 'warning',
  context: 'checkout',
  metadata: { attempt: 2, nested: { state: 'before' } },
};
const publicCapture: (
  error: unknown,
  options?: CaptureExceptionOptions,
) => void = captureException;
const hook: ReturnType<typeof useEverframe> = {} as ReturnType<typeof useEverframe>;

publicCapture(new Error('top-level'), options);
hook.captureException(new Error('hook'), options);

// @ts-expect-error CaptureExceptionOptions only accepts the shared severity enum.
captureException(new Error('invalid severity'), { severity: 'fatal' });
// @ts-expect-error CaptureExceptionOptions context is a string when supplied.
hook.captureException(new Error('invalid context'), { context: 42 });
