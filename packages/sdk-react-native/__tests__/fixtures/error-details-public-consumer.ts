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
  sdkKey: 'publishable', crashReporting: { promiseRejections: { enabled: true } },
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

import { captureReactError } from '@everframe/react-native/integrations/react';
import { getErrorCaptureStatus, type ErrorCaptureStatus, type ErrorCaptureCounters,
  type ErrorCapturePath, type ErrorCaptureOutcome } from '@everframe/react-native';
import type { ErrorInfo } from 'react';
const captureStatus: ErrorCaptureStatus = getErrorCaptureStatus();
const capturePath: ErrorCapturePath = 'handled';
const captureCounters: ErrorCaptureCounters = captureStatus.counters[capturePath];
const captureOutcome: ErrorCaptureOutcome = 'accepted';
const errorInfo: ErrorInfo = { componentStack: '\n at Boundary' };
captureReactError(new Error('boundary'), errorInfo);
void captureCounters[captureOutcome];

import { getReportDeliveryStatus, type ReportDeliveryStatus, type ReportCapturePath,
  type ReportQueueStatus, type ReportTransportOrigin } from '@everframe/react-native';
const delivery: ReportDeliveryStatus = getReportDeliveryStatus();
const nativePath: ReportCapturePath = 'bridge-handled';
const queue: ReportQueueStatus = delivery.queue;
const origin: ReportTransportOrigin = 'outbox-drain';
void delivery.capture.paths[nativePath].outcomes.persisted;
void delivery.transport[origin].settledAttempts;
void queue.pendingCount;
