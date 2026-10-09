// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { AndroidNativeCrashMetadata, CrashPayload } from '../src/index.js';
const evidence = () => ({
  source: 'android-exit-info', abi: 'arm64-v8a', crashedThreadId: 42,
  framesIncomplete: false, signalNumber: 11, signalCode: 1,
  frames: [{ pc: '0xffffffffffffffff', relativePc: '0x20000000000001', module: 'libfault.so', buildId: 'aabbccdd' }],
});
const crash = () => ({ androidNative: evidence(), exceptionType: 'SIGSEGV', message: 'Native process crash',
  frames: [{ raw: 'libfault.so 0x20000000000001' }], mechanism: 'android-exit-info', handled: false, fatal: true,
  occurredAt: '2026-10-07T18:00:00.000Z', fingerprint: '0123456789abcdef' });
describe('Android native crash evidence', () => {
  it('distinguishes authenticated native handler provenance from OS exit info', () => {
    expect(AndroidNativeCrashMetadata.safeParse({ ...evidence(), source: 'android-native-handler', framesIncomplete: true }).success).toBe(true);
  });
  it('preserves ELF identity and unsigned PCs without an Apple UUID conversion', () => {
    expect(AndroidNativeCrashMetadata.parse(evidence())).toEqual(evidence());
    expect(CrashPayload.parse(crash()).androidNative).toEqual(evidence());
  });
  it.each(['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64', 'riscv64'])('accepts explicit ABI %s', abi => {
    expect(AndroidNativeCrashMetadata.safeParse({ ...evidence(), abi }).success).toBe(true);
  });
  it.each(['', 'AA', 'abc', 'a'.repeat(130), 'aabb\n', 'xyz'])('rejects invalid exact build ID %j', buildId => {
    const value = evidence(); value.frames[0]!.buildId = buildId;
    expect(AndroidNativeCrashMetadata.safeParse(value).success).toBe(false);
  });
  it('allows absent module identity as raw-only evidence', () => {
    expect(AndroidNativeCrashMetadata.parse({ ...evidence(), frames: [{ pc: '0x0', relativePc: '0x0' }] }).frames).toEqual([{ pc: '0x0', relativePc: '0x0' }]);
  });
  it.each(['/data/private/lib.so', 'dir\\lib.so', 'bad\0name', 'bad\n', '\ud800', 'x'.repeat(257)])('rejects unsafe module %j', module => {
    const value = evidence(); value.frames[0]!.module = module;
    expect(AndroidNativeCrashMetadata.safeParse(value).success).toBe(false);
  });
  it('requires a module name with an exact build ID', () => {
    const value = evidence(); delete (value.frames[0] as { module?: string }).module;
    expect(AndroidNativeCrashMetadata.safeParse(value).success).toBe(false);
  });
  it('rejects inconsistent display count, simultaneous Apple evidence, and handled/nonfatal claims', () => {
    for (const patch of [{ frames: [] }, { handled: true }, { fatal: false }, { fatal: undefined }, { native: {} }]) {
      expect(CrashPayload.safeParse({ ...crash(), ...patch }).success).toBe(false);
    }
  });
  it('caps frames and validates OS metadata', () => {
    for (const patch of [{ frames: Array(257).fill(evidence().frames[0]) }, { crashedThreadId: 0 },
      { crashedThreadId: 4294967296 }, { signalNumber: 0 }, { signalNumber: 65 },
      { signalCode: 2147483648 }, { source: 'inferred' }, { abi: 'unknown' }]) {
      expect(AndroidNativeCrashMetadata.safeParse({ ...evidence(), ...patch }).success).toBe(false);
    }
  });
  it('rejects addresses that cannot be represented exactly as unsigned64', () => {
    for (const pc of ['0x00', '0x10000000000000000', '0X1', 9007199254740992]) {
      const value = evidence(); Object.assign(value.frames[0]!, { pc });
      expect(AndroidNativeCrashMetadata.safeParse(value).success).toBe(false);
    }
  });
});
