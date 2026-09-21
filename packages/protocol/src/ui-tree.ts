// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

// Recursive type matches z.optional() emit shape under exactOptionalPropertyTypes:
// the property may be omitted OR explicitly set to undefined.
export interface UINode {
  componentType: string;
  componentName?: string | undefined;
  identifiers: Record<string, string>;
  // Visible-after-clipping bounding box. Web fiber walker intersects the
  // raw getBoundingClientRect with every ancestor whose computed `overflow`
  // is non-visible and stores the result here. Native walkers (iOS UIView /
  // Android View / Compose) emit the natural window-coordinate rect, which
  // already reflects platform clipping. A zero-area rect means a fully
  // clipped element, by protocol invariant.
  rect: { x: number; y: number; width: number; height: number };
  safeProps: Record<string, string | number | boolean>;
  children: UINode[];
  sensitive?: boolean | undefined;
  // Plan 05-01 (D-05): renderer-specific node-kind tag.
  // Compose walker emits 'compose'; View walker emits 'view'; web emits 'dom'.
  // Optional + additive — existing producers continue to work.
  nodeKind?: 'compose' | 'view' | 'dom' | undefined;
}

export const UINode: z.ZodType<UINode> = z.lazy(() =>
  z.object({
    componentType: z.string(),
    componentName: z.string().optional(),
    identifiers: z.record(z.string(), z.string()),
    rect: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
    safeProps: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    children: z.array(UINode),
    sensitive: z.boolean().optional(),
    // Plan 05-01 (D-05): see interface comment above.
    nodeKind: z.enum(['compose', 'view', 'dom']).optional(),
  })
);

export const UITree = z.object({
  root: UINode,
  capturedAt: z.string().datetime(),
  // Plan 05-01: 'android' added alongside 'uikit' (Phase 04.1) — additive enum extension.
  rendererHint: z.enum(['dom', 'rn-paper', 'rn-fabric', 'uikit', 'android']),
  truncated: z.boolean().optional(), // PAY-03
});

export type UITree = z.infer<typeof UITree>;
