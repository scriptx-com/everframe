// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { Parser, isFunctionStatement } from 'brighterscript';
import type { WrapTarget } from './wrap.js';

export type Mechanism = 'main' | 'init' | 'key' | 'observer' | 'task' | 'callfunc';
export const ALL_MECHANISMS: Mechanism[] = ['main', 'init', 'key', 'observer', 'task', 'callfunc'];

/** Component-name globs whose init() sets the current screen (--screens). */
export const DEFAULT_SCREENS = ['*Screen', '*View', '*Page'];

/** --screens value -> patterns: comma-separated, trimmed; "none" -> []. Undefined -> defaults. */
export function parseScreens(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_SCREENS];
  if (value.trim().toLowerCase() === 'none') return [];
  return value.split(',').map((p) => p.trim()).filter(Boolean);
}

/** Whole-name, case-insensitive glob match: `*` any run, `?` one character. */
export function matchesScreen(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${re}$`, 'i').test(name);
  });
}

/** The BrightScript expression injected into a screen's init(): the concrete component type, even when a base class's init runs. */
export const SCREEN_EXPR = 'm.top.subtype()';

/**
 * First name on the chain [name, parent, grandparent, ...] that matches a
 * pattern. `parents` maps lower-cased component name -> extends. Cycles and
 * unknown parents end the walk (a missing parent is a leaf).
 */
export function screenVia(name: string, parents: Map<string, string>, patterns: string[]): string | undefined {
  const seen = new Set<string>();
  let cur: string | undefined = name;
  while (cur && !seen.has(cur.toLowerCase())) {
    if (matchesScreen(cur, patterns)) return cur;
    seen.add(cur.toLowerCase());
    cur = parents.get(cur.toLowerCase());
  }
  return undefined;
}

export interface EntryPlan {
  files: Map<string, Map<string, WrapTarget>>;
  /** Every component, excluded ones too (`excluded`: no targets of its own, but it still needs the hook imports when a script it shares is wrapped). */
  components: Array<{ xml: string; name: string; extends?: string; scripts: string[]; excluded: boolean }>;
  /** Every component whose own name or an ancestor's matched --screens, and the matched name. */
  screens: Array<{ component: string; via: string }>;
}

const OBSERVE_RE = /observeField(?:Scoped)?\s*\(\s*"[^"]*"\s*,\s*"(\w+)"/gi;
const TASK_RE = /functionName\s*=\s*"(\w+)"/gi;

function walk(dir: string, root: string, skip: string | undefined, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (abs === skip) continue;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(abs, root, skip, out);
    else out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

function excluded(rel: string, exclude: string[]): boolean {
  return exclude.some((g) => path.matchesGlob(rel, g));
}

function add(plan: EntryPlan, file: string, fn: string, target: WrapTarget) {
  let m = plan.files.get(file);
  if (!m) plan.files.set(file, (m = new Map()));
  const key = fn.toLowerCase();
  const prev = m.get(key);
  if (!prev) { m.set(key, target); return; }
  // A script shared by several components: the first target wins, but an
  // init whose components disagree on the screen gets no automatic screen.
  if (prev.screen !== target.screen || prev.screenConflict) {
    const names = new Set(prev.screenConflict ?? [prev.screenOwner ?? '']);
    names.add(target.screenOwner ?? '');
    names.delete('');
    delete prev.screen;
    prev.screenConflict = [...names].sort();
  }
}

/** `skipDir`: absolute path excluded from discovery (the --out dir when it sits inside the channel). */
export function discoverEntryPoints(
  root: string,
  opts: { exclude: string[]; mechanisms: Set<Mechanism>; skipDir?: string; screens?: string[] },
): EntryPlan {
  const plan: EntryPlan = { files: new Map(), components: [], screens: [] };
  const all = walk(root, root, opts.skipDir);
  const on = (m: Mechanism) => opts.mechanisms.has(m);

  if (on('main')) {
    for (const rel of all.filter((f) => f.startsWith('source/') && !f.startsWith('source/everframe/') && f.endsWith('.brs'))) {
      if (excluded(rel, opts.exclude)) continue;
      for (const fn of ['main', 'runuserinterface']) add(plan, rel, fn, { entry: `Main (${rel})`, isTask: false, prelude: 'recordExit' });
    }
  }

  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  // Pass 1: inheritance map from every component XML (excluded ones still count as ancestors).
  const parsed: Array<{ rel: string; comp: any }> = [];
  const parents = new Map<string, string>();
  const byName = new Map<string, { rel: string; comp: any }>();
  for (const rel of all.filter((f) => f.startsWith('components/') && f.endsWith('.xml'))) {
    let comp: any;
    try { comp = xml.parse(readFileSync(path.join(root, rel), 'utf8'))?.component; } catch { continue; }
    if (!comp?.name) continue;
    if (comp.extends) parents.set(String(comp.name).toLowerCase(), String(comp.extends));
    parsed.push({ rel, comp });
    if (!byName.has(String(comp.name).toLowerCase())) byName.set(String(comp.name).toLowerCase(), { rel, comp });
  }
  const scriptsOf = (rel: string, comp: any): string[] => [comp.script].flat().filter(Boolean)
    .map((s: { uri?: string }) => s.uri ?? '')
    .filter((u: string) => u.endsWith('.brs'))
    .map((u: string) => (u.startsWith('pkg:/') ? u.slice(5) : path.posix.join(path.posix.dirname(rel), u)))
    .filter((s: string) => !s.startsWith('components/everframe_hook/'));
  // Callbacks a component declares (interface onChange / functions) or wires up in its scripts (observeField, functionName).
  const callbacks = (rel: string, comp: any): Array<[string, WrapTarget, Mechanism]> => {
    const out: Array<[string, WrapTarget, Mechanism]> = [];
    const iface = comp.interface ?? {};
    for (const f of [iface.field].flat().filter(Boolean)) {
      if (f.onChange) out.push([f.onChange, { entry: '', isTask: false }, 'observer']);
    }
    for (const f of [iface.function].flat().filter(Boolean)) {
      if (f.name) out.push([f.name, { entry: '', isTask: false }, 'callfunc']);
    }
    for (const s of scriptsOf(rel, comp)) {
      let text = '';
      try { text = readFileSync(path.join(root, s), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(OBSERVE_RE)) out.push([m[1]!, { entry: '', isTask: false }, 'observer']);
      for (const m of text.matchAll(TASK_RE)) out.push([m[1]!, { entry: '', isTask: true }, 'task']);
    }
    return out;
  };

  const initCache = new Map<string, boolean>();
  const definesInit = (file: string): boolean => {
    let v = initCache.get(file);
    if (v === undefined) {
      let text = '';
      try { text = readFileSync(path.join(root, file), 'utf8'); } catch { /* missing script: no init */ }
      v = Parser.parse(text).ast.statements.some((st) => isFunctionStatement(st) && st.name.text.toLowerCase() === 'init');
      initCache.set(file, v);
    }
    return v;
  };
  // Screens whose own scripts define no init(): they run only inherited ones.
  const inheritsInit: Array<{ name: string }> = [];

  for (const { rel, comp } of parsed) {
    const skip = excluded(rel, opts.exclude);
    const scripts = scriptsOf(rel, comp).filter((s) => !excluded(s, opts.exclude));
    plan.components.push({ xml: rel, name: comp.name, ...(comp.extends ? { extends: String(comp.extends) } : {}), scripts, excluded: skip });
    if (skip) continue;

    // Lifecycle crumbs only for the scene: every component's init would flood the ring.
    const isScene = comp.extends === 'Scene';
    const via = on('init') ? screenVia(String(comp.name), parents, opts.screens ?? []) : undefined;
    const isScreen = via !== undefined;
    if (isScreen) {
      plan.screens.push({ component: String(comp.name), via });
      if (!scriptsOf(rel, comp).some(definesInit)) inheritsInit.push({ name: String(comp.name) });
    }
    const targets: Array<[string, WrapTarget, Mechanism]> = [
      ['init', {
        entry: comp.name, isTask: false, screenOwner: String(comp.name),
        ...(isScene ? { crumb: 'init' as const } : {}),
        ...(isScreen ? { screen: SCREEN_EXPR, screenVia: via } : {}),
      }, 'init'],
      ['onKeyEvent', { entry: '', isTask: false, crumb: 'key' }, 'key'],
      ...callbacks(rel, comp),
    ];
    // Inherited callbacks: a base Task's script may set functionName to a function this
    // component defines. Ancestors (excluded or not) contribute callbacks, never init/screen.
    const seen = new Set([String(comp.name).toLowerCase()]);
    for (let p = parents.get(String(comp.name).toLowerCase()); p && !seen.has(p.toLowerCase());) {
      seen.add(p.toLowerCase());
      const anc = byName.get(p.toLowerCase());
      if (!anc) break;
      targets.push(...callbacks(anc.rel, anc.comp));
      p = parents.get(p.toLowerCase());
    }
    for (const s of scripts) {
      for (const [fn, t, mech] of targets) {
        if (!on(mech)) continue;
        add(plan, s, fn, { ...t, entry: t.entry || `${fn} (${s})` });
      }
    }
  }

  // SceneGraph runs every ancestor's init() too, with m.top.subtype() the created
  // type. A screen without its own init() is covered by the nearest ancestor that
  // defines one: nothing to add when that ancestor is a screen itself (its init
  // already sets the screen unconditionally), else a guarded call there that
  // names only the screens inheriting it, so non-screen siblings stay untracked.
  const guarded = new Map<string, Set<string>>();
  for (const { name } of inheritsInit) {
    const seen = new Set([name.toLowerCase()]);
    for (let p = parents.get(name.toLowerCase()); p && !seen.has(p.toLowerCase()); p = parents.get(p.toLowerCase())) {
      seen.add(p.toLowerCase());
      const anc = byName.get(p.toLowerCase());
      if (!anc) break;
      const file = scriptsOf(anc.rel, anc.comp).find(definesInit);
      // No init here, or one we may not touch: the next ancestor's init runs as well.
      if (!file || excluded(anc.rel, opts.exclude) || excluded(file, opts.exclude)) continue;
      if (screenVia(String(anc.comp.name), parents, opts.screens ?? []) === undefined) {
        let set = guarded.get(file);
        if (!set) guarded.set(file, (set = new Set()));
        set.add(name);
      }
      break;
    }
  }
  for (const [file, names] of guarded) {
    const t = plan.files.get(file)?.get('init');
    // A shared init whose components disagree keeps its conflict (reported as skipped by the wrapper).
    if (!t || t.screen || t.screenConflict) continue;
    t.screenIf = { expr: SCREEN_EXPR, names: [...names].sort() };
  }
  return plan;
}
