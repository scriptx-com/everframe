// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'brighterscript';
import { XMLParser } from 'fast-xml-parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('crash lab channel source', () => {
  const files = [...walk(path.join(ROOT, 'source')), ...walk(path.join(ROOT, 'components'))].filter(
    (f) => !f.includes(`${path.sep}generated${path.sep}`),
  );

  it('every .brs parses without diagnostics', () => {
    for (const f of files.filter((x) => x.endsWith('.brs'))) {
      expect(Parser.parse(readFileSync(f, 'utf8')).diagnostics, f).toEqual([]);
    }
  });

  it('every XML script uri exists (except the generated config)', () => {
    const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
    for (const f of files.filter((x) => x.endsWith('.xml'))) {
      const doc = xml.parse(readFileSync(f, 'utf8'));
      for (const s of [doc.component.script].flat().filter(Boolean)) {
        if (s.uri === 'pkg:/components/generated/ef_config.brs') continue;
        expect(statSync(path.join(ROOT, s.uri.replace('pkg:/', ''))).isFile(), `${f} -> ${s.uri}`).toBe(true);
      }
    }
  });

  it('never calls GetLastExitInfo itself (not allowed on the render thread; the instrumented Main records it for the SDK)', () => {
    for (const f of files.filter((x) => x.endsWith('.brs'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\.GetLastExitInfo\(|CreateObject\("roAppManager"\)/);
    }
    expect(readFileSync(path.join(ROOT, 'components/LabScene.brs'), 'utf8')).toMatch(/sec\.Read\("lastExitTs"\)/);
    expect(readFileSync(path.join(ROOT, 'components/LabScene.brs'), 'utf8')).toMatch(/sec\.Exists\("pendingExit"\)/);
  });

  it('lists all nine scenarios in order', () => {
    const brs = readFileSync(path.join(ROOT, 'components/LabScene.brs'), 'utf8');
    const ids = [...brs.matchAll(/\{ id: "([a-z_]+)", title:/g)].map((m) => m[1]);
    expect(ids).toEqual([
      'crash_select', 'crash_key', 'crash_task', 'crash_main', 'handled',
      'crash_excluded', 'oom', 'crash_loop', 'user_crumbs',
    ]);
  });

  it('keeps the excluded crash in Excluded.brs as a Timer callback', () => {
    const excluded = readFileSync(path.join(ROOT, 'components/Excluded.brs'), 'utf8');
    expect(excluded).toMatch(/sub onCrashExcluded\(\)/);
    const scene = readFileSync(path.join(ROOT, 'components/LabScene.brs'), 'utf8');
    expect(scene).toMatch(/observeField\("fire", "onCrashExcluded"\)/);
    expect(scene).not.toMatch(/\bonCrashExcluded\(\)/); // never called directly from wrapped code
  });

  it('crashes the loop scenario from a repeating Timer callback after the queue drains', () => {
    const scene = readFileSync(path.join(ROOT, 'components/LabScene.brs'), 'utf8');
    expect(scene).toMatch(/observeField\("fire", "onLoopTick"\)/);
    const body = scene.match(/sub onLoopTick\(\)([\s\S]*?)end sub/)?.[1] ?? '';
    expect(body).toMatch(/LabQueueCount\(\) = 0/);
    expect(body).toMatch(/15000/);
    expect(body).toMatch(/LabCrashNow\("crash loop"\)/);
    expect(scene).toMatch(/m\.loopTimer\.repeat = true/);
  });

  it('refreshes the status panel on a timer and shows a guarded user line', () => {
    const scene = readFileSync(path.join(ROOT, 'components/LabScene.brs'), 'utf8');
    expect(scene).toMatch(/observeField\("fire", "onStatusTick"\)/);
    expect(scene).toMatch(/callFunc\("getUser", invalid\)/);
    expect(scene).toMatch(/"User: "/);
  });

  it('shows a guarded Memory line from the SDK\'s registry "mem" reading', () => {
    const scene = readFileSync(path.join(ROOT, 'components/LabScene.brs'), 'utf8');
    expect(scene).toMatch(/"Memory: "/);
    const body = scene.match(/function LabMemory\(\)([\s\S]*?)end function/)?.[1] ?? '';
    expect(body).toMatch(/sec\.Exists\("mem"\)/);
    expect(body).toMatch(/ParseJson/);
    expect(body).toMatch(/roAssociativeArray/);
    expect(scene).not.toMatch(/roAppMemoryMonitor/); // not allowed on the render thread
  });
});
