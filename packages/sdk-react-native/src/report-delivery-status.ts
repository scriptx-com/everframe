// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

const capturePaths = ['native-handled', 'bridge-handled', 'bridge-automatic', 'jvm-uncaught'] as const;
const captureOutcomes = ['persisted', 'disabled', 'admission-suppressed', 'reentrant', 'invalid-input', 'ownership-lost', 'storage-unavailable', 'failed'] as const;
const queueOperations = ['enqueue-committed', 'enqueue-failed', 'capacity-evicted', 'removed-after-acceptance', 'removed-after-terminal', 'removal-failed', 'read-failed'] as const;
const storageFailures = ['capacity', 'key-unavailable', 'corrupt', 'io', 'revoked', 'invalid-entry', 'busy', 'unknown', 'unsupported-format'] as const;
const transportOrigins = ['live-submit', 'outbox-drain'] as const;
const transportOutcomes = ['server-accepted', 'retryable-http', 'terminal-http', 'network-failure', 'authorization-cancelled', 'cancelled', 'failed'] as const;
export type ReportCapturePath = typeof capturePaths[number];
export type ReportCaptureOutcome = typeof captureOutcomes[number];
export type ReportQueueOperation = typeof queueOperations[number];
export type ReportStorageFailure = typeof storageFailures[number];
export type ReportTransportOrigin = typeof transportOrigins[number];
export type ReportTransportOutcome = typeof transportOutcomes[number];
export type ReportDeliveryReason = 'none' | 'no-start' | 'capture-disabled' | 'no-mount' | 'platform' | 'native-method-missing' | 'native-call-failed' | 'invalid-native-snapshot' | 'snapshot-busy';
export interface ReportCapturePathStatus {
  supported: boolean;
  settledAttempts: number;
  outcomes: Record<ReportCaptureOutcome, number>;
  lastOutcome?: ReportCaptureOutcome;
}
export interface ReportQueueStatus {
  scope: 'sdk-report-outbox';
  observation: 'not-observed' | 'observed' | 'failed';
  quality: 'complete' | 'partial' | 'unknown';
  pendingCount?: number;
  capacityPolicy: 'reject-new' | 'evict-oldest' | 'unknown';
  terminalHttpPolicy: 'retain' | 'attempt-remove' | 'unknown';
  operations: Record<ReportQueueOperation, number>;
  lastFailure?: ReportStorageFailure;
  migration: 'not-observed' | 'clear' | 'blocked' | 'unknown';
}
export interface ReportTransportStatus {
  settledAttempts: number;
  outcomes: Record<ReportTransportOutcome, number>;
  lastOutcome?: ReportTransportOutcome;
  lastHttpStatus?: number;
}
export interface ReportDeliveryStatus {
  schemaVersion: 1;
  status: 'active' | 'not-started' | 'disabled' | 'not-mounted' | 'unsupported' | 'unavailable';
  reason: ReportDeliveryReason;
  scope: 'native-runtime-observations';
  coverage: 'best-effort';
  revision: number;
  capture: { enabled: boolean; paths: Record<ReportCapturePath, ReportCapturePathStatus> };
  queue: ReportQueueStatus;
  transport: Record<ReportTransportOrigin, ReportTransportStatus>;
}

// Capture before a native property accessor or call can run application code.
const parseJSON = JSON.parse;
const objectKeys = Object.keys;
const hasOwn = Object.hasOwn;
const isArray = Array.isArray;
const isInteger = Number.isInteger;
const applyFunction = Reflect.apply;
const testPattern = RegExp.prototype.test;
const nonASCII = /[^\x00-\x7f]/;

const MAX = 2_147_483_647;
function mapKeys<K extends string, V>(keys: readonly K[], make: (key: K) => V): Record<K, V> {
  const result = {} as Record<K, V>;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    result[key] = make(key);
  }
  return result;
}
/** Native-free fallback. Unknown policy and unsupported paths assert no native coverage. */
export function emptyReportDeliveryStatus(status: ReportDeliveryStatus['status'], reason: ReportDeliveryReason): ReportDeliveryStatus {
  return {
    schemaVersion: 1, status, reason, scope: 'native-runtime-observations', coverage: 'best-effort', revision: 0,
    capture: { enabled: false, paths: mapKeys(capturePaths, () => ({ supported: false, settledAttempts: 0, outcomes: mapKeys(captureOutcomes, () => 0) })) },
    queue: { scope: 'sdk-report-outbox', observation: 'not-observed', quality: 'unknown', capacityPolicy: 'unknown', terminalHttpPolicy: 'unknown', operations: mapKeys(queueOperations, () => 0), migration: 'not-observed' },
    transport: mapKeys(transportOrigins, () => ({ settledAttempts: 0, outcomes: mapKeys(transportOutcomes, () => 0) })),
  };
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isArray(value)) throw new Error();
  const keys = objectKeys(value);
  for (let index = 0; index < required.length; index++) if (!hasOwn(value, required[index]!)) throw new Error();
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (!contains(required, key) && !contains(optional, key)) throw new Error();
  }
  return value as Record<string, unknown>;
}
function contains<T>(values: readonly T[], value: T): boolean {
  for (let index = 0; index < values.length; index++) if (values[index] === value) return true;
  return false;
}
function enumeration<K extends string>(value: unknown, choices: readonly K[]): K {
  if (typeof value !== 'string' || !contains(choices, value as K)) throw new Error();
  return value as K;
}
function counter(value: unknown): number {
  if (typeof value !== 'number' || !isInteger(value) || value < 0 || value > MAX) throw new Error();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error(); return value; }
function counters<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> {
  const input = record(value, keys);
  return mapKeys(keys, key => counter(input[key]));
}
function settled<K extends string>(input: Record<string, unknown>, keys: readonly K[]) {
  const outcomes = counters(input.outcomes, keys), settledAttempts = counter(input.settledAttempts);
  let sum = 0;
  for (let index = 0; index < keys.length; index++) sum += outcomes[keys[index]!];
  if ((sum > MAX ? MAX : sum) !== settledAttempts) throw new Error();
  const lastOutcome = hasOwn(input, 'lastOutcome') ? enumeration(input.lastOutcome, keys) : undefined;
  if ((settledAttempts > 0) !== (lastOutcome !== undefined) || (lastOutcome !== undefined && outcomes[lastOutcome] === 0)) throw new Error();
  return { settledAttempts, outcomes, ...(lastOutcome === undefined ? {} : { lastOutcome }) };
}

function nonzero<K extends string, V>(values: Record<K, V>, keys: readonly K[], read: (value: V) => number): boolean {
  for (let index = 0; index < keys.length; index++) if (read(values[keys[index]!]) !== 0) return true;
  return false;
}

/** Strict projection of the bounded, content-free native schema. Never returns arbitrary native keys. */
export function parseReportDeliveryStatus(json: unknown): ReportDeliveryStatus | null {
  try {
    // The complete wire vocabulary is ASCII. This also makes the character cap
    // an exact byte cap without requiring a TextEncoder polyfill in Hermes.
    if (typeof json !== 'string' || json.length > 16_384 || applyFunction(testPattern, nonASCII, [json])) return null;
    const input = record(parseJSON(json), ['schemaVersion', 'status', 'reason', 'scope', 'coverage', 'revision', 'capture', 'queue', 'transport']);
    if (input.schemaVersion !== 1 || input.scope !== 'native-runtime-observations' || input.coverage !== 'best-effort') return null;
    const status = enumeration(input.status, ['active', 'not-started', 'disabled', 'unavailable'] as const);
    const reason = enumeration(input.reason, ['none', 'no-start', 'capture-disabled', 'snapshot-busy'] as const);
    if ({ active: 'none', 'not-started': 'no-start', disabled: 'capture-disabled', unavailable: 'snapshot-busy' }[status] !== reason) return null;
    const capture = record(input.capture, ['enabled', 'paths']), rawPaths = record(capture.paths, capturePaths);
    const paths = mapKeys(capturePaths, path => {
      const raw = record(rawPaths[path], ['supported', 'settledAttempts', 'outcomes'], ['lastOutcome']);
      const result = { supported: boolean(raw.supported), ...settled(raw, captureOutcomes) };
      if (!result.supported && result.settledAttempts !== 0) throw new Error();
      return result;
    });
    const rawQueue = record(input.queue, ['scope', 'observation', 'quality', 'capacityPolicy', 'terminalHttpPolicy', 'operations', 'migration'], ['pendingCount', 'lastFailure']);
    if (rawQueue.scope !== 'sdk-report-outbox') return null;
    const queue: ReportQueueStatus = {
      scope: 'sdk-report-outbox', observation: enumeration(rawQueue.observation, ['not-observed', 'observed', 'failed']),
      quality: enumeration(rawQueue.quality, ['complete', 'partial', 'unknown']),
      capacityPolicy: enumeration(rawQueue.capacityPolicy, ['reject-new', 'evict-oldest']),
      terminalHttpPolicy: enumeration(rawQueue.terminalHttpPolicy, ['retain', 'attempt-remove']),
      operations: counters(rawQueue.operations, queueOperations),
      migration: enumeration(rawQueue.migration, ['not-observed', 'clear', 'blocked', 'unknown']),
      ...(hasOwn(rawQueue, 'pendingCount') ? { pendingCount: counter(rawQueue.pendingCount) } : {}),
      ...(hasOwn(rawQueue, 'lastFailure') ? { lastFailure: enumeration(rawQueue.lastFailure, storageFailures) } : {}),
    };
    if ((queue.capacityPolicy === 'reject-new') !== (queue.terminalHttpPolicy === 'retain')) return null;
    if ((queue.observation !== 'observed' || queue.quality === 'unknown') && queue.pendingCount !== undefined) return null;
    if (queue.observation !== 'observed' && queue.quality !== 'unknown') return null;
    if ((queue.observation === 'failed') !== (queue.lastFailure !== undefined)) return null;
    const rawTransport = record(input.transport, transportOrigins);
    const transport = mapKeys(transportOrigins, origin => {
      const raw = record(rawTransport[origin], ['settledAttempts', 'outcomes'], ['lastOutcome', 'lastHttpStatus']);
      const result: ReportTransportStatus = settled(raw, transportOutcomes);
      if (hasOwn(raw, 'lastHttpStatus')) {
        const code = counter(raw.lastHttpStatus);
        if (code < 100 || code > 599 || !contains(['server-accepted', 'retryable-http', 'terminal-http'], result.lastOutcome ?? '')) throw new Error();
        result.lastHttpStatus = code;
      }
      return result;
    });
    const result: ReportDeliveryStatus = { schemaVersion: 1, status, reason, scope: 'native-runtime-observations', coverage: 'best-effort', revision: counter(input.revision), capture: { enabled: boolean(capture.enabled), paths }, queue, transport };
    if (status !== 'active' && (result.revision !== 0 || result.capture.enabled || queue.observation !== 'not-observed' || nonzero(paths, capturePaths, p => p.settledAttempts) || nonzero(transport, transportOrigins, p => p.settledAttempts) || nonzero(queue.operations, queueOperations, n => n))) return null;
    return result;
  } catch { return null; }
}
