// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Bounded fact extraction from thrown values. Same rules as
// packages/sdk-react-native/src/error-facts.ts — keep the two in step:
// never invoke toJSON or coercion hooks, bound every scan, and render
// non-Error rejection reasons as a type label only (rejected values are often
// HTTP responses or request configs carrying URLs, headers and tokens).
const MAX_TYPE = 256;
const MAX_MESSAGE = 4096;
const MAX_FRAMES = 256;
const MAX_RAW = 1024;
const MAX_STACK_SCAN = (MAX_FRAMES + 1) * (MAX_RAW + 1);
const MAX_VALUE_NODES = 64;
const MAX_VALUE_DEPTH = 4;

export interface ErrorFacts {
  exceptionType: string;
  message: string;
  framesRaw: string[];
}

function read(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

/** Incremental, bounded rendering of a thrown non-Error value. */
export function renderValue(value: unknown): string {
  let output = '';
  let nodes = 0;
  const seen = new WeakSet<object>();
  const append = (text: string) => {
    output += text.slice(0, MAX_MESSAGE - output.length);
  };
  const quote = (text: string) => JSON.stringify(text.slice(0, MAX_MESSAGE));
  function visit(item: unknown, depth: number, nested: boolean): void {
    if (output.length >= MAX_MESSAGE) return;
    if (++nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) {
      append('"[Truncated]"');
      return;
    }
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'function') return append('[Function]');
      if (typeof item === 'symbol') return append('[Symbol]');
      if (typeof item === 'bigint') return append('[BigInt]');
      const text = typeof item === 'string' ? item.slice(0, MAX_MESSAGE) : String(item);
      append(nested && typeof item === 'string' ? quote(text) : text);
      return;
    }
    if (seen.has(item)) return append('"[Circular]"');
    seen.add(item);
    try {
      let first = true;
      if (Array.isArray(item)) {
        append('[');
        const length = read(item, 'length');
        const count = typeof length === 'number' ? Math.min(length, MAX_VALUE_NODES) : 0;
        for (let i = 0; i < count && nodes < MAX_VALUE_NODES && output.length < MAX_MESSAGE; i++) {
          if (!first) append(',');
          first = false;
          visit(read(item, i), depth + 1, true);
        }
        append(']');
      } else {
        append('{');
        let enumerated = 0;
        for (const key in item) {
          if (++enumerated > MAX_VALUE_NODES || nodes >= MAX_VALUE_NODES || output.length >= MAX_MESSAGE) break;
          if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
          if (!first) append(',');
          first = false;
          append(quote(key));
          append(':');
          visit(read(item, key), depth + 1, true);
        }
        append('}');
      }
    } catch {
      append('[Unrenderable]');
    }
  }
  try {
    visit(value, 0, false);
  } catch {
    append('[Unrenderable]');
  }
  return output;
}

const numberToString = Number.prototype.toString;

/** Keeps bounded primitives; never reads properties or serializes contents. */
export function renderLabel(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return value.slice(0, MAX_MESSAGE);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return numberToString.call(value);
    case 'bigint':
      return '[bigint]';
    case 'symbol':
      return '[symbol]';
    case 'function':
      return '[function]';
    default:
      return '[object]';
  }
}

export function isErrorValue(value: unknown): boolean {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

export function extractFacts(value: unknown, renderOther: (value: unknown) => string = renderValue): ErrorFacts {
  if (!isErrorValue(value)) return { exceptionType: 'UnhandledValue', message: renderOther(value), framesRaw: [] };
  const error = value as object;
  const name = read(error, 'name');
  const exceptionType = typeof name === 'string' && name ? name.slice(0, MAX_TYPE) : 'Error';
  const messageValue = read(error, 'message');
  const message = messageValue == null ? '' : renderValue(messageValue);
  const stackValue = read(error, 'stack');
  const stack = typeof stackValue === 'string' ? stackValue.slice(0, MAX_STACK_SCAN) : '';
  const framesRaw: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < stack.length && framesRaw.length < MAX_FRAMES) {
    const newline = stack.indexOf('\n', offset);
    const end = newline < 0 ? stack.length : newline;
    const line = stack.slice(offset, Math.min(end, offset + MAX_RAW)).trim();
    offset = end + 1;
    if (!line) continue;
    const header =
      first &&
      (line === exceptionType ||
        line.startsWith(`${exceptionType}:`) ||
        (exceptionType.length === MAX_TYPE && line.startsWith(exceptionType)));
    first = false;
    if (!header) framesRaw.push(line);
  }
  return { exceptionType, message, framesRaw };
}
