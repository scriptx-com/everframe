// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { utf16Limits } from './json-schema-utf16.mjs';
import { InteractionTargetSchema } from '../dist/index.js';

const schema = z.toJSONSchema(InteractionTargetSchema, { target: 'draft-2020-12', io: 'output' });
utf16Limits(schema);
writeFileSync(
  new URL('../schemas-json/interaction-target.v1.schema.json', import.meta.url),
  JSON.stringify(schema, null, 2) + '\n',
);
