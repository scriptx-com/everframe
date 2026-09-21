// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

export const SDKPlatform = z
  .enum(['web', 'ios', 'android', 'tvos', 'tizen', 'webos', 'androidtv'])
  .meta({
    // Use Draft 2020-12 keyword `$id` (Zod 4 passes meta keys through verbatim,
    // and ajv 2020 rejects bare `id`).
    $id: 'SDKPlatform',
    description: 'All TV form factors enumerated from v1 (PLAT-04)',
  });

export const FormFactor = z.enum(['phone', 'tablet', 'desktop', 'tv']);

export type SDKPlatform = z.infer<typeof SDKPlatform>;
export type FormFactor = z.infer<typeof FormFactor>;
