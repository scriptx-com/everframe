// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CrashPayload, NativeAddress, NativeCrashMetadata } from '../src/index.js';

const legacy = () => JSON.parse(readFileSync(new URL('./fixtures/crash-report.json', import.meta.url), 'utf8')).payload.crash;
const image = () => ({
  uuid: '11111111-1111-4111-8111-111111111111', name: 'App',
  loadAddress: '0x20000000000001', vmAddress: '0x100000000', size: '0x1000',
  cpuType: 16777228, cpuSubtype: 0, architecture: 'arm64',
});
const native = () => ({
  platform: 'apple', timestampMicros: '1791329334504358', crashedThreadIndex: 4,
  framesIncomplete: false, imagesIncomplete: false, images: [image()],
  frames: [{ instructionAddress: '0x20000000000011', imageIndex: 0, imageOffset: '0x10' }],
  error: { signalNumber: 5, signalCode: 0, machException: 6, machCode: '0x1', faultAddress: '0x20000000000011' },
});
const crash = () => ({ ...legacy(), frames: [{ raw: 'App 0x20000000000011' }], native: native() });

describe('Apple native crash metadata', () => {
  it('leaves existing payloads unchanged', () => {
    const value = legacy();
    expect(CrashPayload.parse(value)).toEqual(value);
    expect(CrashPayload.parse(value).native).toBeUndefined();
  });
  it('preserves exact addresses above the JavaScript integer boundary', () => {
    const parsed = CrashPayload.parse(crash());
    expect(parsed.native?.images[0]?.loadAddress).toBe('0x20000000000001');
    expect(JSON.parse(JSON.stringify(parsed)).native.frames[0].imageOffset).toBe('0x10');
  });
  it.each(['0x0', '0x1', '0xffffffffffffffff'])('accepts canonical address %s', value => {
    expect(NativeAddress.parse(value)).toBe(value);
  });
  it.each(['0x00', '0X1', '0xA', '0x10000000000000000', '1', '-0x1', '0x1\n', '', 9007199254740992])('rejects noncanonical address %s', value => {
    expect(NativeAddress.safeParse(value).success).toBe(false);
  });
  it('validates the complete standalone sidecar', () => {
    expect(NativeCrashMetadata.parse(native())).toEqual(native());
  });
  it('requires exact display/native frame alignment', () => {
    const value = crash(); value.frames.push({ raw: 'unpaired' });
    expect(CrashPayload.safeParse(value).success).toBe(false);
  });
  it('retains honest raw frames without an image association', () => {
    const value = crash();
    value.native.frames = [{ instructionAddress: '0xffffffffffffffff' }] as typeof value.native.frames;
    value.native.images = [];
    expect(CrashPayload.parse(value).native?.frames[0]).toEqual({ instructionAddress: '0xffffffffffffffff' });
  });
  it('rejects half-specified image references and missing image indexes', () => {
    for (const patch of [{ imageOffset: undefined }, { imageIndex: undefined }, { imageIndex: 1 }]) {
      const value = crash(); Object.assign(value.native.frames[0]!, patch);
      expect(CrashPayload.safeParse(value).success).toBe(false);
    }
  });
  it('rejects incorrect offsets, out-of-range PCs and overflowing images', () => {
    // Range rules apply to every image, so test them on one that no frame references.
    const unreferenced = () => ({ ...image(), uuid: '22222222-2222-4222-8222-222222222222', loadAddress: '0x30000000000000' });
    const valid = crash(); valid.native.images.push(unreferenced());
    expect(CrashPayload.safeParse(valid).success).toBe(true);
    for (const mutate of [
      (value: ReturnType<typeof crash>) => { value.native.frames[0]!.imageOffset = '0x11'; },
      (value: ReturnType<typeof crash>) => { value.native.frames[0]!.instructionAddress = '0x20000000001001'; value.native.frames[0]!.imageOffset = '0x1000'; },
      (value: ReturnType<typeof crash>) => { value.native.images.push({ ...unreferenced(), size: '0x0' }); },
      (value: ReturnType<typeof crash>) => { value.native.images.push({ ...unreferenced(), loadAddress: '0xffffffffffffffff', size: '0x2' }); },
      (value: ReturnType<typeof crash>) => { value.native.images[0]!.vmAddress = '0xffffffffffffffff'; },
    ]) {
      const value = crash(); mutate(value); expect(CrashPayload.safeParse(value).success).toBe(false);
    }
  });
  it('accepts the exact highest representable instruction address', () => {
    const value = crash(); Object.assign(value.native.images[0]!, { loadAddress: '0xfffffffffffffff0', size: '0x10' });
    Object.assign(value.native.frames[0]!, { instructionAddress: '0xffffffffffffffff', imageOffset: '0xf' });
    expect(CrashPayload.safeParse(value).success).toBe(true);
  });
  it('rejects paths, controls, uppercase UUIDs and oversized names', () => {
    for (const patch of [{ name: '/private/App' }, { name: 'dir\\App' }, { name: 'App\0' },
      { name: 'App\n' }, { name: '\ud800' }, { name: '😀'.repeat(129) }, { uuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }]) {
      const value = crash(); Object.assign(value.native.images[0]!, patch);
      expect(CrashPayload.safeParse(value).success).toBe(false);
    }
  });
  it('rejects architecture labels that contradict CPU identity', () => {
    const value = crash(); value.native.images[0]!.architecture = 'x86_64';
    expect(CrashPayload.safeParse(value).success).toBe(false);
  });
  it('caps frames/images and validates timestamps and thread indexes', () => {
    for (const patch of [
      { frames: Array.from({ length: 257 }, () => ({ instructionAddress: '0x1' })) },
      { images: Array.from({ length: 257 }, image) }, { timestampMicros: '01' },
      { timestampMicros: '1\n' }, { timestampMicros: '1'.repeat(19) },
      { crashedThreadIndex: -1 }, { crashedThreadIndex: 65536 },
    ]) expect(NativeCrashMetadata.safeParse({ ...native(), ...patch }).success).toBe(false);
  });
  it('rejects invalid CPU/error fields while retaining signed subtype capability bits', () => {
    const value = crash(); value.native.images[0]!.cpuSubtype = -2147483646; value.native.images[0]!.architecture = 'arm64e';
    expect(CrashPayload.safeParse(value).success).toBe(true);
    // An 'unknown' label agrees with out-of-range CPU values, so only the signed32 bounds reject them.
    for (const patch of [{ cpuType: 2147483648, architecture: 'unknown' }, { cpuSubtype: -2147483649, architecture: 'unknown' },
      { architecture: 'armv7' }]) {
      const invalid = crash(); Object.assign(invalid.native.images[0]!, patch);
      expect(CrashPayload.safeParse(invalid).success).toBe(false);
    }
    for (const key of ['signalNumber', 'signalCode', 'machException']) {
      for (const bound of [2147483647, -2147483648]) {
        expect(NativeCrashMetadata.safeParse({ ...native(), error: { [key]: bound } }).success, `${key} ${bound}`).toBe(true);
      }
      for (const invalid of [2147483648, -2147483649, 1.5]) {
        expect(NativeCrashMetadata.safeParse({ ...native(), error: { [key]: invalid } }).success, `${key} ${invalid}`).toBe(false);
      }
    }
  });
});
