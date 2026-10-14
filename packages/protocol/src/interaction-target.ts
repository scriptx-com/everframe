// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000\uD800-\uDFFF]*$/u);
const name = text(256);
const role = text(64);
const position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Logical collection positions, never inferred from the number of mounted views. */
export const InteractionTargetContainerSchema = z
  .object({
    testId: name.optional(),
    name: name.optional(),
    role: role.optional(),
    index: position.optional(),
    count: position.optional(),
  })
  .strict();

export const InteractionTargetAnnotationSchema = z
  .object({
    testId: name.optional(),
    role: role.optional(),
    name: name.optional(),
    container: InteractionTargetContainerSchema.optional(),
  })
  .strict();

const fields = {
  testId: name.optional(),
  role: role.optional(),
  container: InteractionTargetContainerSchema.optional(),
  screen: name.optional(),
};
/** Producer contract only. Legacy/custom Breadcrumb.data remains an open record. */
export const InteractionTargetSchema = z.union([
  z.object({ role: role.optional(), masked: z.literal(true) }).strict(),
  z.object(fields).strict(),
  z
    .object({
      ...fields,
      name,
      nameFrom: z.enum(['annotation', 'accessibility', 'text', 'testId', 'className']),
    })
    .strict(),
]);

export type InteractionTarget = z.infer<typeof InteractionTargetSchema>;
export type InteractionTargetContainer = z.infer<typeof InteractionTargetContainerSchema>;
export type InteractionTargetAnnotation = z.infer<typeof InteractionTargetAnnotationSchema>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function bounded(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  // With /u, paired surrogates are one code point and are preserved.
  let result = value.replace(/[\u0000\uD800-\uDFFF]/gu, '').slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result.trim() ? result : undefined;
}

function logicalPosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return Object.keys(value).length ? value : undefined;
}

/** Malformed optional fields cannot make an app's interaction/report fail. */
export function normalizeInteractionTargetAnnotation(
  value: unknown,
): InteractionTargetAnnotation | undefined {
  try {
    const input = record(value);
    if (!input) return undefined;
    const collection = record(input.container);
    let container: InteractionTargetContainer | undefined;
    if (collection) {
      let index = logicalPosition(collection.index);
      let count = logicalPosition(collection.count);
      if (index !== undefined && count !== undefined && index >= count) index = count = undefined;
      container = compact({
        testId: bounded(collection.testId),
        name: bounded(collection.name),
        role: bounded(collection.role, 64),
        index,
        count,
      });
    }
    return compact({
      testId: bounded(input.testId),
      role: bounded(input.role, 64),
      name: bounded(input.name),
      container,
    });
  } catch {
    // Accessors/proxies are host code too; never let them break the capture path.
    return undefined;
  }
}
