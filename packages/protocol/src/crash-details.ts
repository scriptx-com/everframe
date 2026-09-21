// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { utf8ByteLength } from './vitals.js';

export const MAX_CRASH_DETAILS_BYTES = 8192;
export const MAX_CRASH_CONTEXT_UNITS = 256;
export const MAX_CRASH_DETAIL_KEY_UNITS = 128;
export const MAX_CRASH_DETAIL_STRING_UNITS = 1024;
export const MAX_CRASH_DETAIL_SCAN_UNITS = 4096;
export const MAX_CRASH_DETAIL_NODES = 128;
export const MAX_CRASH_DETAIL_LEVELS = 4;

const VALID_TEXT_RE = /^(?:[^\u0000\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u;
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
] as const;

export const ErrorSeverity = z.enum(['info', 'warning', 'error'])
  .meta({ title: 'ErrorSeverity' });
export type ErrorSeverity = z.infer<typeof ErrorSeverity>;

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

// Keep arbitrary JSON values unconstrained in the exported JSON Schema so
// quicktype uses its native JSONAny/JsonElement representations. The direct
// Zod contract applies every recursive limit in the refinement below. This
// passthrough schema is deliberate: Zod's record parser omits an own
// `__proto__` key while copying, even though decoded JSON may safely contain
// one. The check retains the decoded/owned snapshot and the refinement below
// validates every key and value without mutating its prototype.
const CrashMetadata = z.unknown()
  .refine((value) => (
    typeof value === 'object'
    && value !== null
    && containerKind(value) === 'object'
  ))
  .meta({
    type: 'object',
    propertyNames: {
      type: 'string',
      maxLength: MAX_CRASH_DETAIL_KEY_UNITS,
      pattern: VALID_TEXT_RE.source,
    },
    additionalProperties: {},
  }) as z.ZodType<JsonObject>;

function metadataWithinTreeLimits(metadata: Record<string, unknown>): boolean {
  let nodes = 0;
  const path = new Set<object>();
  const visit = (value: unknown, containerLevel: number): boolean => {
    nodes += 1;
    if (nodes > MAX_CRASH_DETAIL_NODES) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') {
      return value.length <= MAX_CRASH_DETAIL_STRING_UNITS && VALID_TEXT_RE.test(value);
    }
    if (typeof value !== 'object' || containerLevel > MAX_CRASH_DETAIL_LEVELS || path.has(value)) return false;
    const kind = containerKind(value);
    if (kind === undefined) return false;
    path.add(value);
    try {
      if (kind === 'array') {
        if ((value as unknown[]).length > MAX_CRASH_DETAIL_NODES - 1) return false;
        for (const child of value as unknown[]) {
          const childLevel = child !== null && typeof child === 'object' ? containerLevel + 1 : containerLevel;
          if (!visit(child, childLevel)) return false;
        }
        return true;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key.length > MAX_CRASH_DETAIL_KEY_UNITS || !VALID_TEXT_RE.test(key)) return false;
        const childLevel = child !== null && typeof child === 'object' ? containerLevel + 1 : containerLevel;
        if (!visit(child, childLevel)) return false;
      }
      return true;
    } finally {
      path.delete(value);
    }
  };
  return visit(metadata, 1);
}

const CrashDetailsShape = z.object({
  severity: ErrorSeverity.optional(),
  context: z.string().max(MAX_CRASH_CONTEXT_UNITS).regex(VALID_TEXT_RE).optional(),
  metadata: CrashMetadata.optional(),
  truncated: z.boolean().optional(),
}).strict();

export const CrashDetails = CrashDetailsShape.superRefine((details, ctx) => {
  const metadataIsValid = details.metadata === undefined || metadataWithinTreeLimits(details.metadata);
  if (!metadataIsValid) {
    ctx.addIssue({ code: 'custom', path: ['metadata'], message: 'metadata exceeds crash detail tree limits' });
  }
  // Invalid decoded/owned recursive input can be cyclic or otherwise
  // non-serializable. Its tree issue is sufficient, so serialization is
  // skipped after that failure rather than obscuring the useful tree issue.
  if (metadataIsValid && utf8ByteLength(JSON.stringify(details)) > MAX_CRASH_DETAILS_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'crash details exceed serialized byte limit' });
  }
}).meta({ id: 'CrashDetails', title: 'CrashDetails' });
export type CrashDetails = z.infer<typeof CrashDetails>;

interface ProjectionState {
  nodes: number;
  truncated: boolean;
  readonly redact: (value: string) => string;
  readonly path: Set<object>;
}

interface Projected {
  supported: boolean;
  value?: JsonValue;
}

interface KnownField {
  present: boolean;
  unreadable: boolean;
  value?: unknown;
}

function readKnownField(source: object, key: string): KnownField {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !descriptor.enumerable) return { present: false, unreadable: false };
    if (!('value' in descriptor)) return { present: true, unreadable: true };
    return { present: true, unreadable: false, value: descriptor.value };
  } catch {
    return { present: true, unreadable: true };
  }
}

/** Copy bounded UTF-16, replacing NUL and isolated surrogates. */
function normalizeTextUnits(input: string, limit: number): { value: string; changed: boolean } {
  let value = '';
  let index = 0;
  let changed = false;
  while (index < input.length && index < limit) {
    const current = input.charCodeAt(index);
    if (current === 0) {
      value += '\uFFFD';
      changed = true;
      index += 1;
      continue;
    }
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (index + 1 >= limit) {
          changed = true;
          break;
        }
        value += input[index]! + input[index + 1]!;
        index += 2;
        continue;
      }
      value += '\uFFFD';
      changed = true;
      index += 1;
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) {
      value += '\uFFFD';
      changed = true;
      index += 1;
      continue;
    }
    value += input[index]!;
    index += 1;
  }
  if (index < input.length) changed = true;
  return { value, changed };
}

function redactText(
  input: string,
  outputLimit: number,
  redact: (value: string) => string,
): { supported: boolean; value?: string; truncated: boolean } {
  const scanned = normalizeTextUnits(input, MAX_CRASH_DETAIL_SCAN_UNITS);
  let redacted: unknown;
  try {
    redacted = redact(scanned.value);
  } catch {
    return { supported: false, truncated: true };
  }
  if (typeof redacted !== 'string') return { supported: false, truncated: true };
  const normalized = normalizeTextUnits(redacted, outputLimit);
  return {
    supported: true,
    value: normalized.value,
    truncated: scanned.changed || normalized.changed,
  };
}

function normalizedSensitiveKey(key: string): string {
  let normalized = '';
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) normalized += key[index]!;
    else if (code >= 0x41 && code <= 0x5a) normalized += String.fromCharCode(code + 0x20);
    else if (code >= 0x61 && code <= 0x7a) normalized += key[index]!;
  }
  return normalized;
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedSensitiveKey(key);
  return SENSITIVE_KEY_PARTS.some(part => normalized.includes(part));
}

function containerKind(value: object): 'array' | 'object' | undefined {
  try {
    if (Array.isArray(value)) return 'array';
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return 'object';

    // A foreign realm has a distinct Object.prototype. Recognize that built-in
    // prototype structurally through data descriptors only: its own prototype
    // is null and its constructor's own name is Object. Class-instance
    // prototypes inherit from an Object.prototype instead.
    if (Object.getPrototypeOf(prototype) !== null) return undefined;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function') return undefined;
    const name = Object.getOwnPropertyDescriptor(constructor.value, 'name');
    return name && 'value' in name && name.value === 'Object' ? 'object' : undefined;
  } catch {
    return undefined;
  }
}

function projectConsumedValue(value: unknown, containerLevel: number, state: ProjectionState): Projected {
  if (value === null || typeof value === 'boolean') return { supported: true, value };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { supported: true, value } : { supported: false };
  }
  if (typeof value === 'string') {
    const projected = redactText(value, MAX_CRASH_DETAIL_STRING_UNITS, state.redact);
    if (projected.truncated) state.truncated = true;
    return projected.supported ? { supported: true, value: projected.value! } : { supported: false };
  }
  if (typeof value !== 'object' || value === null) return { supported: false };

  const kind = containerKind(value);
  if (kind === undefined || containerLevel > MAX_CRASH_DETAIL_LEVELS || state.path.has(value)) {
    return { supported: false };
  }
  state.path.add(value);
  try {
    return kind === 'array'
      ? projectArray(value as unknown[], containerLevel, state)
      : projectObject(value as Record<string, unknown>, containerLevel, state);
  } finally {
    state.path.delete(value);
  }
}

function consumeChild(state: ProjectionState): boolean {
  if (state.nodes >= MAX_CRASH_DETAIL_NODES) {
    state.truncated = true;
    return false;
  }
  state.nodes += 1;
  return true;
}

function projectArray(input: unknown[], containerLevel: number, state: ProjectionState): Projected {
  let length: number;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'number') return { supported: false };
    length = descriptor.value;
  } catch {
    return { supported: false };
  }

  const output: JsonValue[] = [];
  for (let index = 0; index < length; index++) {
    if (!consumeChild(state)) break;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    } catch {
      state.truncated = true;
      output.push(null);
      continue;
    }
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      state.truncated = true;
      output.push(null);
      continue;
    }
    const child = descriptor.value;
    const projected = projectConsumedValue(
      child,
      child !== null && typeof child === 'object' ? containerLevel + 1 : containerLevel,
      state,
    );
    if (projected.supported) output.push(projected.value!);
    else {
      state.truncated = true;
      output.push(null);
    }
  }
  if (output.length < length) state.truncated = true;
  return { supported: true, value: output };
}

function projectObject(input: Record<string, unknown>, containerLevel: number, state: ProjectionState): Projected {
  let keys: (string | symbol)[];
  try {
    // ECMAScript own-key discovery materializes the engine's complete key list
    // before user code can stop. Arbitrary Proxy trap work and that engine
    // allocation cannot be bounded here. After this one discovery, the node
    // budget strictly bounds SDK descriptor/value processing and output copies.
    keys = Reflect.ownKeys(input);
  } catch {
    return { supported: false };
  }

  const output = Object.create(null) as JsonObject;
  for (const key of keys) {
    if (!consumeChild(state)) break;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      state.truncated = true;
      continue;
    }
    if (!descriptor || !descriptor.enumerable) continue;
    if (typeof key !== 'string' || !('value' in descriptor)) {
      state.truncated = true;
      continue;
    }
    if (key.length > MAX_CRASH_DETAIL_SCAN_UNITS) {
      state.truncated = true;
      continue;
    }

    const projectedKey = redactText(key, MAX_CRASH_DETAIL_KEY_UNITS, state.redact);
    if (projectedKey.truncated) state.truncated = true;
    if (!projectedKey.supported) {
      state.truncated = true;
      continue;
    }
    const outputKey = projectedKey.value!;
    if (Object.prototype.hasOwnProperty.call(output, outputKey)) {
      state.truncated = true;
      continue;
    }
    if (isSensitiveKey(key)) {
      output[outputKey] = '[REDACTED]';
      continue;
    }
    const child = descriptor.value;
    const projected = projectConsumedValue(
      child,
      child !== null && typeof child === 'object' ? containerLevel + 1 : containerLevel,
      state,
    );
    if (projected.supported) output[outputKey] = projected.value!;
    else state.truncated = true;
  }
  return { supported: true, value: output };
}

function cloneJsonObject(input: JsonObject): JsonObject {
  const output = Object.create(null) as JsonObject;
  for (const key of Object.keys(input)) {
    const value = input[key]!;
    if (Array.isArray(value)) output[key] = cloneJsonArray(value);
    else if (value !== null && typeof value === 'object') output[key] = cloneJsonObject(value);
    else output[key] = value;
  }
  return output;
}

function cloneJsonArray(input: JsonValue[]): JsonValue[] {
  return input.map(value => {
    if (Array.isArray(value)) return cloneJsonArray(value);
    if (value !== null && typeof value === 'object') return cloneJsonObject(value);
    return value;
  });
}

type TrimAction =
  | { kind: 'string'; get: () => string; set: (value: string) => void }
  | { kind: 'remove'; apply: () => void };

function lastTrimAction(value: JsonValue, remove: () => void): TrimAction {
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'remove', apply: remove };
    const index = value.length - 1;
    return lastTrimAction(value[index]!, () => { value.pop(); });
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return { kind: 'remove', apply: remove };
    const key = keys[keys.length - 1]!;
    const child = value[key]!;
    if (typeof child === 'string' && child.length > 0) {
      return {
        kind: 'string',
        get: () => value[key] as string,
        set: replacement => { value[key] = replacement; },
      };
    }
    return lastTrimAction(child, () => { delete value[key]; });
  }
  return { kind: 'remove', apply: remove };
}

function fitMetadataToBytes(details: CrashDetails): void {
  const fits = (): boolean => utf8ByteLength(JSON.stringify(details)) <= MAX_CRASH_DETAILS_BYTES;
  while (details.metadata !== undefined && !fits()) {
    const action = lastTrimAction(details.metadata as JsonObject, () => { delete details.metadata; });
    if (action.kind === 'remove') {
      action.apply();
      continue;
    }
    const original = action.get();
    let low = 0;
    let high = original.length;
    let best: string | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = normalizeTextUnits(original, middle).value;
      action.set(candidate);
      if (fits()) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best !== undefined) {
      action.set(best);
      return;
    }
    action.set('');
  }
}

function projectMetadata(input: unknown, state: ProjectionState): JsonObject | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  if (containerKind(input) !== 'object') return undefined;
  state.nodes = 1;
  state.path.add(input);
  try {
    const projected = projectObject(input as Record<string, unknown>, 1, state);
    return projected.supported ? projected.value as JsonObject : undefined;
  } finally {
    state.path.delete(input);
  }
}

/** Snapshot optional host crash details into the bounded wire representation. */
export function normalizeCrashDetails(
  input: unknown,
  redact: (value: string) => string,
  defaultSeverity?: ErrorSeverity,
): CrashDetails | undefined {
  const state: ProjectionState = { nodes: 0, truncated: false, redact, path: new Set() };
  let source: object | undefined;
  if (input === undefined) source = undefined;
  else if (typeof input === 'object' && input !== null && containerKind(input) === 'object') source = input;
  else {
    source = undefined;
    state.truncated = true;
  }

  let severity: ErrorSeverity | undefined = defaultSeverity;
  let context: string | undefined;
  let metadata: JsonObject | undefined;
  let preserveTruncated = false;

  if (source !== undefined) {
    const severityField = readKnownField(source, 'severity');
    if (severityField.unreadable) state.truncated = true;
    else if (severityField.present && severityField.value !== undefined) {
      const parsed = ErrorSeverity.safeParse(severityField.value);
      if (parsed.success) severity = parsed.data;
      else state.truncated = true;
    }

    const contextField = readKnownField(source, 'context');
    if (contextField.unreadable) state.truncated = true;
    else if (contextField.present && contextField.value !== undefined) {
      if (typeof contextField.value !== 'string') state.truncated = true;
      else {
        const projected = redactText(contextField.value, MAX_CRASH_CONTEXT_UNITS, redact);
        if (projected.truncated) state.truncated = true;
        if (projected.supported) context = projected.value;
        else state.truncated = true;
      }
    }

    const metadataField = readKnownField(source, 'metadata');
    if (metadataField.unreadable) state.truncated = true;
    else if (metadataField.present && metadataField.value !== undefined) {
      metadata = projectMetadata(metadataField.value, state);
      if (metadata === undefined) state.truncated = true;
    }

    const truncatedField = readKnownField(source, 'truncated');
    if (truncatedField.unreadable) state.truncated = true;
    else if (truncatedField.present && truncatedField.value !== undefined) {
      if (typeof truncatedField.value !== 'boolean') state.truncated = true;
      else preserveTruncated = truncatedField.value;
    }
  }

  const details: CrashDetails = {
    ...(severity === undefined ? {} : { severity }),
    ...(context === undefined ? {} : { context }),
    ...(metadata === undefined ? {} : { metadata: cloneJsonObject(metadata) }),
    ...(preserveTruncated || state.truncated ? { truncated: true } : {}),
  };
  if (utf8ByteLength(JSON.stringify(details)) > MAX_CRASH_DETAILS_BYTES) {
    details.truncated = true;
    fitMetadataToBytes(details);
  }
  if (Object.keys(details).length === 0) return undefined;
  return CrashDetails.safeParse(details).success ? details : undefined;
}
