// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { NativeExposurePointerSchema } from './release-health.js';

const addressPattern = /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$(?![\s\S])/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/;
const signed32 = z.number().int().min(-2147483648).max(2147483647);
const addressSpaceEnd = 1n << 64n;
function architecture(cpuType: number, cpuSubtype: number): string {
  const subtype = cpuSubtype & 0x00ffffff;
  if (cpuType === 0x0100000c) {
    if (subtype === 2) return 'arm64e';
    if (subtype === 0 || subtype === 1) return 'arm64';
  }
  if (cpuType === 0x01000007) {
    if (subtype === 3) return 'x86_64';
    if (subtype === 8) return 'x86_64h';
  }
  return 'unknown';
}

/** Exact unsigned64 value. Never transport native addresses as JSON numbers. */
export const NativeAddress = z.string().max(18).regex(addressPattern);
export type NativeAddress = z.infer<typeof NativeAddress>;

export const NativeCrashImage = z.object({
  uuid: z.string().regex(uuidPattern),
  name: z.string().min(1).max(256).regex(/^[^/\\\u0000-\u001f\u007f-\u009f]+$(?![\s\S])/)
    .regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$(?![\s\S])/u),
  loadAddress: NativeAddress,
  vmAddress: NativeAddress.optional(),
  size: NativeAddress,
  cpuType: signed32,
  cpuSubtype: signed32,
  architecture: z.enum(['arm64', 'arm64e', 'x86_64', 'x86_64h', 'unknown'])
    .meta({ title: 'NativeCrashArchitecture' }),
}).meta({ id: 'NativeCrashImage', title: 'NativeCrashImage' });
export type NativeCrashImage = z.infer<typeof NativeCrashImage>;

export const NativeCrashFrame = z.object({
  instructionAddress: NativeAddress,
  imageIndex: z.number().int().min(0).max(255).optional(),
  imageOffset: NativeAddress.optional(),
}).meta({ id: 'NativeCrashFrame', title: 'NativeCrashFrame' });
export type NativeCrashFrame = z.infer<typeof NativeCrashFrame>;

export const NativeCrashReleaseHealthEvidence = z.object({
  version: z.literal(1), attribution: z.literal('immutable_fatal_context').meta({ title: 'NativeCrashHealthAttribution' }),
  contextId: z.string().regex(uuidPattern), exposure: NativeExposurePointerSchema,
}).strict().meta({ id: 'NativeCrashReleaseHealthEvidence', title: 'NativeCrashReleaseHealthEvidence' });

export const NativeCrashMetadata = z.object({
  releaseHealthEvidence: NativeCrashReleaseHealthEvidence.optional(),
  platform: z.literal('apple').meta({ title: 'NativeCrashPlatform' }),
  timestampMicros: z.string().regex(/^(?:0|[1-9][0-9]{0,17})$(?![\s\S])/),
  crashedThreadIndex: z.number().int().min(0).max(65535),
  framesIncomplete: z.boolean(),
  imagesIncomplete: z.boolean(),
  images: z.array(NativeCrashImage).max(256),
  frames: z.array(NativeCrashFrame).max(256),
  error: z.object({
    signalNumber: signed32.optional(),
    signalCode: signed32.optional(),
    machException: signed32.optional(),
    machCode: NativeAddress.optional(),
    machSubcode: NativeAddress.optional(),
    faultAddress: NativeAddress.optional(),
  }).meta({ id: 'NativeCrashError', title: 'NativeCrashError' }),
}).superRefine((value, ctx) => {
  // JSON Schema expresses structural limits. These semantic relationships also
  // require validation by consumers before using metadata for symbolication.
  const hex = (text: string): bigint | undefined => addressPattern.test(text) ? BigInt(text) : undefined;
  value.images.forEach((image, index) => {
    if (image.architecture !== architecture(image.cpuType, image.cpuSubtype)) {
      ctx.addIssue({ code: 'custom', path: ['images', index, 'architecture'], message: 'Native architecture and CPU identity disagree' });
    }
    const start = hex(image.loadAddress), size = hex(image.size);
    if (start !== undefined && size !== undefined && (size === 0n || start + size > addressSpaceEnd)) {
      ctx.addIssue({ code: 'custom', path: ['images', index, 'size'], message: 'Invalid native image range' });
    }
    const vm = image.vmAddress === undefined ? undefined : hex(image.vmAddress);
    if (vm !== undefined && size !== undefined && vm + size > addressSpaceEnd) {
      ctx.addIssue({ code: 'custom', path: ['images', index, 'vmAddress'], message: 'Invalid native virtual image range' });
    }
  });
  value.frames.forEach((frame, index) => {
    const hasIndex = frame.imageIndex !== undefined, hasOffset = frame.imageOffset !== undefined;
    if (hasIndex !== hasOffset) {
      ctx.addIssue({ code: 'custom', path: ['frames', index], message: 'Native image index and offset must be paired' });
      return;
    }
    if (!hasIndex) return;
    const image = value.images[frame.imageIndex!];
    if (!image) {
      ctx.addIssue({ code: 'custom', path: ['frames', index, 'imageIndex'], message: 'Native image index is missing' });
      return;
    }
    const pc = hex(frame.instructionAddress), start = hex(image.loadAddress);
    const size = hex(image.size), offset = hex(frame.imageOffset!);
    if (pc === undefined || start === undefined || size === undefined || offset === undefined) return;
    if (pc < start || offset >= size || pc - start !== offset) {
      ctx.addIssue({ code: 'custom', path: ['frames', index], message: 'Native address and image offset disagree' });
    }
  });
}).meta({ id: 'NativeCrashMetadata', title: 'NativeCrashMetadata' });
export type NativeCrashMetadata = z.infer<typeof NativeCrashMetadata>;
