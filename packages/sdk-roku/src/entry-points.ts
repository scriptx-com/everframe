// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { WrapTarget } from './wrap.js';

export type Mechanism = 'main' | 'init' | 'key' | 'observer' | 'task' | 'callfunc';
export const ALL_MECHANISMS: Mechanism[] = ['main', 'init', 'key', 'observer', 'task', 'callfunc'];

export interface EntryPlan {
  files: Map<string, Map<string, WrapTarget>>;
  components: Array<{ xml: string; name: string; scripts: string[] }>;
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
  if (!m.has(fn.toLowerCase())) m.set(fn.toLowerCase(), target);
}

/** `skipDir`: absolute path excluded from discovery (the --out dir when it sits inside the channel). */
export function discoverEntryPoints(root: string, opts: { exclude: string[]; mechanisms: Set<Mechanism>; skipDir?: string }): EntryPlan {
  const plan: EntryPlan = { files: new Map(), components: [] };
  const all = walk(root, root, opts.skipDir);
  const on = (m: Mechanism) => opts.mechanisms.has(m);

  if (on('main')) {
    for (const rel of all.filter((f) => f.startsWith('source/') && !f.startsWith('source/everframe/') && f.endsWith('.brs'))) {
      if (excluded(rel, opts.exclude)) continue;
      for (const fn of ['main', 'runuserinterface']) add(plan, rel, fn, { entry: `Main (${rel})`, isTask: false, prelude: 'recordExit' });
    }
  }

  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  for (const rel of all.filter((f) => f.startsWith('components/') && f.endsWith('.xml'))) {
    if (excluded(rel, opts.exclude)) continue;
    const doc = xml.parse(readFileSync(path.join(root, rel), 'utf8'));
    const comp = doc?.component;
    if (!comp?.name) continue;
    const scripts: string[] = [comp.script].flat().filter(Boolean)
      .map((s: { uri?: string }) => s.uri ?? '')
      .filter((u: string) => u.endsWith('.brs'))
      .map((u: string) => (u.startsWith('pkg:/') ? u.slice(5) : path.posix.join(path.posix.dirname(rel), u)))
      .filter((s: string) => !s.startsWith('components/everframe_hook/') && !excluded(s, opts.exclude));
    plan.components.push({ xml: rel, name: comp.name, scripts });
    if (scripts.length === 0) continue;

    const iface = comp.interface ?? {};
    // Lifecycle crumbs only for the scene: every component's init would flood the ring.
    const isScene = comp.extends === 'Scene';
    const targets: Array<[string, WrapTarget, Mechanism]> = [
      ['init', { entry: comp.name, isTask: false, ...(isScene ? { crumb: 'init' as const } : {}) }, 'init'],
      ['onKeyEvent', { entry: '', isTask: false, crumb: 'key' }, 'key'],
    ];
    for (const f of [iface.field].flat().filter(Boolean)) {
      if (f.onChange) targets.push([f.onChange, { entry: '', isTask: false }, 'observer']);
    }
    for (const f of [iface.function].flat().filter(Boolean)) {
      if (f.name) targets.push([f.name, { entry: '', isTask: false }, 'callfunc']);
    }
    for (const s of scripts) {
      let text = '';
      try { text = readFileSync(path.join(root, s), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(OBSERVE_RE)) targets.push([m[1]!, { entry: '', isTask: false }, 'observer']);
      for (const m of text.matchAll(TASK_RE)) targets.push([m[1]!, { entry: '', isTask: true }, 'task']);
    }
    for (const s of scripts) {
      for (const [fn, t, mech] of targets) {
        if (!on(mech)) continue;
        add(plan, s, fn, { ...t, entry: t.entry || `${fn} (${s})` });
      }
    }
  }
  return plan;
}
