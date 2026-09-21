#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Node-driver wrapper around codegen-swift.sh so consumers without bash on PATH
// can still run `pnpm -w codegen`. Equivalent to `bash codegen-swift.sh`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync('bash', [resolve(here, 'codegen-swift.sh')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
