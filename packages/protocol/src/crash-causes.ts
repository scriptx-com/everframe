// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

export const MAX_CRASH_CAUSES = 8;
export const MAX_CRASH_CAUSE_FRAMES = 32;
export const MAX_CRASH_CAUSE_BYTES = 65_536;
export const MAX_CRASH_CAUSE_STACK_SCAN_UNITS = 32_768;
export const MAX_CRASH_CAUSE_TEXT_SCAN_UNITS = 8_192;

const MAX_EXCEPTION_TYPE_UNITS = 256;
const MAX_MESSAGE_UNITS = 4_096;
const MAX_FRAME_RAW_UNITS = 1_024;
const MAX_FRAME_FILE_UNITS = 1_024;
const MAX_FRAME_FUNCTION_UNITS = 512;
const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function isValidWireText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return false;
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index++;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function wireText(max: number) {
  return z.string().max(max).refine(isValidWireText, 'invalid wire text');
}

const CrashCauseFrame = z.object({
  raw: wireText(MAX_FRAME_RAW_UNITS),
  file: wireText(MAX_FRAME_FILE_UNITS).optional(),
  function: wireText(MAX_FRAME_FUNCTION_UNITS).optional(),
  line: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  col: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).meta({ id: 'CrashCauseFrame', title: 'CrashCauseFrame' });

export const CrashCause = z.object({
  exceptionType: wireText(MAX_EXCEPTION_TYPE_UNITS),
  message: wireText(MAX_MESSAGE_UNITS),
  frames: z.array(CrashCauseFrame).max(MAX_CRASH_CAUSE_FRAMES),
  framesTruncated: z.boolean(),
}).meta({ id: 'CrashCause', title: 'CrashCause' });
export type CrashCause = z.infer<typeof CrashCause>;

export const CrashCauseChain = z.object({
  causes: z.array(CrashCause).max(MAX_CRASH_CAUSES),
  truncated: z.boolean(),
}).superRefine((value, context) => {
  if (utf8Bytes(JSON.stringify(value)) > MAX_CRASH_CAUSE_BYTES) {
    context.addIssue({ code: 'custom', message: 'crash cause chain exceeds byte limit' });
  }
}).meta({ id: 'CrashCauseChain', title: 'CrashCauseChain' });
export type CrashCauseChain = z.infer<typeof CrashCauseChain>;

export type CauseFitResult = 'accepted' | 'exhausted' | 'discarded';
export type CauseFrameFitResult = CauseFitResult | 'frames_full';

export interface CrashCauseHeader {
  exceptionType: string;
  message: string;
  framesTruncated: boolean;
}

export interface CrashCauseFrameInput {
  raw: string;
  file?: string;
  function?: string;
  line?: number;
  col?: number;
}

export interface CrashCauseChainFitter {
  beginCause(header: CrashCauseHeader): CauseFitResult;
  appendFrame(frame: CrashCauseFrameInput): CauseFrameFitResult;
  markChainTruncated(): void;
  markFramesTruncated(): void;
  finish(): CrashCauseChain | undefined;
}

type OwnRead =
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false };

function ownData(
  input: object,
  key: PropertyKey,
  stillOwned: () => boolean,
): OwnRead {
  try {
    if (!stillOwned()) return { ok: false };
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!stillOwned()) return { ok: false };
    if (!descriptor) return { ok: true, present: false };
    if (!('value' in descriptor)) return { ok: false };
    return { ok: true, present: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function safeOwned(stillOwned: () => boolean): boolean {
  try {
    return stillOwned();
  } catch {
    return false;
  }
}

function prefixWithoutSplit(value: string, limit: number): { value: string; lost: boolean } {
  if (value.length <= limit) return { value, lost: false };
  let end = limit;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--;
  return { value: value.slice(0, end), lost: true };
}

function repairText(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) {
      output += '\uFFFD';
    } else if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += value.charAt(index) + value.charAt(index + 1);
        index++;
      } else {
        output += '\uFFFD';
      }
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      output += '\uFFFD';
    } else {
      output += value.charAt(index);
    }
  }
  return output;
}

interface NormalizedText {
  value: string;
  lost: boolean;
}

interface MutableCause extends CrashCause {
  frames: z.infer<typeof CrashCauseFrame>[];
}

interface CauseState {
  cause: MutableCause;
  reservedBytes: number;
  framesClosed: boolean;
}

const EMPTY_CHAIN_RESERVED_BYTES = utf8Bytes('{"causes":[],"truncated":false}');

export function createCrashCauseChainFitter(
  redact: (value: string) => string,
  stillOwned: () => boolean = () => true,
): CrashCauseChainFitter {
  let mode: 'active' | 'exhausted' | 'discarded' = 'active';
  let sealed = false;
  let sealedResult: CrashCauseChain | undefined;
  let chainTruncated = false;
  const causes: CauseState[] = [];
  let current: CauseState | undefined;
  let reservedBytes = EMPTY_CHAIN_RESERVED_BYTES;

  const discard = (): 'discarded' => {
    if (!sealed) {
      mode = 'discarded';
      causes.length = 0;
      current = undefined;
    }
    return 'discarded';
  };

  const normalizeText = (value: unknown, cap: number): NormalizedText | undefined => {
    if (typeof value !== 'string' || !safeOwned(stillOwned)) return undefined;
    const scanned = prefixWithoutSplit(value, MAX_CRASH_CAUSE_TEXT_SCAN_UNITS);
    const repairedInput = repairText(scanned.value);
    let redacted: unknown;
    try {
      if (!safeOwned(stillOwned)) return undefined;
      redacted = redact(repairedInput);
      if (!safeOwned(stillOwned)) return undefined;
    } catch {
      return undefined;
    }
    if (typeof redacted !== 'string') return undefined;
    const probe = prefixWithoutSplit(redacted, cap + 1);
    const repairedOutput = repairText(probe.value);
    const capped = prefixWithoutSplit(repairedOutput, cap);
    return {
      value: capped.value,
      lost: scanned.lost || redacted.length > cap || capped.lost,
    };
  };

  const terminalResult = (): CauseFitResult | undefined => {
    if (sealed) return 'discarded';
    if (mode === 'discarded') return 'discarded';
    if (mode === 'exhausted') return 'exhausted';
    return undefined;
  };

  const beginCause = (header: CrashCauseHeader): CauseFitResult => {
    const terminal = terminalResult();
    if (terminal) return terminal;
    if (causes.length >= MAX_CRASH_CAUSES) {
      chainTruncated = true;
      mode = 'exhausted';
      return 'exhausted';
    }
    if (!isObject(header) || !safeOwned(stillOwned)) return discard();
    const exceptionTypeRead = ownData(header, 'exceptionType', stillOwned);
    const messageRead = ownData(header, 'message', stillOwned);
    const framesTruncatedRead = ownData(header, 'framesTruncated', stillOwned);
    if (!exceptionTypeRead.ok || !exceptionTypeRead.present
      || !messageRead.ok || !messageRead.present
      || !framesTruncatedRead.ok || !framesTruncatedRead.present
      || typeof framesTruncatedRead.value !== 'boolean') return discard();
    const exceptionType = normalizeText(exceptionTypeRead.value, MAX_EXCEPTION_TYPE_UNITS);
    if (!exceptionType) return discard();
    const message = normalizeText(messageRead.value, MAX_MESSAGE_UNITS);
    if (!message) return discard();
    const cause: MutableCause = {
      exceptionType: exceptionType.value,
      message: message.value,
      frames: [],
      framesTruncated: framesTruncatedRead.value,
    };
    const headerReserved = JSON.stringify({ ...cause, framesTruncated: false });
    const causeBytes = utf8Bytes(headerReserved);
    const candidateBytes = reservedBytes + causeBytes + (causes.length > 0 ? 1 : 0);
    if (candidateBytes > MAX_CRASH_CAUSE_BYTES) {
      chainTruncated = true;
      mode = 'exhausted';
      return 'exhausted';
    }
    current = { cause, reservedBytes: causeBytes, framesClosed: false };
    causes.push(current);
    reservedBytes = candidateBytes;
    if (exceptionType.lost || message.lost) chainTruncated = true;
    return 'accepted';
  };

  const appendFrame = (frame: CrashCauseFrameInput): CauseFrameFitResult => {
    const terminal = terminalResult();
    if (terminal) return terminal;
    if (!current) return discard();
    if (current.framesClosed || current.cause.frames.length >= MAX_CRASH_CAUSE_FRAMES) {
      current.cause.framesTruncated = true;
      current.framesClosed = true;
      return 'frames_full';
    }
    if (!isObject(frame) || !safeOwned(stillOwned)) return discard();
    const rawRead = ownData(frame, 'raw', stillOwned);
    if (!rawRead.ok || !rawRead.present) return discard();
    const raw = normalizeText(rawRead.value, MAX_FRAME_RAW_UNITS);
    if (!raw) return discard();
    const normalized: z.infer<typeof CrashCauseFrame> = { raw: raw.value };
    let textLost = raw.lost;
    for (const [key, cap] of [
      ['file', MAX_FRAME_FILE_UNITS],
      ['function', MAX_FRAME_FUNCTION_UNITS],
    ] as const) {
      const read = ownData(frame, key, stillOwned);
      if (!read.ok) return discard();
      if (!read.present) continue;
      const value = normalizeText(read.value, cap);
      if (!value) return discard();
      normalized[key] = value.value;
      textLost ||= value.lost;
    }
    for (const key of ['line', 'col'] as const) {
      const read = ownData(frame, key, stillOwned);
      if (!read.ok) return discard();
      if (!read.present) continue;
      if (typeof read.value !== 'number' || !Number.isSafeInteger(read.value) || read.value < 0) {
        return discard();
      }
      normalized[key] = read.value;
    }
    const frameJson = JSON.stringify(normalized);
    const addedBytes = utf8Bytes(frameJson) + (current.cause.frames.length > 0 ? 1 : 0);
    if (reservedBytes + addedBytes > MAX_CRASH_CAUSE_BYTES) {
      current.cause.framesTruncated = true;
      current.framesClosed = true;
      chainTruncated = true;
      mode = 'exhausted';
      return 'exhausted';
    }
    current.cause.frames.push(normalized);
    current.reservedBytes += addedBytes;
    reservedBytes += addedBytes;
    if (textLost) current.cause.framesTruncated = true;
    return 'accepted';
  };

  const markChainTruncated = (): void => {
    if (sealed || mode === 'discarded') return;
    chainTruncated = true;
  };

  const markFramesTruncated = (): void => {
    if (sealed || mode === 'discarded') return;
    if (!current) {
      discard();
      return;
    }
    current.cause.framesTruncated = true;
  };

  const finish = (): CrashCauseChain | undefined => {
    if (sealed) return sealedResult;
    if (mode === 'discarded' || !safeOwned(stillOwned)) {
      mode = 'discarded';
      sealed = true;
      sealedResult = undefined;
      return undefined;
    }
    const result: CrashCauseChain = {
      causes: causes.map(({ cause }) => ({
        exceptionType: cause.exceptionType,
        message: cause.message,
        frames: cause.frames.map(frame => ({ ...frame })),
        framesTruncated: cause.framesTruncated,
      })),
      truncated: chainTruncated,
    };
    const finalBytes = utf8Bytes(JSON.stringify(result));
    const trueFlags = (result.truncated ? 1 : 0)
      + result.causes.reduce((count, cause) => count + (cause.framesTruncated ? 1 : 0), 0);
    if (finalBytes > MAX_CRASH_CAUSE_BYTES || reservedBytes - finalBytes !== trueFlags) {
      mode = 'discarded';
      sealed = true;
      sealedResult = undefined;
      return undefined;
    }
    sealed = true;
    sealedResult = result;
    return result;
  };

  return { beginCause, appendFrame, markChainTruncated, markFramesTruncated, finish };
}

function readArrayLength(array: unknown[], stillOwned: () => boolean): number | undefined {
  const read = ownData(array, 'length', stillOwned);
  return read.ok && read.present && typeof read.value === 'number'
    && Number.isSafeInteger(read.value) && read.value >= 0
    ? read.value
    : undefined;
}

function requiredOwn(input: object, key: string, stillOwned: () => boolean): unknown | undefined {
  const read = ownData(input, key, stillOwned);
  return read.ok && read.present ? read.value : undefined;
}

export function normalizeCrashCauseChain(
  input: unknown,
  redact: (value: string) => string,
  stillOwned: () => boolean = () => true,
): CrashCauseChain | undefined {
  if (!isObject(input) || !safeOwned(stillOwned)) return undefined;
  const causesValue = requiredOwn(input, 'causes', stillOwned);
  const truncatedValue = requiredOwn(input, 'truncated', stillOwned);
  if (!isArray(causesValue) || typeof truncatedValue !== 'boolean') return undefined;
  const causeLength = readArrayLength(causesValue, stillOwned);
  if (causeLength === undefined) return undefined;
  const fitter = createCrashCauseChainFitter(redact, stillOwned);
  if (truncatedValue || causeLength > MAX_CRASH_CAUSES) fitter.markChainTruncated();

  const causeLimit = Math.min(causeLength, MAX_CRASH_CAUSES);
  for (let causeIndex = 0; causeIndex < causeLimit; causeIndex++) {
    const causeRead = ownData(causesValue, String(causeIndex), stillOwned);
    if (!causeRead.ok || !causeRead.present || !isObject(causeRead.value)) {
      fitter.markChainTruncated();
      break;
    }
    const exceptionType = requiredOwn(causeRead.value, 'exceptionType', stillOwned);
    const message = requiredOwn(causeRead.value, 'message', stillOwned);
    const framesTruncated = requiredOwn(causeRead.value, 'framesTruncated', stillOwned);
    if (typeof exceptionType !== 'string' || typeof message !== 'string'
      || typeof framesTruncated !== 'boolean') {
      fitter.markChainTruncated();
      break;
    }
    const began = fitter.beginCause({ exceptionType, message, framesTruncated });
    if (began === 'discarded' || began === 'exhausted') return fitter.finish();
    const framesValue = requiredOwn(causeRead.value, 'frames', stillOwned);
    if (!isArray(framesValue)) {
      fitter.markFramesTruncated();
      continue;
    }
    const frameLength = readArrayLength(framesValue, stillOwned);
    if (frameLength === undefined) {
      fitter.markFramesTruncated();
      continue;
    }
    if (frameLength > MAX_CRASH_CAUSE_FRAMES) fitter.markFramesTruncated();
    const frameLimit = Math.min(frameLength, MAX_CRASH_CAUSE_FRAMES);
    for (let frameIndex = 0; frameIndex < frameLimit; frameIndex++) {
      const frameRead = ownData(framesValue, String(frameIndex), stillOwned);
      if (!frameRead.ok || !frameRead.present || !isObject(frameRead.value)) {
        fitter.markFramesTruncated();
        break;
      }
      const raw = requiredOwn(frameRead.value, 'raw', stillOwned);
      if (typeof raw !== 'string') {
        fitter.markFramesTruncated();
        break;
      }
      const projected: CrashCauseFrameInput = { raw };
      let optionalLoss = false;
      for (const key of ['file', 'function'] as const) {
        const read = ownData(frameRead.value, key, stillOwned);
        if (!read.ok) {
          optionalLoss = true;
        } else if (read.present) {
          if (typeof read.value === 'string') projected[key] = read.value;
          else optionalLoss = true;
        }
      }
      for (const key of ['line', 'col'] as const) {
        const read = ownData(frameRead.value, key, stillOwned);
        if (!read.ok) {
          optionalLoss = true;
        } else if (read.present) {
          if (typeof read.value === 'number' && Number.isSafeInteger(read.value) && read.value >= 0) {
            projected[key] = read.value;
          } else {
            optionalLoss = true;
          }
        }
      }
      if (optionalLoss) fitter.markFramesTruncated();
      const appended = fitter.appendFrame(projected);
      if (appended === 'discarded' || appended === 'exhausted') return fitter.finish();
      if (appended === 'frames_full') break;
    }
  }
  return fitter.finish();
}

function projectStrict(input: unknown): CrashCauseChain | undefined {
  const owned = () => true;
  if (!isObject(input)) return undefined;
  const causesValue = requiredOwn(input, 'causes', owned);
  const truncated = requiredOwn(input, 'truncated', owned);
  if (!isArray(causesValue) || typeof truncated !== 'boolean') return undefined;
  const causeLength = readArrayLength(causesValue, owned);
  if (causeLength === undefined || causeLength > MAX_CRASH_CAUSES) return undefined;
  const causes: CrashCause[] = [];
  for (let causeIndex = 0; causeIndex < causeLength; causeIndex++) {
    const causeRead = ownData(causesValue, String(causeIndex), owned);
    if (!causeRead.ok || !causeRead.present || !isObject(causeRead.value)) return undefined;
    const exceptionType = requiredOwn(causeRead.value, 'exceptionType', owned);
    const message = requiredOwn(causeRead.value, 'message', owned);
    const framesValue = requiredOwn(causeRead.value, 'frames', owned);
    const framesTruncated = requiredOwn(causeRead.value, 'framesTruncated', owned);
    if (typeof exceptionType !== 'string' || typeof message !== 'string'
      || !isArray(framesValue) || typeof framesTruncated !== 'boolean') return undefined;
    const frameLength = readArrayLength(framesValue, owned);
    if (frameLength === undefined || frameLength > MAX_CRASH_CAUSE_FRAMES) return undefined;
    const frames: z.infer<typeof CrashCauseFrame>[] = [];
    for (let frameIndex = 0; frameIndex < frameLength; frameIndex++) {
      const frameRead = ownData(framesValue, String(frameIndex), owned);
      if (!frameRead.ok || !frameRead.present || !isObject(frameRead.value)) return undefined;
      const raw = requiredOwn(frameRead.value, 'raw', owned);
      if (typeof raw !== 'string') return undefined;
      const frame: z.infer<typeof CrashCauseFrame> = { raw };
      for (const key of ['file', 'function'] as const) {
        const read = ownData(frameRead.value, key, owned);
        if (!read.ok) return undefined;
        if (read.present) {
          if (typeof read.value !== 'string') return undefined;
          frame[key] = read.value;
        }
      }
      for (const key of ['line', 'col'] as const) {
        const read = ownData(frameRead.value, key, owned);
        if (!read.ok) return undefined;
        if (read.present) {
          if (typeof read.value !== 'number') return undefined;
          frame[key] = read.value;
        }
      }
      frames.push(frame);
    }
    causes.push({ exceptionType, message, frames, framesTruncated });
  }
  return { causes, truncated };
}

export function parseCrashCauseChain(input: unknown): CrashCauseChain | undefined {
  const projected = projectStrict(input);
  if (!projected) return undefined;
  const parsed = CrashCauseChain.safeParse(projected);
  return parsed.success ? parsed.data : undefined;
}
