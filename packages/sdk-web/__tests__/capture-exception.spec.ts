// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ReportEnvelope } from '@traceitx/protocol';
import { init, type CaptureExceptionOptions, type TraceItXHandle } from '../src/index.js';
import { createLocalStorageOutbox } from '../src/outbox/localStorage.js';

let handle: TraceItXHandle | undefined;
let sent: ReportEnvelope[];
let attempts: ReportEnvelope[];
let attemptBytes: Uint8Array[];
let ingestStatuses: number[];
let completedIngestStatuses: number[];
let firstIngestReached: (() => void) | undefined;
let firstIngestResponseGate: Promise<void> | undefined;
let releaseFirstIngestResponse: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  sent = [];
  attempts = [];
  attemptBytes = [];
  ingestStatuses = [];
  completedIngestStatuses = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, options?: RequestInit) => {
    let status = 200;
    if (String(url).endsWith('/api/ingest')) {
      const body = options?.body as FormData;
      const rawEnvelope = await (body.get('envelope') as Blob).text();
      attemptBytes.push(new TextEncoder().encode(rawEnvelope));
      const envelope = ReportEnvelope.parse(JSON.parse(rawEnvelope));
      attempts.push(envelope);
      // Ingest is idempotent by reportId. Startup and immediate drains can overlap.
      if (!sent.some(event => event.reportId === envelope.reportId)) sent.push(envelope);
      if (attempts.length === 1 && firstIngestResponseGate) {
        firstIngestReached?.();
        await firstIngestResponseGate;
      }
      status = ingestStatuses.shift() ?? 200;
      completedIngestStatuses.push(status);
    }
    return new Response(JSON.stringify({ status: 'received' }), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }));
});

afterEach(() => {
  releaseFirstIngestResponse?.();
  firstIngestReached = undefined;
  firstIngestResponseGate = undefined;
  releaseFirstIngestResponse = undefined;
  for (const attempt of attempts) {
    expect(attempt.payload.crash).toEqual(sent.find(event => event.reportId === attempt.reportId)!.payload.crash);
  }
  handle?.destroy();
  handle = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function failure(name = 'checkout'): Error {
  const error = new Error('Card 4111111111111111 failed');
  error.stack = `Error: ${error.message}\n    at ${name} (app.js:1:250)`;
  return error;
}

function failureWithCause(inner: Error): Error {
  const outer = new Error('Card 4111111111111111 failed', { cause: inner });
  outer.stack = `Error: ${outer.message}\n    at checkout (app.js:1:250)`;
  return outer;
}

describe('captureException', () => {
  it('sends an immutable redacted details snapshot and reuses it for retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    ingestStatuses.push(503, 200);
    const reachedFirstIngest = new Promise<void>((resolve) => { firstIngestReached = resolve; });
    firstIngestResponseGate = new Promise<void>((resolve) => { releaseFirstIngestResponse = resolve; });
    handle = init({ apiKey: 'pk_test', appName: 'shop', appVersion: '2.1', appBuild: 'web-abc123' });
    handle.setUser({ id: 'user-1' });
    handle.addBreadcrumb({ message: 'Opened checkout' });
    const metadata = { retry: 2, accessToken: 'synthetic' };
    const inner = new TypeError('inner 4111111111111111');
    Object.defineProperty(inner, 'stack', {
      configurable: true,
      value: 'TypeError: inner 4111111111111111\n    at charge (payments.js:2:8)',
    });
    handle.captureException(failureWithCause(inner), {
      severity: 'warning',
      context: 'checkout',
      metadata,
    });
    metadata.retry = 99;
    inner.message = 'mutated after return';

    await reachedFirstIngest;
    const releaseFirstResponse = releaseFirstIngestResponse!;
    let acceptedBytes: Uint8Array;
    try {
      const accepted = await createLocalStorageOutbox()!.list();
      expect(accepted).toHaveLength(1);
      acceptedBytes = accepted[0]!.payload;
      expect(Array.from(attemptBytes[0]!)).toEqual(Array.from(acceptedBytes));
      expect(attempts[0]!.reportId).toBe(accepted[0]!.reportId);
    } finally {
      releaseFirstResponse();
    }
    await vi.waitFor(() => expect(attemptBytes).toHaveLength(2));
    expect(Array.from(attemptBytes[0]!)).toEqual(Array.from(acceptedBytes!));
    expect(Array.from(attemptBytes[1]!)).toEqual(Array.from(acceptedBytes!));
    expect(completedIngestStatuses).toEqual([503, 200]);
    expect(attempts[0]!.reportId).toBe(attempts[1]!.reportId);
    expect(attempts[0]!.payload.crash).toEqual(attempts[1]!.payload.crash);
    expect(sent[0]).toMatchObject({
      source: 'error',
      context: { app: { name: 'shop', version: '2.1', build: 'web-abc123' } },
      reporter: { user: { id: 'user-1' } },
      payload: {
        crash: {
          handled: true,
          fatal: false,
          mechanism: 'captureException',
          details: {
            severity: 'warning',
            context: 'checkout',
            metadata: { retry: 2, accessToken: '[REDACTED]' },
          },
        },
      },
    });
    expect(sent[0]!.payload.crash!.message).toBe('Card [REDACTED:CC] failed');
    expect(sent[0]!.payload.crash!.causeChain).toEqual({
      causes: [{
        exceptionType: 'TypeError',
        message: 'inner [REDACTED:CC]',
        frames: [{ raw: 'at charge (payments.js:2:8)' }],
        framesTruncated: false,
      }],
      truncated: false,
    });
    expect(sent[0]!.payload.breadcrumbs?.some(b => b.message === 'Opened checkout')).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    if (process.env['TRACEITX_TASK3_RECEIPTS'] === '1') {
      console.log(`TASK3_RETRY_RECEIPT ${JSON.stringify({
        acceptedEnvelopeBytes: acceptedBytes!.byteLength,
        acceptedEnvelopeSha256: createHash('sha256').update(acceptedBytes!).digest('hex'),
        attemptEnvelopeSha256: attemptBytes.map(bytes => createHash('sha256').update(bytes).digest('hex')),
        reportId: attempts[0]!.reportId,
        idempotencyIdentity: attempts.map(attempt => attempt.reportId),
        completedStatuses: completedIngestStatuses,
        retainedCauseMessage: attempts[1]!.payload.crash!.causeChain!.causes[0]!.message,
      })}`);
    }
  });

  it('keeps classification fixed when untyped callers supply handled or fatal fields', async () => {
    handle = init({ apiKey: 'pk_test' });
    const options = {
      severity: 'info',
      handled: false,
      fatal: true,
    } as unknown as CaptureExceptionOptions;

    handle.captureException(failure(), options);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload.crash).toMatchObject({
      handled: true,
      fatal: false,
      details: { severity: 'info' },
    });
  });

  it('keeps the core error when optional metadata cannot be inspected', async () => {
    handle = init({ apiKey: 'pk_test' });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(() => handle!.captureException(failure(), { metadata: revoked.proxy })).not.toThrow();

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload.crash).toMatchObject({
      message: 'Card [REDACTED:CC] failed',
      details: { severity: 'error', truncated: true },
    });
    expect(sent[0]!.payload.crash!.details?.metadata).toBeUndefined();
  });

  it('rechecks context and metadata limits after custom redaction expands text', async () => {
    const replacement = 'r'.repeat(1500);
    handle = init({
      apiKey: 'pk_test',
      redaction: { customRules: [{ type: 'pattern', match: /PIN/g, replacement }] },
    });

    handle.captureException(failure(), { context: 'PIN', metadata: { note: 'PIN' } });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const details = sent[0]!.payload.crash!.details!;
    expect(details.context).toBe('r'.repeat(256));
    expect(details.metadata?.['note']).toBe('r'.repeat(1024));
    expect(details.truncated).toBe(true);
  });

  it.each(['kill', 'destroy'] as const)(
    'persists nothing when capture-option proxy work triggers %s', async action => {
      handle = init({ apiKey: 'pk_test' });
      const options = new Proxy({}, {
        getPrototypeOf() {
          if (action === 'kill') handle!.kill();
          else handle!.destroy();
          return Object.prototype;
        },
      });

      expect(() => handle!.captureException(failure(), options)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await createLocalStorageOutbox()!.list()).toEqual([]);
      expect(sent).toHaveLength(0);
    },
  );

  it('keeps fingerprints stable across independent capture lifetimes with different details', async () => {
    handle = init({ apiKey: 'pk_first' });
    handle.captureException(failure(), { severity: 'warning', context: 'checkout' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const firstFingerprint = sent[0]!.payload.crash!.fingerprint;
    handle.destroy();

    handle = init({ apiKey: 'pk_second' });
    handle.captureException(failure(), { severity: 'info', context: 'payment' });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1]!.payload.crash!.fingerprint).toBe(firstFingerprint);
    expect(sent.map(event => event.payload.crash!.details!.context)).toEqual(['checkout', 'payment']);
  });

  it('keeps the raw outer fingerprint stable across independent cause-only changes', async () => {
    handle = init({ apiKey: 'pk_first' });
    handle.captureException(failureWithCause(new TypeError('first cause')));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const firstFingerprint = sent[0]!.payload.crash!.fingerprint;
    handle.destroy();

    handle = init({ apiKey: 'pk_second' });
    handle.captureException(failureWithCause(new RangeError('second cause')));
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1]!.payload.crash!.fingerprint).toBe(firstFingerprint);
    expect(sent.map(event => event.payload.crash!.causeChain?.causes[0]?.message))
      .toEqual(['first cause', 'second cause']);
    if (process.env['TRACEITX_TASK3_RECEIPTS'] === '1') {
      console.log(`TASK3_FINGERPRINT_RECEIPT ${JSON.stringify({
        fingerprint: firstFingerprint,
        causeMessages: sent.map(event => event.payload.crash!.causeChain?.causes[0]?.message),
      })}`);
    }
  });

  it('drops a descriptor-reentrant stale capture without consuming successor allowance', async () => {
    handle = init({ apiKey: 'pk_old' });
    const old = handle;
    const inner = new TypeError('stale cause');
    let causeDescriptorCalls = 0;
    const outer = new Proxy(failureWithCause(inner), {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'cause') {
          causeDescriptorCalls += 1;
          old.kill();
          old.destroy();
          handle = init({ apiKey: 'pk_new' });
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(() => old.captureException(outer)).not.toThrow();
    handle.captureException(failure('successor'));

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(causeDescriptorCalls).toBe(1);
    expect(sent[0]!.payload.crash!.frames[0]!.raw).toContain('successor');
    expect(sent[0]!.payload.crash!.causeChain).toBeUndefined();
    if (process.env['TRACEITX_TASK3_RECEIPTS'] === '1') {
      console.log(`TASK3_DESCRIPTOR_OWNERSHIP_RECEIPT ${JSON.stringify({
        staleSent: 0,
        causeDescriptorCalls,
        acceptedSuccessor: sent[0]!.payload.crash!.frames[0]!.raw,
      })}`);
    }
  });

  it('drops a redactor-reentrant stale capture without consuming successor allowance', async () => {
    let old: TraceItXHandle;
    let redactorCalls = 0;
    const match = {
      [Symbol.replace](value: string): string {
        redactorCalls += 1;
        old.kill();
        old.destroy();
        handle = init({ apiKey: 'pk_new' });
        return value;
      },
    } as unknown as RegExp;
    handle = init({
      apiKey: 'pk_old',
      redaction: { customRules: [{ type: 'pattern', match, replacement: '[REDACTED]' }] },
    });
    old = handle;

    expect(() => old.captureException(failureWithCause(new TypeError('stale cause')))).not.toThrow();
    handle.captureException(failure('successorAfterRedactor'));

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(redactorCalls).toBe(1);
    expect(sent[0]!.payload.crash!.frames[0]!.raw).toContain('successorAfterRedactor');
    if (process.env['TRACEITX_TASK3_RECEIPTS'] === '1') {
      console.log(`TASK3_REDACTOR_OWNERSHIP_RECEIPT ${JSON.stringify({
        staleSent: 0,
        redactorCalls,
        acceptedSuccessor: sent[0]!.payload.crash!.frames[0]!.raw,
      })}`);
    }
  });

  it('drops a native-formatter-reentrant stale capture and accepts the restarted successor', async () => {
    const errorConstructor = Error as ErrorConstructor & {
      prepareStackTrace?: (error: Error, frames: unknown[]) => unknown;
    };
    const previousFormatter = Object.getOwnPropertyDescriptor(errorConstructor, 'prepareStackTrace');
    handle = init({ apiKey: 'pk_old' });
    const old = handle;
    let formatterCalls = 0;
    Object.defineProperty(errorConstructor, 'prepareStackTrace', {
      configurable: true,
      value: () => {
        formatterCalls += 1;
        old.kill();
        old.destroy();
        handle = init({ apiKey: 'pk_new' });
        return 'TypeError: stale native cause\n    at stale (stale.js:1:1)';
      },
      writable: true,
    });
    const inner = new TypeError('stale native cause');
    const outer = new Error('outer', { cause: inner });
    Object.defineProperty(outer, 'stack', {
      configurable: true,
      value: 'Error: outer\n    at outer (outer.js:1:1)',
    });

    try {
      expect(() => old.captureException(outer)).not.toThrow();
    } finally {
      if (previousFormatter) {
        Object.defineProperty(errorConstructor, 'prepareStackTrace', previousFormatter);
      } else {
        Reflect.deleteProperty(errorConstructor, 'prepareStackTrace');
      }
    }
    handle.captureException(failure('successorAfterFormatter'));

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(formatterCalls).toBe(1);
    expect(sent[0]!.payload.crash!.frames[0]!.raw).toContain('successorAfterFormatter');
    if (process.env['TRACEITX_TASK3_RECEIPTS'] === '1') {
      console.log(`TASK3_FORMATTER_OWNERSHIP_RECEIPT ${JSON.stringify({
        staleSent: 0,
        formatterCalls,
        acceptedSuccessor: sent[0]!.payload.crash!.frames[0]!.raw,
      })}`);
    }
  });

  it.each(['explicit-first', 'automatic-first'] as const)(
    'reports the same error object once across capture paths (%s)', async order => {
      handle = init({ apiKey: 'pk_test' });
      const error = failure();
      const automatic = () => window.onerror?.(error.message, 'app.js', 1, 250, error);
      if (order === 'explicit-first') handle.captureException(error);
      automatic();
      handle.captureException(error);
      if (order === 'explicit-first') automatic();

      await vi.waitFor(() => expect(sent).toHaveLength(1));
      // A second event provides a positive completion fence for queued work.
      handle.captureException(failure('anotherFunction'));
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      expect(sent[0]!.payload.crash).toMatchObject({
        handled: order === 'explicit-first', fatal: false,
      });
    },
  );

  it('keeps automatic errors reportable after handled errors exhaust their allowance', async () => {
    handle = init({ apiKey: 'pk_test' });
    for (let i = 0; i < 11; i++) {
      // Fingerprint normalization strips digits, so use distinct letter names.
      handle.captureException(failure(String.fromCharCode(97 + i)));
      if (i < 10) await vi.waitFor(() => expect(sent).toHaveLength(i + 1));
    }
    const error = failure('a');
    window.onerror?.(error.message, 'app.js', 1, 250, error);
    await vi.waitFor(() => expect(sent).toHaveLength(11));
    expect(sent[10]!.payload.crash).toMatchObject({ handled: false, fatal: false });
  });

  it.each(['disabled', 'crash-disabled', 'killed', 'destroyed'] as const)(
    'does not capture after %s', async mode => {
      handle = init({
        apiKey: 'pk_test',
        ...(mode === 'disabled' ? { disabled: true } : {}),
        ...(mode === 'crash-disabled' ? { crashReporting: { disabled: true } } : {}),
      });
      if (mode === 'killed') handle.kill();
      if (mode === 'destroyed') handle.destroy();
      expect(() => handle!.captureException(failure())).not.toThrow();
      expect(await createLocalStorageOutbox()!.list()).toEqual([]);
      expect(sent).toHaveLength(0);
      handle.destroy();
      handle = init({ apiKey: 'pk_test' });
      handle.captureException(failure('liveAfterDisabled'));
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]!.payload.crash!.frames[0]!.raw).toContain('liveAfterDisabled');
    },
  );

  it('persists and sends nothing when an explicit error stack getter kills the client', async () => {
    handle = init({ apiKey: 'pk_test' });
    const error = new Error('host-controlled stack');
    Object.defineProperty(error, 'stack', {
      configurable: true,
      get() {
        handle!.kill();
        return 'Error: host-controlled stack\n    at capture (app.js:1:1)';
      },
    });

    expect(() => handle!.captureException(error)).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await createLocalStorageOutbox()!.list()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('accepts a non-Error thrown value without throwing', async () => {
    handle = init({ apiKey: 'pk_test' });
    handle.captureException('checkout unavailable');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload.crash).toMatchObject({
      message: 'checkout unavailable', handled: true, fatal: false,
    });
  });

  it('keeps a destroyed handle inert after another SDK instance starts', async () => {
    handle = init({ apiKey: 'pk_old' });
    const old = handle;
    old.destroy();
    handle = init({ apiKey: 'pk_new' });
    old.captureException(failure('stale'));
    handle.captureException(failure('live'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload.crash!.frames[0]!.raw).toContain('live');
  });

  it('survives hostile thrown values and can still report the next error', async () => {
    handle = init({ apiKey: 'pk_test' });
    const hostile = {
      toJSON() { throw new Error('serialization unavailable'); },
      toString() { throw new Error('string conversion unavailable'); },
    };
    expect(() => handle!.captureException(hostile)).not.toThrow();
    handle.captureException(failure());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload.crash!.message).toBe('Card [REDACTED:CC] failed');
  });
});
