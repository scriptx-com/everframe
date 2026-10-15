// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import type { BreadcrumbKind } from './breadcrumb.js';
import { InteractionTargetSchema } from './interaction-target.js';

const text = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[^\u0000\uD800-\uDFFF]*$/u);
const source = z.enum(['native', 'app']);
const common = { source, observedAt: z.number().finite().nonnegative() };
const position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const result = z.enum(['granted', 'denied', 'blocked', 'limited', 'unavailable', 'unknown']);
const args = z
  .record(text(128), z.union([text(128, 0), z.number().finite(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 16, 'At most 16 launch arguments')
  .meta({ maxProperties: 16 });

/** Producer contract. The envelope's open custom data and existing kind enum are unchanged. */
export const InteractionEventSchema = z
  .union([
    z
      .object({
        ...common,
        type: z.literal('text_edit'),
        length: position,
        value: text(256, 0).optional(),
        reason: z.enum(['idle', 'end', 'submit', 'freeze']),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('control_change'),
        control: z.enum(['switch', 'checkbox']),
        checked: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('control_change'),
        control: z.literal('slider'),
        position: z.number().finite(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('control_change'),
        control: z.enum(['radio', 'picker']),
        optionId: text(128),
        value: text(256, 0).optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('scroll'),
        axis: z.enum(['x', 'y']),
        direction: z.enum(['forward', 'backward']),
        item: InteractionTargetSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('deep_link'),
        url: text(1024),
        delivery: z.enum(['initial', 'subsequent']),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('permission'),
        permission: text(128),
        phase: z.literal('requested'),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('permission'),
        permission: text(128),
        phase: z.literal('result'),
        result,
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('launch'),
        start: z.enum(['cold', 'warm']),
        trigger: z.enum(['link', 'notification']).optional(),
        arguments: args.optional(),
      })
      .strict(),
  ])
  .meta({ $id: 'InteractionEvent' });

export type InteractionEvent = z.infer<typeof InteractionEventSchema>;
export type InteractionEventType = InteractionEvent['type'];
export type InteractionSource = z.infer<typeof source>;

/** These categories retain existing configuration/trim/consumer compatibility. */
export function interactionBreadcrumbKind(type: InteractionEventType): BreadcrumbKind {
  switch (type) {
    case 'deep_link':
      return 'navigation';
    case 'permission':
    case 'launch':
      return 'lifecycle';
    default:
      return 'custom';
  }
}
