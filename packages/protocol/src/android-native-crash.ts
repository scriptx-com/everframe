// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { NativeAddress } from './native-crash.js';

/** Exact ELF GNU build-ID bytes, hex encoded. Not a Mach-O UUID. */
export const ElfBuildId = z.string().regex(/^(?:[0-9a-f]{2}){1,64}$(?![\s\S])/);
export const AndroidNativeFrame = z.object({
  pc: NativeAddress,
  /** Android debuggerd's ELF-relative PC; already adjusted for unwind semantics. */
  relativePc: NativeAddress,
  module: z.string().min(1).max(256).regex(/^[^/\\\u0000-\u001f\u007f]+$(?![\s\S])/)
    .regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$(?![\s\S])/u).optional(),
  buildId: ElfBuildId.optional(),
}).superRefine((frame, ctx) => {
  if (frame.buildId && !frame.module) ctx.addIssue({ code: 'custom', path: ['buildId'], message: 'ELF identity requires a module name' });
}).meta({ id: 'AndroidNativeFrame', title: 'AndroidNativeFrame' });
export type AndroidNativeFrame = z.infer<typeof AndroidNativeFrame>;

export const AndroidNativeCrashMetadata = z.object({
  source: z.literal('android-exit-info').meta({ title: 'AndroidNativeSource' }),
  abi: z.enum(['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64', 'riscv64']).meta({ title: 'AndroidNativeAbi' }),
  crashedThreadId: z.number().int().min(1).max(4294967295),
  framesIncomplete: z.boolean(),
  frames: z.array(AndroidNativeFrame).max(256),
  signalNumber: z.number().int().min(1).max(64).optional(),
  signalCode: z.number().int().min(-2147483648).max(2147483647).optional(),
}).meta({ id: 'AndroidNativeCrashMetadata', title: 'AndroidNativeCrashMetadata' });
export type AndroidNativeCrashMetadata = z.infer<typeof AndroidNativeCrashMetadata>;
