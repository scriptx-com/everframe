#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { parseArgs } from 'node:util';
import { instrument } from './instrument.js';
import { ALL_MECHANISMS, type Mechanism } from './entry-points.js';

const USAGE = `Usage: everframe-roku instrument <channelDir> --out <dir> [--exclude <glob>]... [--mechanisms main,init,key,observer,task,callfunc] [--bundle-library] [--dry-run]`;

function main(argv: string[]): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      exclude: { type: 'string', multiple: true },
      mechanisms: { type: 'string' },
      'bundle-library': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals[0] !== 'instrument' || !positionals[1] || (!values.out && !values['dry-run'])) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  const mechanisms = values.mechanisms?.split(',').map((m) => m.trim()) as Mechanism[] | undefined;
  const bad = mechanisms?.filter((m) => !ALL_MECHANISMS.includes(m));
  if (bad?.length) { console.error(`Unknown mechanism(s): ${bad.join(', ')}`); return 2; }
  const report = instrument({
    root: positionals[1],
    ...(values.out ? { out: values.out } : {}),
    exclude: values.exclude ?? [],
    ...(mechanisms ? { mechanisms } : {}),
    dryRun: values['dry-run'] ?? false,
    bundleLibrary: values['bundle-library'] ?? false,
  });
  for (const w of report.wrapped) console.log(`wrapped  ${w.file}  ${w.fn}`);
  for (const s of report.skipped) console.warn(`skipped  ${s.file}  ${s.fn}: ${s.reason}`);
  console.log(`${report.wrapped.length} function(s) wrapped, ${report.injected.length} component(s) hooked${values['dry-run'] ? ' (dry run)' : ''}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
