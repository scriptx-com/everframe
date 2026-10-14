// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { InteractionTargetSchema } from '../dist/index.js';

const schema = z.toJSONSchema(InteractionTargetSchema, { target: 'draft-2020-12', io: 'output' });
// JSON Schema maxLength counts code points; producers cap UTF-16 code units.
function utf16Limits(node) {
  if (!node || typeof node !== 'object') return;
  for (const child of Object.values(node)) utf16Limits(child);
  if (node.type !== 'string' || typeof node.maxLength !== 'number') return;
  const max = node.maxLength;
  node.allOf = [
    {
      anyOf: Array.from({ length: Math.floor(max / 2) + 1 }, (_, extra) => ({
        maxLength: max - extra,
        pattern: `^(?:[\\u0000-\\uFFFF]*[^\\u0000-\\uFFFF]){0,${extra}}[\\u0000-\\uFFFF]*$`,
      })),
    },
  ];
}
utf16Limits(schema);
writeFileSync(
  new URL('../schemas-json/interaction-target.v1.schema.json', import.meta.url),
  JSON.stringify(schema, null, 2) + '\n',
);
