// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  CrashCauseChain,
  MAX_CRASH_CAUSES,
  MAX_CRASH_CAUSE_BYTES,
  MAX_CRASH_CAUSE_FRAMES,
  createCrashCauseChainFitter,
  normalizeCrashCauseChain,
  parseCrashCauseChain,
} from '../src/index.js';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CrashPayload } from '../src/crash.js';

const rootCause = () => ({
  exceptionType: 'TypeError',
  message: 'underlying',
  frames: [{ raw: 'at root (https://fixture.test/a.js:1:7)' }],
  framesTruncated: false,
});

describe('generic crash cause contract', () => {
  it('parses the canonical shared native crash fixture', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'crash-causes.json'), 'utf8'));
    const parsed = CrashPayload.parse(fixture);
    expect(parsed.causeChain?.causes.map(cause => cause.exceptionType))
      .toEqual(['TypeError', 'RangeError']);
    expect(parsed.causeChain?.causes[0]?.frames[0]).toEqual({
      raw: 'at middle (https://fixture.test/middle.js:11:7)',
      file: 'https://fixture.test/middle.js',
      function: 'middle',
      line: 11,
      col: 7,
    });
  });

  it('accepts the complete required wire shape and preserves an owned snapshot', () => {
    const cause = rootCause();
    const input = { causes: [cause], truncated: false };

    const normalized = normalizeCrashCauseChain(input, value => value);

    expect(normalized).toEqual(input);
    expect(CrashCauseChain.safeParse(input).success).toBe(true);
    cause.message = 'later mutation';
    expect(normalized?.causes[0]?.message).toBe('underlying');
  });

  it('requires wrapper flags and never salvages a malformed strict-reader chain', () => {
    const cause = rootCause();

    expect(normalizeCrashCauseChain(undefined, value => value)).toBeUndefined();
    expect(normalizeCrashCauseChain({ causes: [cause] }, value => value)).toBeUndefined();
    expect(parseCrashCauseChain({ causes: [cause, null], truncated: false })).toBeUndefined();
  });

  it('keeps only the valid causal prefix when tolerant input becomes malformed', () => {
    const cause = rootCause();

    expect(normalizeCrashCauseChain(
      { causes: [cause, null, cause], truncated: false },
      value => value,
    )).toEqual({ causes: [cause], truncated: true });
  });

  it('does not inspect frames when a later header cannot fit', () => {
    const retained = {
      ...rootCause(),
      frames: Array.from({ length: 24 }, () => ({
        raw: 'r'.repeat(1024),
        file: 'f'.repeat(1024),
        function: 'n'.repeat(512),
      })),
    };
    let framesDescriptorReads = 0;
    const exhausted = new Proxy({
      exceptionType: 'Inner',
      message: '\\'.repeat(4096),
      frames: [],
      framesTruncated: false,
    }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'frames') {
          framesDescriptorReads += 1;
          throw new Error('frames inspected before header admission');
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const normalized = normalizeCrashCauseChain({
      causes: [retained, exhausted],
      truncated: false,
    }, value => value);

    expect(framesDescriptorReads).toBe(0);
    expect(normalized?.causes).toEqual([retained]);
    expect(normalized?.truncated).toBe(true);
  });

  it('does not inspect frames on a malformed header', () => {
    let framesDescriptorReads = 0;
    const malformed = new Proxy({
      exceptionType: 7,
      message: 'bad',
      frames: [],
      framesTruncated: false,
    }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'frames') {
          framesDescriptorReads += 1;
          throw new Error('frames inspected for malformed header');
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(normalizeCrashCauseChain({
      causes: [rootCause(), malformed, rootCause()],
      truncated: false,
    }, value => value)).toEqual({ causes: [rootCause()], truncated: true });
    expect(framesDescriptorReads).toBe(0);
  });

  it('redacts each admitted header once and lets text loss admit later causes', () => {
    let redactions = 0;
    const fitter = createCrashCauseChainFitter(value => {
      redactions += 1;
      return value;
    });

    expect(fitter.beginCause({
      exceptionType: 'Error',
      message: 'x'.repeat(4097),
      framesTruncated: false,
    })).toBe('accepted');
    const afterFirstHeader = redactions;
    expect(fitter.beginCause({
      exceptionType: 'TypeError',
      message: 'inner',
      framesTruncated: false,
    })).toBe('accepted');

    expect(redactions - afterFirstHeader).toBe(2);
    expect(fitter.finish()?.truncated).toBe(true);
  });

  it('strips extension keys at every level and never invokes unknown accessors or toJSON', () => {
    let calls = 0;
    const frame = { raw: 'at root', futureFrame: true };
    Object.defineProperty(frame, 'unknownAccessor', { enumerable: true, get: () => { calls++; } });
    const cause = {
      ...rootCause(),
      frames: [frame],
      futureCause: true,
      toJSON: () => { calls++; return {}; },
    };
    const input = { causes: [cause], truncated: false, futureWrapper: true };

    expect(normalizeCrashCauseChain(input, value => value)).toEqual({
      causes: [{ ...rootCause(), frames: [{ raw: 'at root' }] }],
      truncated: false,
    });
    expect(parseCrashCauseChain(input)).toEqual({
      causes: [{ ...rootCause(), frames: [{ raw: 'at root' }] }],
      truncated: false,
    });
    expect(calls).toBe(0);
  });

  it('repairs invalid text without raw fallback and preserves valid surrogate pairs', () => {
    const normalized = normalizeCrashCauseChain({
      causes: [{
        exceptionType: 'Err\0or',
        message: `a\uD800😀`,
        frames: [{ raw: `r\uDC00😀` }],
        framesTruncated: false,
      }],
      truncated: false,
    }, value => value);

    expect(normalized).toEqual({
      causes: [{
        exceptionType: 'Err�or',
        message: 'a�😀',
        frames: [{ raw: 'r�😀' }],
        framesTruncated: false,
      }],
      truncated: false,
    });
    expect(CrashCauseChain.safeParse(normalized).success).toBe(true);
  });

  it('omits the whole optional chain when redaction throws or returns a non-string', () => {
    const input = { causes: [rootCause()], truncated: false };
    expect(normalizeCrashCauseChain(input, () => { throw new Error('mask failed'); }))
      .toBeUndefined();
    expect(normalizeCrashCauseChain(input, () => 42 as never)).toBeUndefined();
  });

  it('stops header redaction after the first field fails', () => {
    let calls = 0;
    const fitter = createCrashCauseChainFitter(value => {
      calls += 1;
      return calls === 1 ? 42 as never : value;
    });

    expect(fitter.beginCause({
      exceptionType: 'Error',
      message: 'must-not-be-redacted',
      framesTruncated: false,
    })).toBe('discarded');
    expect(calls).toBe(1);
    expect(fitter.finish()).toBeUndefined();
  });

  it('uses one shared escaped-Unicode policy for helper and incremental fitting', () => {
    const input = {
      causes: [{
        exceptionType: 'Type"\\Error',
        message: 'line\n😀',
        frames: [{
          raw: 'at "root"\\next\t😀',
          file: 'https://fixture.test/a\\b.js',
          function: 'run😀',
          line: 1,
          col: 0,
        }],
        framesTruncated: false,
      }],
      truncated: false,
    };
    const cause = input.causes[0]!;
    const frame = cause.frames[0]!;
    let helperRedactions = 0;
    const helper = normalizeCrashCauseChain(input, value => { helperRedactions++; return value; });
    let incrementalRedactions = 0;
    const fitter = createCrashCauseChainFitter(value => { incrementalRedactions++; return value; });
    expect(fitter.beginCause({
      exceptionType: cause.exceptionType,
      message: cause.message,
      framesTruncated: false,
    })).toBe('accepted');
    expect(fitter.appendFrame(frame)).toBe('accepted');
    const incremental = fitter.finish();

    expect(incremental).toEqual(helper);
    expect(Buffer.byteLength(JSON.stringify(incremental), 'utf8'))
      .toBe(Buffer.byteLength(JSON.stringify(helper), 'utf8'));
    expect(helperRedactions).toBe(5);
    expect(incrementalRedactions).toBe(5);
  });

  it('bounds scan and expanding-redactor output without splitting astral pairs', () => {
    let redactorInputLength = 0;
    const normalized = normalizeCrashCauseChain({
      causes: [{
        exceptionType: 'Error',
        message: 'x'.repeat(9_000),
        frames: [],
        framesTruncated: false,
      }],
      truncated: false,
    }, value => {
      if (value.startsWith('x')) redactorInputLength = value.length;
      return value.startsWith('x') ? `${'y'.repeat(4095)}😀tail` : value;
    });

    expect(redactorInputLength).toBe(8_192);
    expect(normalized?.causes[0]?.message).toBe('y'.repeat(4095));
    expect(normalized?.truncated).toBe(true);
    expect(CrashCauseChain.safeParse(normalized).success).toBe(true);
  });

  it('keeps a valid frame prefix, omits malformed optional fields, and permits the next cause', () => {
    const second = { ...rootCause(), exceptionType: 'InnerError', frames: [] };
    const normalized = normalizeCrashCauseChain({
      causes: [{
        ...rootCause(),
        frames: [
          { raw: 'first', file: 7, function: 'run', line: -1, col: 0 },
          { raw: 42 },
          { raw: 'unvisited' },
        ],
      }, second],
      truncated: false,
    }, value => value);

    expect(normalized).toEqual({
      causes: [{
        ...rootCause(),
        frames: [{ raw: 'first', function: 'run', col: 0 }],
        framesTruncated: true,
      }, second],
      truncated: false,
    });
  });

  it('bounds cause descriptor work on huge arrays and stops at a revoked causal link', () => {
    const values = Array.from({ length: MAX_CRASH_CAUSES }, () => rootCause());
    values.length = 1_000_000;
    let descriptors = 0;
    const causes = new Proxy(values, {
      getOwnPropertyDescriptor(target, property) {
        descriptors++;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const bounded = normalizeCrashCauseChain({ causes, truncated: false }, value => value);
    expect(bounded?.causes).toHaveLength(MAX_CRASH_CAUSES);
    expect(bounded?.truncated).toBe(true);
    expect(descriptors).toBeLessThanOrEqual(MAX_CRASH_CAUSES + 2);

    const revoked = Proxy.revocable(rootCause(), {});
    revoked.revoke();
    expect(normalizeCrashCauseChain(
      { causes: [rootCause(), revoked.proxy, rootCause()], truncated: false },
      value => value,
    )).toEqual({ causes: [rootCause()], truncated: true });
  });

  it('rejects invalid direct wire text, positions, item caps, and required flags', () => {
    const cause = rootCause();
    expect(CrashCauseChain.safeParse({
      causes: Array.from({ length: MAX_CRASH_CAUSES }, rootCause),
      truncated: false,
    }).success).toBe(true);
    expect(CrashCauseChain.safeParse({
      causes: [{
        ...cause,
        frames: Array.from({ length: MAX_CRASH_CAUSE_FRAMES }, () => ({ raw: 'x' })),
      }],
      truncated: false,
    }).success).toBe(true);
    expect(CrashCauseChain.safeParse({ causes: [
      { ...cause, message: '\0' },
    ], truncated: false }).success).toBe(false);
    expect(CrashCauseChain.safeParse({ causes: [
      { ...cause, frames: [{ raw: 'x', line: Number.MAX_SAFE_INTEGER + 1 }] },
    ], truncated: false }).success).toBe(false);
    expect(CrashCauseChain.safeParse({
      causes: Array.from({ length: MAX_CRASH_CAUSES + 1 }, rootCause),
      truncated: true,
    }).success).toBe(false);
    expect(CrashCauseChain.safeParse({
      causes: [{ ...cause, frames: Array.from({ length: MAX_CRASH_CAUSE_FRAMES + 1 }, () => ({ raw: 'x' })) }],
      truncated: true,
    }).success).toBe(false);
    expect(CrashCauseChain.safeParse({
      causes: [{ exceptionType: 'Error', message: 'x', frames: [] }],
      truncated: false,
    }).success).toBe(false);
  });
});

describe('incremental crash cause fitting', () => {
  it('returns frames_full without touching the 33rd frame, then accepts the next cause', () => {
    let redactions = 0;
    const fitter = createCrashCauseChainFitter(value => { redactions++; return value; });
    expect(fitter.beginCause({ exceptionType: 'Outer', message: 'x', framesTruncated: false }))
      .toBe('accepted');
    for (let index = 0; index < MAX_CRASH_CAUSE_FRAMES; index++) {
      expect(fitter.appendFrame({ raw: `frame-${index}` })).toBe('accepted');
    }
    const beforeExtra = redactions;
    const extra = Object.defineProperty({}, 'raw', { get: () => { throw new Error('read'); } });
    expect(fitter.appendFrame(extra as { raw: string })).toBe('frames_full');
    expect(redactions).toBe(beforeExtra);
    expect(fitter.beginCause({ exceptionType: 'Inner', message: 'y', framesTruncated: false }))
      .toBe('accepted');

    const result = fitter.finish();
    expect(result?.causes).toHaveLength(2);
    expect(result?.causes[0]?.framesTruncated).toBe(true);
    expect(result?.truncated).toBe(false);
  });

  it('refuses a ninth header structurally without reading or redacting it', () => {
    let redactions = 0;
    const fitter = createCrashCauseChainFitter(value => { redactions++; return value; });
    for (let index = 0; index < MAX_CRASH_CAUSES; index++) {
      expect(fitter.beginCause({ exceptionType: `E${index}`, message: 'x', framesTruncated: false }))
        .toBe('accepted');
    }
    const beforeNinth = redactions;
    const ninth = Object.defineProperty({}, 'exceptionType', { get: () => { throw new Error('read'); } });
    expect(fitter.beginCause(ninth as never)).toBe('exhausted');
    expect(redactions).toBe(beforeNinth);
    expect(fitter.finish()).toMatchObject({ truncated: true });
  });

  it('seals after finish and discards malformed operation order or ownership loss', () => {
    const malformed = createCrashCauseChainFitter(value => value);
    expect(malformed.appendFrame({ raw: 'orphan' })).toBe('discarded');
    expect(malformed.finish()).toBeUndefined();

    const badMark = createCrashCauseChainFitter(value => value);
    badMark.markFramesTruncated();
    expect(badMark.finish()).toBeUndefined();

    let owned = true;
    const cancelled = createCrashCauseChainFitter(value => value, () => owned);
    expect(cancelled.beginCause({ exceptionType: 'Error', message: 'x', framesTruncated: false }))
      .toBe('accepted');
    owned = false;
    expect(cancelled.finish()).toBeUndefined();

    const sealed = createCrashCauseChainFitter(value => value);
    sealed.markChainTruncated();
    expect(sealed.beginCause({ exceptionType: 'Error', message: 'x', framesTruncated: false }))
      .toBe('accepted');
    sealed.markFramesTruncated();
    const first = sealed.finish();
    expect(sealed.finish()).toBe(first);
    expect(first).toEqual({
      causes: [{ exceptionType: 'Error', message: 'x', frames: [], framesTruncated: true }],
      truncated: true,
    });
    expect(sealed.beginCause({ exceptionType: 'Later', message: 'y', framesTruncated: false }))
      .toBe('discarded');
    expect(sealed.finish()).toBe(first);
  });

  it('retains a header and frame prefix when byte admission becomes exhausted', () => {
    const fitter = createCrashCauseChainFitter(value => value);
    expect(fitter.beginCause({ exceptionType: 'Error', message: 'x', framesTruncated: false }))
      .toBe('accepted');
    let result: string = 'accepted';
    let accepted = 0;
    while (result === 'accepted') {
      result = fitter.appendFrame({
        raw: 'r'.repeat(1024),
        file: 'f'.repeat(1024),
        function: 'n'.repeat(512),
      });
      if (result === 'accepted') accepted++;
    }
    expect(result).toBe('exhausted');
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(MAX_CRASH_CAUSE_FRAMES);

    const chain = fitter.finish();
    expect(chain?.causes[0]?.frames).toHaveLength(accepted);
    expect(chain?.causes[0]?.framesTruncated).toBe(true);
    expect(chain?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(chain), 'utf8')).toBeLessThanOrEqual(MAX_CRASH_CAUSE_BYTES);
  });

  it('does no further field or callback work after exhaustion', () => {
    let redactions = 0;
    const fitter = createCrashCauseChainFitter(value => { redactions++; return value; });
    expect(fitter.beginCause({ exceptionType: 'Error', message: 'x', framesTruncated: false }))
      .toBe('accepted');
    while (fitter.appendFrame({
      raw: 'r'.repeat(1024), file: 'f'.repeat(1024), function: 'n'.repeat(512),
    }) === 'accepted') {
      // Fill the byte budget.
    }
    const before = redactions;
    const unreadable = Object.defineProperty({}, 'message', { get: () => { throw new Error('read'); } });
    expect(fitter.beginCause(unreadable as never)).toBe('exhausted');
    expect(fitter.appendFrame(unreadable as never)).toBe('exhausted');
    expect(redactions).toBe(before);
  });

  it('exhausts on a later header without shrinking the retained earlier cause', () => {
    const fitter = createCrashCauseChainFitter(value => value);
    expect(fitter.beginCause({ exceptionType: 'Outer', message: 'x', framesTruncated: false }))
      .toBe('accepted');
    for (let index = 0; index < 24; index++) {
      expect(fitter.appendFrame({
        raw: 'r'.repeat(1024),
        file: 'f'.repeat(1024),
        function: 'n'.repeat(512),
      })).toBe('accepted');
    }
    expect(fitter.beginCause({
      exceptionType: 'Inner',
      message: '\\'.repeat(4096),
      framesTruncated: false,
    })).toBe('exhausted');

    const result = fitter.finish();
    expect(result?.causes).toHaveLength(1);
    expect(result?.causes[0]?.frames).toHaveLength(24);
    expect(result?.truncated).toBe(true);
  });
});

function chainAtExactBytes(target: number): unknown {
  const chain = {
    causes: Array.from({ length: MAX_CRASH_CAUSES }, (_, causeIndex) => ({
      exceptionType: `Error${causeIndex}`,
      message: '',
      frames: Array.from({ length: MAX_CRASH_CAUSE_FRAMES }, () => ({ raw: '' })),
      framesTruncated: false,
    })),
    truncated: false,
  };
  let remaining = target - Buffer.byteLength(JSON.stringify(chain), 'utf8');
  for (const cause of chain.causes) {
    for (const frame of cause.frames) {
      if (remaining <= 0) break;
      const add = Math.min(1024, remaining);
      frame.raw = 'x'.repeat(add);
      remaining -= add;
    }
  }
  if (remaining !== 0) throw new Error(`cannot construct ${target}-byte chain`);
  return chain;
}

describe('whole-chain byte boundary', () => {
  it('accepts exactly 65,536 bytes and rejects 65,537 bytes', () => {
    const exact = chainAtExactBytes(MAX_CRASH_CAUSE_BYTES);
    const over = chainAtExactBytes(MAX_CRASH_CAUSE_BYTES + 1);
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(65_536);
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBe(65_537);
    expect(CrashCauseChain.safeParse(exact).success).toBe(true);
    expect(CrashCauseChain.safeParse(over).success).toBe(false);
    expect(parseCrashCauseChain(exact)).toEqual(exact);
    expect(parseCrashCauseChain(over)).toBeUndefined();
  });
});
