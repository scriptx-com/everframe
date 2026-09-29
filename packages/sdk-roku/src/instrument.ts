// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverEntryPoints, ALL_MECHANISMS, type Mechanism } from './entry-points.js';
import { wrapFunctions, MARKER } from './wrap.js';

export interface InstrumentOptions { root: string; out: string; exclude?: string[]; mechanisms?: Mechanism[]; dryRun?: boolean; bundleLibrary?: boolean }
export interface InstrumentReport {
  wrapped: Array<{ file: string; fn: string }>;
  skipped: Array<{ file: string; fn: string; reason: string }>;
  injected: string[];
  libraryZip?: string;
}

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SET = ['everframe_hook.brs', 'ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs'];
const hookSource = (f: string) =>
  f === 'everframe_hook.brs' ? path.join(PKG, 'hook', f) : path.join(PKG, 'library/components/Everframe/lib', f);

export function instrument(opts: InstrumentOptions): InstrumentReport {
  const root = path.resolve(opts.root);
  const out = path.resolve(opts.out);
  if (root === out) throw new Error('--out must differ from the channel directory');
  const plan = discoverEntryPoints(root, {
    exclude: opts.exclude ?? [],
    mechanisms: new Set(opts.mechanisms ?? ALL_MECHANISMS),
  });
  const report: InstrumentReport = { wrapped: [], skipped: [], injected: [] };
  const rewritten = new Map<string, string>();
  const filesWithWraps = new Set<string>();

  for (const [file, targets] of plan.files) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const res = wrapFunctions(readFileSync(abs, 'utf8'), targets);
    for (const fn of res.wrapped) report.wrapped.push({ file, fn });
    for (const s of res.skipped) report.skipped.push({ file, ...s });
    if (res.wrapped.length > 0) rewritten.set(file, res.code);
    if (res.wrapped.length > 0 || res.code.includes(MARKER)) filesWithWraps.add(file);
  }

  const xmlEdits = new Map<string, string>();
  for (const c of plan.components) {
    if (!c.scripts.some((s) => filesWithWraps.has(s))) continue;
    const text = readFileSync(path.join(root, c.xml), 'utf8');
    const missing = HOOK_SET.filter((f) => !text.includes(`pkg:/components/everframe_hook/${f}`));
    if (missing.length === 0) { report.injected.push(c.xml); continue; }
    const tags = missing.map((f) => `\n  <script type="text/brightscript" uri="pkg:/components/everframe_hook/${f}" />`).join('');
    const lastScript = /(<script\b[^>]*\/>|<\/script>)(?![\s\S]*(<script\b[^>]*\/>|<\/script>))/i;
    xmlEdits.set(c.xml, text.replace(lastScript, (m) => m + tags));
    report.injected.push(c.xml);
  }

  if (opts.dryRun) return report;

  mkdirSync(out, { recursive: true });
  cpSync(root, out, {
    recursive: true,
    filter: (src) => {
      if (src === out || src.startsWith(out + path.sep)) return false;
      return !path.relative(root, src).split(path.sep).some((part) => part === '.git' || part === 'node_modules');
    },
  });
  for (const [file, code] of rewritten) writeFileSync(path.join(out, file), code);
  for (const [file, text] of xmlEdits) writeFileSync(path.join(out, file), text);
  for (const dir of ['source/everframe', 'components/everframe_hook']) {
    mkdirSync(path.join(out, dir), { recursive: true });
    for (const f of HOOK_SET) cpSync(hookSource(f), path.join(out, dir, f));
  }
  if (opts.bundleLibrary) {
    const { version } = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    const zip = path.join(PKG, 'dist', `everframe-roku-${version}.zip`);
    if (!existsSync(zip)) throw new Error(`library zip not built: ${zip}`);
    const dest = path.join(out, 'components', `everframe-roku-${version}.zip`);
    cpSync(zip, dest);
    report.libraryZip = path.relative(out, dest);
  }
  return report;
}
