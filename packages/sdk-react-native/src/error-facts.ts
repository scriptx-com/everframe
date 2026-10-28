// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Facts only: native redaction and post-redaction limits remain authoritative.
const MAX_TYPE = 256;
const MAX_MESSAGE = 4096;
const MAX_FRAMES = 256;
const MAX_RAW = 1024;
const MAX_STACK_SCAN = (MAX_FRAMES + 1) * (MAX_RAW + 1);
const MAX_VALUE_NODES = 64;
const MAX_VALUE_DEPTH = 4;
let bigintRenderLimit: bigint | undefined;

function read(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

/** Incremental, bounded rendering; never invokes toJSON or object coercion hooks. */
function renderValue(value: unknown): string {
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
      if (typeof item === 'function') {
        append('[Function]');
        return;
      }
      if (typeof item === 'symbol') {
        append(`Symbol(${(item.description ?? '').slice(0, MAX_MESSAGE - 8)})`);
        return;
      }
      if (typeof item === 'bigint') {
        // Only resolve BigInt on an engine that has actually supplied one.
        bigintRenderLimit ??= BigInt(10) ** BigInt(MAX_MESSAGE);
        if (item >= bigintRenderLimit || item <= -bigintRenderLimit) {
          append('[BigInt exceeds message limit]');
          return;
        }
      }
      // Primitive coercion cannot invoke host object hooks. Bound strings before escaping.
      const text = typeof item === 'string' ? item.slice(0, MAX_MESSAGE) : String(item);
      append(nested && typeof item === 'string' ? quote(text) : text);
      return;
    }
    if (seen.has(item)) {
      append('"[Circular]"');
      return;
    }
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
        // Avoid materializing Object.keys/entries and stop consuming keys even
        // for inherited fields. Host proxy ownKeys/getters themselves can do
        // arbitrary work; JS cannot impose a time bound on host code.
        for (const key in item) {
          if (
            ++enumerated > MAX_VALUE_NODES ||
            nodes >= MAX_VALUE_NODES ||
            output.length >= MAX_MESSAGE
          )
            break;
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
/** Keeps bounded primitives; never reads properties, coerces objects or serializes contents. */
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

/** A bounded string field of a native frame, or '' for anything else. */
function frameText(frame: object, key: string): string {
  const value = read(frame, key);
  return typeof value === 'string' ? value.slice(0, MAX_RAW) : '';
}

/** The array a native stack field holds, bounded, or [] for anything else (a hostile value included). */
function boundedItems(error: object, key: string): unknown[] {
  try {
    const value = read(error, key);
    if (!Array.isArray(value)) return [];
    const length = read(value, 'length');
    const count = typeof length === 'number' ? Math.min(length, MAX_FRAMES) : 0;
    const items: unknown[] = [];
    for (let i = 0; i < count; i++) items.push(read(value, i));
    return items;
  } catch {
    return [];
  }
}

/** A JVM frame as the JVM writes a stack line: `at class.method(File.java:12)`. */
function androidLine(frame: unknown): string | null {
  if (!frame || typeof frame !== 'object') return null;
  const owner = frameText(frame, 'class');
  const method = frameText(frame, 'methodName');
  if (!owner && !method) return null;
  const file = frameText(frame, 'file');
  const line = read(frame, 'lineNumber');
  const location =
    line === -2
      ? 'Native Method'
      : file
        ? typeof line === 'number' && Number.isInteger(line) && line >= 0
          ? `${file}:${line}`
          : file
        : 'Unknown Source';
  return `at ${owner}.${method}(${location})`.slice(0, MAX_RAW);
}

/**
 * An iOS callStackSymbols line without the addresses that change every launch. The image column
 * may hold spaces (`Native Probe`), so the load address is the first `0x` token after it. An
 * unsymbolicated frame names its image's base address instead of a symbol (`0x104a00000 +
 * 115432`): it reads as the image and its offset (`MyApp + 115432`), as crash reports write it.
 */
function iosLine(frame: unknown): string | null {
  if (typeof frame !== 'string') return null;
  const text = frame.slice(0, MAX_RAW);
  if (text.trim() === '') return null;
  const line = text.replace(/^(\s*\d+\s+.+?\s)0x[0-9a-fA-F]+\s+/, '$1').trim();
  const unsymbolicated = /^(\d+\s+)(.+?)(\s+)0x[0-9a-fA-F]+(\s+\+\s+\d+)$/.exec(line);
  return unsymbolicated
    ? `${unsymbolicated[1]}${unsymbolicated[2]}${unsymbolicated[3]}${unsymbolicated[2]}${unsymbolicated[4]}`
    : line;
}

/**
 * The native stack React Native attaches to a failed native-module call. React Native builds that
 * error from native code, so its JavaScript stack names no frames, and the failure (Notifee's, on
 * Mware TV, October 2026) arrived with none. Android sends `nativeStackAndroid` ({class,
 * methodName, file, lineNumber}); iOS sends `nativeStackIOS` (callStackSymbols at the rejection).
 */
function nativeStackLines(error: object): string[] {
  const android = boundedItems(error, 'nativeStackAndroid').map(androidLine);
  const lines = android.some((line) => line !== null)
    ? android
    : boundedItems(error, 'nativeStackIOS').map(iosLine);
  return lines.filter((line): line is string => line !== null);
}

export function extractFacts(
  value: unknown,
  renderOther: (value: unknown) => string = renderValue,
): { exceptionType: string; message: string; framesRaw: string[] } {
  let isError = false;
  try {
    isError = value instanceof Error;
  } catch {
    /* hostile proxy */
  }
  if (!isError)
    return { exceptionType: 'UnhandledValue', message: renderOther(value), framesRaw: [] };
  const error = value as object;
  const name = read(error, 'name');
  const exceptionType = typeof name === 'string' && name ? name.slice(0, MAX_TYPE) : 'Error';
  const messageValue = read(error, 'message');
  const message = messageValue == null ? '' : renderValue(messageValue);
  const stackValue = read(error, 'stack');
  // Bound scanning and copying before parsing; never split the full host stack.
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
  // Only when JavaScript named no frame: a JavaScript stack says where the app called from.
  if (framesRaw.length === 0) framesRaw.push(...nativeStackLines(error));
  return { exceptionType, message, framesRaw };
}
