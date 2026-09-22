// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

export const FocusedNode = z.object({
  path: z.array(z.number()),
  componentPath: z.string(), // PAY-02 — e.g. "App > CheckoutScreen > CouponInput > TextField"
  source: z.enum(['mouse', 'keyboard', 'remote', 'touch', 'programmatic']),
  cursor: z.object({ x: z.number(), y: z.number() }).optional(),
});

export type FocusedNode = z.infer<typeof FocusedNode>;
