// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CLI logic, separate from the bin entry so tests can call main() directly.
import { parseArgs } from 'node:util';
import { instrument, type InstrumentReport } from './instrument.js';
import { ALL_MECHANISMS, parseScreens, type Mechanism } from './entry-points.js';

const USAGE = `Usage: everframe-roku instrument <channelDir> --out <dir> [--exclude <glob>]... [--mechanisms main,init,key,observer,task,callfunc] [--screens <globs>|none] [--bundle-library] [--dry-run]`;

export function main(argv: string[]): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      exclude: { type: 'string', multiple: true },
      mechanisms: { type: 'string' },
      screens: { type: 'string' },
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
  let report: InstrumentReport;
  try {
    report = instrument({
      root: positionals[1],
      ...(values.out ? { out: values.out } : {}),
      exclude: values.exclude ?? [],
      ...(mechanisms ? { mechanisms } : {}),
      screens: parseScreens(values.screens),
      dryRun: values['dry-run'] ?? false,
      bundleLibrary: values['bundle-library'] ?? false,
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (const w of report.wrapped) console.log(`wrapped  ${w.file}  ${w.fn}`);
  for (const s of report.screens) console.log(`screen   ${s.file ?? '(no instrumented init)'}  ${s.component}  via ${s.via}`);
  if (report.libraryZip) console.log(`library  ${report.libraryZip}`);
  for (const s of report.skipped) console.warn(`skipped  ${s.file}  ${s.fn}: ${s.reason}`);
  console.log(`${report.wrapped.length} function(s) wrapped, ${report.injected.length} component(s) hooked, ${report.screens.length} screen(s) tracked${values['dry-run'] ? ' (dry run)' : ''}`);
  return 0;
}
