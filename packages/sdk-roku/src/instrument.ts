// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { copyFileSync, cpSync, existsSync, lstatSync, statSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverEntryPoints, ALL_MECHANISMS, DEFAULT_SCREENS, type Mechanism } from './entry-points.js';
import { wrapFunctions, MARKER } from './wrap.js';

export interface InstrumentOptions {
  root: string; out?: string; exclude?: string[]; mechanisms?: Mechanism[]; dryRun?: boolean; bundleLibrary?: boolean;
  /** Component-name globs whose init() sets the current screen; default DEFAULT_SCREENS, [] disables. */
  screens?: string[];
}
export interface InstrumentReport {
  wrapped: Array<{ file: string; fn: string }>;
  /** Every screen component (own name or an ancestor matched --screens) and the matched name. `file` is the script whose init() now calls Everframe_Screen; absent when the component inherits its init(). */
  screens: Array<{ component: string; via: string; file?: string }>;
  skipped: Array<{ file: string; fn: string; reason: string }>;
  injected: string[];
  libraryZip?: string;
}

/** Written into every --out by a successful run; only a marked dir is ever cleared. */
export const OUT_MARKER = '.everframe-build';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SET = ['everframe_hook.brs', 'ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs'];
const hookSource = (f: string) =>
  f === 'everframe_hook.brs' ? path.join(PKG, 'hook', f) : path.join(PKG, 'library/components/Everframe/lib', f);

export function instrument(opts: InstrumentOptions): InstrumentReport {
  const root = path.resolve(opts.root);
  if (!opts.dryRun && !opts.out) throw new Error('--out is required unless --dry-run is set');
  const out = opts.out ? path.resolve(opts.out) : '';
  if (out) {
    if (root === out) throw new Error('--out must differ from the channel directory');
    if (root.startsWith(out + path.sep)) throw new Error('--out must not contain the channel directory');
  }
  // --out may be a subdirectory of the channel (e.g. ./.everframe-build): skip it everywhere.
  const outInside = out !== '' && out.startsWith(root + path.sep);
  const plan = discoverEntryPoints(root, {
    exclude: opts.exclude ?? [],
    mechanisms: new Set(opts.mechanisms ?? ALL_MECHANISMS),
    screens: opts.screens ?? DEFAULT_SCREENS,
    ...(outInside ? { skipDir: out } : {}),
  });
  const report: InstrumentReport = { wrapped: [], screens: [], skipped: [], injected: [] };
  const rewritten = new Map<string, string>();
  const filesWithWraps = new Set<string>();
  const emittedIn = new Set<string>();

  for (const [file, targets] of plan.files) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const res = wrapFunctions(readFileSync(abs, 'utf8'), targets);
    for (const fn of res.wrapped) {
      report.wrapped.push({ file, fn });
      if (fn.toLowerCase() === 'init' && targets.get('init')?.screen) emittedIn.add(file);
    }
    for (const s of res.skipped) report.skipped.push({ file, ...s });
    if (res.wrapped.length > 0) rewritten.set(file, res.code);
    if (res.wrapped.length > 0 || res.code.includes(MARKER)) filesWithWraps.add(file);
  }

  for (const sc of plan.screens) {
    const c = plan.components.find((x) => x.name === sc.component);
    const file = c?.scripts.find((f) => emittedIn.has(f));
    report.screens.push({ component: sc.component, via: sc.via, ...(file ? { file } : {}) });
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

  prepareOut(out);
  copyChannel(root, out, outInside ? out : undefined);
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
  writeFileSync(path.join(out, OUT_MARKER), 'Created by everframe-roku instrument. This directory is cleared on every run.\n');
  return report;
}

/**
 * Copies the channel into `out`, dereferencing file symlinks (so writes never go
 * through a link), skipping symlinked directories (cycles; discovery ignores them
 * too), .git, node_modules, and `skip` (the --out dir when it is inside the channel).
 * Hand-rolled because cpSync refuses a destination inside its source.
 */
function copyChannel(src: string, dst: string, skip: string | undefined) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name === '.git' || name === 'node_modules') continue;
    const from = path.join(src, name);
    if (from === skip) continue;
    const to = path.join(dst, name);
    let st;
    try { st = lstatSync(from).isSymbolicLink() ? statSync(from) : lstatSync(from); } catch { continue; }
    if (st.isDirectory()) {
      if (lstatSync(from).isSymbolicLink()) continue;
      copyChannel(from, to, skip);
    } else if (st.isFile()) {
      copyFileSync(from, to);
    }
  }
}

/** Empty `out` if a previous run created it; refuse to touch any other non-empty directory. */
function prepareOut(out: string) {
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new Error(`--out ${out} exists and is not a directory`);
    const entries = readdirSync(out);
    if (entries.length > 0) {
      if (!entries.includes(OUT_MARKER)) {
        throw new Error(`refusing to overwrite a directory everframe-roku did not create: ${out} (use an empty or new directory)`);
      }
      for (const e of entries) rmSync(path.join(out, e), { recursive: true, force: true });
    }
  }
  mkdirSync(out, { recursive: true });
}
