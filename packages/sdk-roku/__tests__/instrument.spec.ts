// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, cpSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'brighterscript';
import { instrument } from '../src/instrument.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/channel-basic');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'efinst-'));
const read = (p: string) => readFileSync(p, 'utf8');

describe('instrument', () => {
  it('wraps every entry-point kind and nothing else', () => {
    const out = tmp();
    const r = instrument({ root: FIX, out });
    const got = r.wrapped.map((w) => `${w.file}:${w.fn}`).sort();
    expect(got).toEqual([
      'components/HomeScene.brs:OnFocus',
      'components/HomeScene.brs:OnKeyEvent',
      'components/HomeScene.brs:OnTitle',
      'components/HomeScene.brs:init',
      'components/HomeScene.brs:onContent',
      'components/HomeScene.brs:refresh',
      'components/Loader.brs:init',
      'components/Loader.brs:load',
      'source/main.brs:Main',
    ]);
    expect(read(path.join(out, 'components/Loader.brs'))).toContain('Everframe_OnError(everframe_e, "load (components/Loader.brs)", true)');
    expect(read(path.join(out, 'components/HomeScene.brs'))).toContain('Everframe_KeyCrumb(key, press)');
  });

  it('keeps every file line-count identical and parse-clean', () => {
    const out = tmp();
    instrument({ root: FIX, out });
    for (const rel of ['source/main.brs', 'components/HomeScene.brs', 'components/Loader.brs']) {
      const before = read(path.join(FIX, rel));
      const after = read(path.join(out, rel));
      expect(after.split('\n').length, rel).toBe(before.split('\n').length);
      expect(Parser.parse(after).diagnostics, rel).toEqual([]);
    }
  });

  it('injects the hook set into scripted components and source/', () => {
    const out = tmp();
    const r = instrument({ root: FIX, out });
    const home = read(path.join(out, 'components/HomeScene.xml'));
    for (const f of ['everframe_hook.brs', 'ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs']) {
      expect(home).toContain(`uri="pkg:/components/everframe_hook/${f}"`);
      expect(existsSync(path.join(out, 'components/everframe_hook', f))).toBe(true);
      expect(existsSync(path.join(out, 'source/everframe', f))).toBe(true);
    }
    expect(read(path.join(out, 'components/Static.xml'))).toBe(read(path.join(FIX, 'components/Static.xml')));
    expect(r.injected.sort()).toEqual(['components/HomeScene.xml', 'components/Loader.xml']);
  });

  it('is idempotent when run on its own output', () => {
    const out1 = tmp();
    instrument({ root: FIX, out: out1 });
    const out2 = tmp();
    const r2 = instrument({ root: out1, out: out2 });
    expect(r2.wrapped).toEqual([]);
    for (const rel of ['components/HomeScene.brs', 'components/HomeScene.xml', 'source/main.brs']) {
      expect(read(path.join(out2, rel))).toBe(read(path.join(out1, rel)));
    }
  });

  it('never modifies the source tree', () => {
    const before = read(path.join(FIX, 'components/HomeScene.brs'));
    instrument({ root: FIX, out: tmp() });
    expect(read(path.join(FIX, 'components/HomeScene.brs'))).toBe(before);
  });

  it('honours --exclude and --mechanisms', () => {
    const r = instrument({ root: FIX, out: tmp(), exclude: ['components/Loader.*'], mechanisms: ['main', 'key'] });
    expect(r.wrapped.map((w) => w.fn).sort()).toEqual(['Main', 'OnKeyEvent']);
  });

  it('dry run writes nothing', () => {
    const out = path.join(tmp(), 'never');
    const r = instrument({ root: FIX, out, dryRun: true });
    expect(r.wrapped.length).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses to write into the source directory', () => {
    expect(() => instrument({ root: FIX, out: FIX })).toThrow(/out.*must differ/i);
  });

  it('dry run needs no --out', () => {
    const r = instrument({ root: FIX, dryRun: true });
    expect(r.wrapped.length).toBe(9);
  });

  it('requires --out when not a dry run', () => {
    expect(() => instrument({ root: FIX })).toThrow(/--out is required/);
  });

  it('rejects --out inside the channel directory', () => {
    expect(() => instrument({ root: FIX, out: path.join(FIX, 'build') })).toThrow(/--out must not be inside the channel directory/);
    expect(existsSync(path.join(FIX, 'build'))).toBe(false);
  });

  it('does not write through symlinks or loop on symlink cycles', () => {
    const base = tmp();
    const chan = path.join(base, 'chan');
    cpSync(FIX, chan, { recursive: true });
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    const target = path.join(outside, 'Linked.brs');
    writeFileSync(target, 'sub init()\nend sub\n');
    symlinkSync(target, path.join(chan, 'components/Linked.brs'));
    symlinkSync(chan, path.join(chan, 'components/loop'), 'dir');
    writeFileSync(
      path.join(chan, 'components/Linked.xml'),
      '<?xml version="1.0" encoding="utf-8" ?>\n<component name="Linked" extends="Group">\n  <script type="text/brightscript" uri="Linked.brs" />\n</component>\n',
    );
    const before = read(target);
    const out = path.join(base, 'out');
    const r = instrument({ root: chan, out });
    expect(r.wrapped.some((w) => w.file === 'components/Linked.brs')).toBe(true);
    expect(read(target)).toBe(before);
    expect(lstatSync(path.join(out, 'components/Linked.brs')).isSymbolicLink()).toBe(false);
    expect(read(path.join(out, 'components/Linked.brs'))).toContain('Everframe_OnError');
  });
});
