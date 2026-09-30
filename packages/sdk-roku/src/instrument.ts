// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { copyFileSync, cpSync, existsSync, lstatSync, statSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  /**
   * Every screen component (own name or an ancestor matched --screens) and the matched name. `file` is the
   * script whose init() now sets its screen: its own, or an ancestor's (Everframe_Screen, or Everframe_ScreenIf
   * naming this component); absent when no init() on its chain could be instrumented.
   */
  screens: Array<{ component: string; via: string; file?: string }>;
  skipped: Array<{ file: string; fn: string; reason: string }>;
  injected: string[];
  libraryZip?: string;
}

/** Written into every --out by a successful run; only a marked dir is ever cleared. */
export const OUT_MARKER = '.everframe-build';
const MARKER_TEXT = 'Created by everframe-roku instrument';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SET = ['everframe_hook.brs', 'ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs', 'ef_fingerprint.brs'];
const hookSource = (f: string) =>
  f === 'everframe_hook.brs' ? path.join(PKG, 'hook', f) : path.join(PKG, 'library/components/Everframe/lib', f);

export function instrument(opts: InstrumentOptions): InstrumentReport {
  // Canonical paths throughout: a symlinked or `..`-spelled --out must not alias the channel.
  const root = canonical(opts.root);
  if (!opts.dryRun && !opts.out) throw new Error('--out is required unless --dry-run is set');
  const out = opts.out ? canonical(opts.out) : '';
  if (out) {
    if (root === out) throw new Error('--out must differ from the channel directory');
    if (isInside(root, out)) throw new Error('--out must not contain the channel directory');
  }
  // --out may be a subdirectory of the channel (e.g. ./.everframe-build): skip it everywhere.
  const outInside = out !== '' && isInside(out, root);
  const plan = discoverEntryPoints(root, {
    exclude: opts.exclude ?? [],
    mechanisms: new Set(opts.mechanisms ?? ALL_MECHANISMS),
    screens: opts.screens ?? DEFAULT_SCREENS,
    ...(outInside ? { skipDir: out } : {}),
  });
  const report: InstrumentReport = { wrapped: [], screens: [], skipped: [], injected: [] };
  const rewritten = new Map<string, string>();
  const filesWithWraps = new Set<string>();
  /** file -> 'all' (init calls Everframe_Screen) or the lower-cased components its Everframe_ScreenIf names. */
  const emittedIn = new Map<string, 'all' | Set<string>>();

  for (const [file, targets] of plan.files) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const res = wrapFunctions(readFileSync(abs, 'utf8'), targets);
    for (const fn of res.wrapped) {
      report.wrapped.push({ file, fn });
      if (fn.toLowerCase() !== 'init') continue;
      const t = targets.get('init');
      if (t?.screen) emittedIn.set(file, 'all');
      else if (t?.screenIf && !t.screenConflict) emittedIn.set(file, new Set(t.screenIf.names.map((n) => n.toLowerCase())));
    }
    for (const s of res.skipped) report.skipped.push({ file, ...s });
    if (res.wrapped.length > 0) rewritten.set(file, res.code);
    if (res.wrapped.length > 0 || res.code.includes(MARKER)) filesWithWraps.add(file);
  }

  const compByName = new Map<string, (typeof plan.components)[number]>();
  for (const c of plan.components) if (!compByName.has(c.name.toLowerCase())) compByName.set(c.name.toLowerCase(), c);
  for (const sc of plan.screens) {
    // Own scripts first, then up the extends chain: the first init() that sets this component's screen.
    const me = sc.component.toLowerCase();
    const covers = (f: string) => { const e = emittedIn.get(f); return e === 'all' || (e !== undefined && e.has(me)); };
    let file: string | undefined;
    const seen = new Set<string>();
    let c = plan.components.find((x) => x.name === sc.component && !x.excluded);
    while (c && !file && !seen.has(c.name.toLowerCase())) {
      seen.add(c.name.toLowerCase());
      if (!c.excluded) file = c.scripts.find(covers);
      c = c.extends ? compByName.get(c.extends.toLowerCase()) : undefined;
    }
    report.screens.push({ component: sc.component, via: sc.via, ...(file ? { file } : {}) });
  }

  const xmlEdits = new Map<string, string>();
  // Excluded components too: one sharing a wrapped script would otherwise call undefined Everframe_* functions.
  for (const c of plan.components) {
    if (!c.scripts.some((s) => filesWithWraps.has(s))) continue;
    const text = readFileSync(path.join(root, c.xml), 'utf8');
    const next = injectHookImports(text);
    if (next !== text) xmlEdits.set(c.xml, next);
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
  writeFileSync(path.join(out, OUT_MARKER), `${MARKER_TEXT}. This directory is cleared on every run.\n`);
  return report;
}

/** `[start, end)` ranges of `<!-- -->` comments and CDATA sections; an unterminated one runs to the end. */
function inertRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /<!--|<!\[CDATA\[/g;
  for (let m; (m = re.exec(text));) {
    const close = m[0] === '<!--' ? '-->' : ']]>';
    const end = text.indexOf(close, m.index + m[0].length);
    const stop = end < 0 ? text.length : end + close.length;
    ranges.push([m.index, stop]);
    re.lastIndex = stop;
  }
  return ranges;
}

/**
 * Adds the hook <script> imports a component XML lacks, after its last active
 * script element (`<script .../>` or `</script>` outside comments/CDATA), else
 * before `</component>`. Commented-out imports do not count as present.
 */
export function injectHookImports(text: string): string {
  const inert = inertRanges(text);
  const live = (i: number) => !inert.some(([a, b]) => i >= a && i < b);
  const active = inert.reduceRight((t, [a, b]) => t.slice(0, a) + t.slice(b), text);
  const missing = HOOK_SET.filter((f) => !active.includes(`pkg:/components/everframe_hook/${f}`));
  if (missing.length === 0) return text;
  const tags = missing.map((f) => `\n  <script type="text/brightscript" uri="pkg:/components/everframe_hook/${f}" />`).join('');
  const last = (re: RegExp) => [...text.matchAll(re)].filter((m) => live(m.index)).at(-1);
  const script = last(/<script\b[^>]*\/>|<\/script\s*>/gi);
  if (script) {
    const at = script.index + script[0].length;
    return text.slice(0, at) + tags + text.slice(at);
  }
  const end = last(/<\/component\s*>/gi);
  if (!end) throw new Error('component XML has no <script> or </component> to add the hook imports to');
  return text.slice(0, end.index) + tags.slice(1) + '\n' + text.slice(end.index);
}

/** realpath, or for a path that does not exist yet, the realpath of its nearest existing ancestor plus the rest. */
function canonical(p: string): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(realpathSync.native(head), ...rest); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(head) === head) throw e;
    }
    rest.unshift(path.basename(head));
    head = path.dirname(head);
  }
}

/** `child` is strictly below `parent` (both canonical). */
const isInside = (child: string, parent: string) => child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

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
      if (!hasMarker(out)) {
        throw new Error(`refusing to overwrite a directory everframe-roku did not create: ${out} (use an empty or new directory)`);
      }
      for (const e of entries) rmSync(path.join(out, e), { recursive: true, force: true });
    }
  }
  mkdirSync(out, { recursive: true });
}

/** A regular file (not a directory such as a channel's own ./.everframe-build, not a symlink) holding the text this tool writes. */
function hasMarker(out: string): boolean {
  const f = path.join(out, OUT_MARKER);
  try { return lstatSync(f).isFile() && readFileSync(f, 'utf8').startsWith(MARKER_TEXT); } catch { return false; }
}
