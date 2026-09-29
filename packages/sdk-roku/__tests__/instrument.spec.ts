// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, cpSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'brighterscript';
import { instrument, injectHookImports, OUT_MARKER } from '../src/instrument.js';
import { runBrs } from './brs-harness.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/channel-basic');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'efinst-'));
const read = (p: string) => readFileSync(p, 'utf8');
const HOOKS = ['everframe_hook.brs', 'ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs'];
const stripComments = (t: string) => t.replace(/<!--[\s\S]*?-->/g, '');
const compXml = (name: string, ext: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8" ?>\n<component name="${name}" extends="${ext}">\n${body}</component>\n`;
const scriptTag = (uri: string) => `  <script type="text/brightscript" uri="${uri}" />\n`;
/** brs-cli stand-ins for the hook functions an instrumented init() calls. */
const STUBS = (dir: string) => {
  const f = path.join(dir, 'stubs.brs');
  writeFileSync(f, 'sub Everframe_Screen(name as dynamic)\n  m.seen.Push(name)\nend sub\nsub Everframe_OnError(e as dynamic, entry as string, isTask as boolean)\nend sub\n');
  return f;
};

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
    // Main records GetLastExitInfo (only the channel's own code can read it) before any host code.
    expect(read(path.join(out, 'source/main.brs')).split('\n')[0]).toBe("sub Main() : try : Everframe_RecordLastExit() ' everframe:instrumented");
    expect(read(path.join(out, 'components/HomeScene.brs'))).not.toContain('Everframe_RecordLastExit');
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

  it('accepts --out as a subdirectory of the channel (./.everframe-build) and never copies it into itself', () => {
    const chan = path.join(tmp(), 'chan');
    cpSync(FIX, chan, { recursive: true });
    const out = path.join(chan, '.everframe-build');
    const r1 = instrument({ root: chan, out });
    expect(r1.wrapped.length).toBe(9);
    const r2 = instrument({ root: chan, out });
    expect(r2.wrapped.length).toBe(9);
    expect(existsSync(path.join(out, '.everframe-build', 'components'))).toBe(false);
    expect(existsSync(path.join(out, 'components/HomeScene.brs'))).toBe(true);
    expect(read(path.join(out, 'components/HomeScene.brs'))).toContain('Everframe_OnError');
    expect(read(path.join(chan, 'components/HomeScene.brs'))).toBe(read(path.join(FIX, 'components/HomeScene.brs')));
  });

  it('rejects --out that contains the channel directory', () => {
    const base = tmp();
    const chan = path.join(base, 'chan');
    cpSync(FIX, chan, { recursive: true });
    writeFileSync(path.join(base, '.everframe-build'), '');
    expect(() => instrument({ root: chan, out: base })).toThrow(/must not contain the channel/i);
    expect(existsSync(path.join(chan, 'manifest'))).toBe(true);
  });

  it('writes a marker and removes stale files on the next run', () => {
    const chan = path.join(tmp(), 'chan');
    cpSync(FIX, chan, { recursive: true });
    const out = path.join(tmp(), 'out');
    instrument({ root: chan, out });
    expect(existsSync(path.join(out, '.everframe-build'))).toBe(true);
    expect(existsSync(path.join(out, 'components/Static.xml'))).toBe(true);
    rmSync(path.join(chan, 'components/Static.xml'));
    instrument({ root: chan, out });
    expect(existsSync(path.join(out, 'components/Static.xml'))).toBe(false);
    expect(existsSync(path.join(out, '.everframe-build'))).toBe(true);
  });

  it('refuses to overwrite a non-empty directory it did not create', () => {
    const out = tmp();
    writeFileSync(path.join(out, 'precious.txt'), 'keep me');
    expect(() => instrument({ root: FIX, out })).toThrow(/refusing to overwrite a directory everframe-roku did not create/);
    expect(read(path.join(out, 'precious.txt'))).toBe('keep me');
  });

  it('adds the init lifecycle crumb only to components that extend Scene', () => {
    const out = tmp();
    instrument({ root: FIX, out });
    expect(read(path.join(out, 'components/HomeScene.brs'))).toContain('Everframe_Crumb("lifecycle", "init HomeScene", invalid)');
    const loader = read(path.join(out, 'components/Loader.brs'));
    expect(loader).not.toContain('Everframe_Crumb(');
    expect(loader).toContain('Everframe_OnError(everframe_e, "Loader", false)');
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
  describe('output path aliasing', () => {
    /** A channel copy that also holds a normal `.everframe-build/` build directory. */
    const chanWithBuildDir = () => {
      const base = tmp();
      const chan = path.join(base, 'chan');
      cpSync(FIX, chan, { recursive: true });
      mkdirSync(path.join(chan, '.everframe-build'));
      writeFileSync(path.join(chan, '.everframe-build', 'old.txt'), 'x');
      return { base, chan };
    };

    it('refuses --out that is a symlink to the channel (a .everframe-build/ dir is not a marker)', () => {
      const { base, chan } = chanWithBuildDir();
      const alias = path.join(base, 'alias');
      symlinkSync(chan, alias, 'dir');
      expect(() => instrument({ root: chan, out: alias })).toThrow(/must differ/);
      expect(() => instrument({ root: alias, out: chan })).toThrow(/must differ/);
      expect(existsSync(path.join(chan, 'manifest'))).toBe(true);
      expect(existsSync(path.join(chan, 'components/HomeScene.brs'))).toBe(true);
    });

    it('refuses --out that is (an alias of) an ancestor of the channel', () => {
      const { base, chan } = chanWithBuildDir();
      mkdirSync(path.join(base, '.everframe-build'));
      const alias = path.join(tmp(), 'alias');
      symlinkSync(base, alias, 'dir');
      expect(() => instrument({ root: chan, out: alias })).toThrow(/must not contain the channel/);
      expect(() => instrument({ root: chan, out: path.join(chan, '..') + '/' })).toThrow(/must not contain the channel/);
      expect(existsSync(path.join(chan, 'manifest'))).toBe(true);
    });

    it('--out inside the real channel is skipped even when the channel is named through a symlink', () => {
      const { base, chan } = chanWithBuildDir();
      rmSync(path.join(chan, '.everframe-build'), { recursive: true });
      const alias = path.join(base, 'alias');
      symlinkSync(chan, alias, 'dir');
      const out = path.join(chan, 'build');
      expect(instrument({ root: alias, out }).wrapped.length).toBe(9);
      expect(instrument({ root: alias, out }).wrapped.length).toBe(9);
      expect(existsSync(path.join(out, 'build'))).toBe(false);
      expect(read(path.join(out, 'components/HomeScene.brs'))).toContain('Everframe_OnError');
      // --out named through the alias, not yet existing: canonicalised via its nearest existing ancestor.
      const out2 = path.join(alias, 'b2', 'nested');
      expect(instrument({ root: chan, out: out2 }).wrapped.length).toBe(9);
      expect(instrument({ root: chan, out: out2 }).wrapped.length).toBe(9);
      expect(existsSync(path.join(chan, 'b2/nested/components/HomeScene.brs'))).toBe(true);
      expect(existsSync(path.join(chan, 'b2/nested/b2/nested'))).toBe(false);
    });

    it('only clears a directory whose marker is a regular file written by this tool', () => {
      const cases: Array<(out: string) => void> = [
        (out) => mkdirSync(path.join(out, OUT_MARKER)),
        (out) => writeFileSync(path.join(out, OUT_MARKER), 'something else\n'),
        (out) => {
          const real = path.join(tmp(), 'marker');
          writeFileSync(real, 'Created by everframe-roku instrument. This directory is cleared on every run.\n');
          symlinkSync(real, path.join(out, OUT_MARKER));
        },
      ];
      for (const plant of cases) {
        const out = tmp();
        writeFileSync(path.join(out, 'precious.txt'), 'keep me');
        plant(out);
        expect(() => instrument({ root: FIX, out })).toThrow(/refusing to overwrite/);
        expect(read(path.join(out, 'precious.txt'))).toBe('keep me');
      }
      const out = tmp();
      instrument({ root: FIX, out });
      writeFileSync(path.join(out, 'stale.txt'), 'x');
      instrument({ root: FIX, out });
      expect(existsSync(path.join(out, 'stale.txt'))).toBe(false);
      expect(lstatSync(path.join(out, OUT_MARKER)).isFile()).toBe(true);
    });
  });

  describe('hook imports and XML comments', () => {
    it('injects after the last active script, never into a trailing comment', () => {
      const chan = path.join(tmp(), 'chan');
      cpSync(FIX, chan, { recursive: true });
      const commented = '  <!-- <script type="text/brightscript" uri="Old.brs" /> -->\n' +
        '  <!-- <script type="text/brightscript" uri="pkg:/components/everframe_hook/everframe_hook.brs" /> -->\n';
      writeFileSync(path.join(chan, 'components/Cmt.xml'), compXml('Cmt', 'Group', scriptTag('Cmt.brs') + commented));
      writeFileSync(path.join(chan, 'components/Cmt.brs'), 'sub init()\n  print 1\nend sub\n');
      const out = tmp();
      const r = instrument({ root: chan, out });
      const text = read(path.join(out, 'components/Cmt.xml'));
      expect(text).toContain(commented);
      const active = stripComments(text);
      for (const f of HOOKS) expect(active).toContain(`uri="pkg:/components/everframe_hook/${f}"`);
      expect(active.indexOf('everframe_hook.brs')).toBeGreaterThan(active.indexOf('uri="Cmt.brs"'));
      expect(r.injected).toContain('components/Cmt.xml');
    });

    it('injectHookImports: ignores commented and CDATA scripts; with no active script inserts before </component>; idempotent', () => {
      const cdata = '  <script type="text/brightscript"><![CDATA[ x = "<script uri=\\"a.brs\\"/>" ]]></script>\n  <!-- <script uri="z.brs" /> -->\n';
      const withInline = injectHookImports(compXml('A', 'Group', cdata));
      expect(withInline).toContain(']]></script>\n  <script type="text/brightscript" uri="pkg:/components/everframe_hook/everframe_hook.brs" />');
      expect(stripComments(withInline).match(/everframe_hook\//g)).toHaveLength(HOOKS.length);
      const none = injectHookImports(compXml('B', 'Group', '  <!-- <script uri="z.brs" /> -->\n'));
      expect(none).toMatch(/ef_queue\.brs" \/>\n<\/component>\n$/);
      for (const f of HOOKS) expect(stripComments(none)).toContain(`pkg:/components/everframe_hook/${f}`);
      expect(injectHookImports(none)).toBe(none);
      expect(() => injectHookImports('<component name="C" extends="Group" />')).toThrow(/no <script> or <\/component>/);
    });
  });

  it('an excluded component sharing a wrapped script still gets the hook imports', () => {
    const chan = path.join(tmp(), 'chan');
    cpSync(FIX, chan, { recursive: true });
    writeFileSync(path.join(chan, 'components/Keep.xml'), compXml('Keep', 'Group', scriptTag('Shared.brs')));
    writeFileSync(path.join(chan, 'components/Drop.xml'), compXml('Drop', 'Group', scriptTag('pkg:/components/Shared.brs')));
    writeFileSync(path.join(chan, 'components/Shared.brs'), 'sub init()\n  print 1\nend sub\n');
    const out = tmp();
    const r = instrument({ root: chan, out, exclude: ['components/Drop.xml'] });
    expect(r.wrapped).toContainEqual({ file: 'components/Shared.brs', fn: 'init' });
    for (const x of ['Keep', 'Drop']) {
      for (const f of HOOKS) expect(read(path.join(out, `components/${x}.xml`)), x).toContain(`pkg:/components/everframe_hook/${f}`);
      expect(r.injected).toContain(`components/${x}.xml`);
    }
    // Excluding a component whose script is not shared leaves it untouched.
    const r2 = instrument({ root: chan, out: tmp(), exclude: ['components/Drop.xml', 'components/Keep.xml'] });
    expect(r2.injected).not.toContain('components/Drop.xml');
  });

  it('wraps a Task function whose functionName is set by the base Task', () => {
    const chan = path.join(tmp(), 'chan');
    cpSync(FIX, chan, { recursive: true });
    writeFileSync(path.join(chan, 'components/BaseTask.xml'), compXml('BaseTask', 'Task', scriptTag('BaseTask.brs')));
    writeFileSync(path.join(chan, 'components/BaseTask.brs'), 'sub init()\n  m.top.functionName = "runTask"\nend sub\n');
    writeFileSync(path.join(chan, 'components/MyTask.xml'), compXml('MyTask', 'BaseTask', scriptTag('MyTask.brs')));
    writeFileSync(path.join(chan, 'components/MyTask.brs'), 'sub runTask()\n  print 1\nend sub\n');
    const out = tmp();
    const r = instrument({ root: chan, out });
    expect(r.wrapped).toContainEqual({ file: 'components/MyTask.brs', fn: 'runTask' });
    expect(read(path.join(out, 'components/MyTask.brs'))).toContain('Everframe_OnError(everframe_e, "runTask (components/MyTask.brs)", true)');
  });

  it('wraps the base implementation of a functionName the derived Task sets, with hook imports in both XMLs', () => {
    const chan = path.join(tmp(), 'chan');
    cpSync(FIX, chan, { recursive: true });
    writeFileSync(path.join(chan, 'components/BaseTask.xml'), compXml('BaseTask', 'Task', scriptTag('BaseTask.brs')));
    writeFileSync(path.join(chan, 'components/BaseTask.brs'), 'sub work()\n  print 1\nend sub\n');
    writeFileSync(path.join(chan, 'components/ChildTask.xml'), compXml('ChildTask', 'BaseTask', scriptTag('ChildTask.brs')));
    writeFileSync(path.join(chan, 'components/ChildTask.brs'), 'sub init()\n  m.top.functionName = "work"\nend sub\n');
    const out = tmp();
    const r = instrument({ root: chan, out });
    expect(r.wrapped).toContainEqual({ file: 'components/BaseTask.brs', fn: 'work' });
    expect(read(path.join(out, 'components/BaseTask.brs'))).toContain('Everframe_OnError(everframe_e, "work (components/BaseTask.brs)", true)');
    for (const x of ['BaseTask', 'ChildTask']) {
      for (const f of HOOKS) expect(read(path.join(out, `components/${x}.xml`)), x).toContain(`pkg:/components/everframe_hook/${f}`);
      expect(r.injected).toContain(`components/${x}.xml`);
    }
  });

  describe('screens', () => {
    const withScreens = () => {
      const chan = path.join(tmp(), 'chan');
      cpSync(FIX, chan, { recursive: true });
      writeFileSync(
        path.join(chan, 'components/DetailsScreen.xml'),
        '<?xml version="1.0" encoding="utf-8" ?>\n<component name="DetailsScreen" extends="Group">\n  <script type="text/brightscript" uri="DetailsScreen.brs" />\n</component>\n',
      );
      writeFileSync(path.join(chan, 'components/DetailsScreen.brs'), "' details\nsub init()\n  m.top.visible = true\nend sub\n");
      return chan;
    };

    it('by default tracks components named *Screen/*View/*Page on the init signature line', () => {
      const chan = withScreens();
      const out = tmp();
      const r = instrument({ root: chan, out });
      expect(r.screens).toEqual([{ component: 'DetailsScreen', via: 'DetailsScreen', file: 'components/DetailsScreen.brs' }]);
      const before = read(path.join(chan, 'components/DetailsScreen.brs'));
      const after = read(path.join(out, 'components/DetailsScreen.brs'));
      expect(after.split('\n')).toHaveLength(before.split('\n').length);
      expect(after.split('\n')[1]).toBe(`sub init() : try : Everframe_Screen(m.top.subtype()) ' everframe:instrumented`);
      expect(Parser.parse(after).diagnostics).toEqual([]);
      // HomeScene is a Scene: lifecycle crumb, no screen (not matched by the defaults).
      expect(read(path.join(out, 'components/HomeScene.brs'))).not.toContain('Everframe_Screen');
      expect(read(path.join(out, 'components/DetailsScreen.xml'))).toContain('pkg:/components/everframe_hook/everframe_hook.brs');
    });

    it('screens: [] disables it; custom patterns are case-insensitive', () => {
      const chan = withScreens();
      const none = instrument({ root: chan, dryRun: true, screens: [] });
      expect(none.screens).toEqual([]);
      expect(none.wrapped.some((w) => w.file === 'components/DetailsScreen.brs')).toBe(true);
      const custom = instrument({ root: chan, dryRun: true, screens: ['homescene', 'DETAILS*'] });
      expect(custom.screens.map((s) => s.component).sort()).toEqual(['DetailsScreen', 'HomeScene']);
      const out = tmp();
      instrument({ root: chan, out, screens: ['homescene'] });
      expect(read(path.join(out, 'components/HomeScene.brs'))).toContain('Everframe_Crumb("lifecycle", "init HomeScene", invalid) : Everframe_Screen(m.top.subtype())');
    });

    describe('inheritance', () => {
      const xml = (name: string, ext: string) =>
        `<?xml version="1.0" encoding="utf-8" ?>\n<component name="${name}" extends="${ext}">\n  <script type="text/brightscript" uri="${name}.brs" />\n</component>\n`;
      const inherited = () => {
        const chan = path.join(tmp(), 'chan');
        mkdirSync(path.join(chan, 'components'), { recursive: true });
        mkdirSync(path.join(chan, 'source'), { recursive: true });
        writeFileSync(path.join(chan, 'manifest'), 'title=t\n');
        const comps: Array<[string, string, boolean]> = [
          ['Page', 'Group', true], ['Home', 'Page', false], ['Movies', 'Page', true],
          ['Settings', 'Group', true], ['DeepPage', 'Movies', false],
        ];
        for (const [n, e, init] of comps) {
          writeFileSync(path.join(chan, 'components', `${n}.xml`), xml(n, e));
          writeFileSync(path.join(chan, 'components', `${n}.brs`), init ? `sub init()\n  m.top.visible = true\nend sub\n` : `sub helper()\n  print 1\nend sub\n`);
        }
        return chan;
      };

      it('reports screens with via; emits the subtype call only in files that define init', () => {
        const chan = inherited();
        const dry = instrument({ root: chan, dryRun: true });
        const rows = dry.screens.map((s) => [s.component, s.via, s.file ?? null]).sort();
        expect(rows).toEqual([
          ['DeepPage', 'DeepPage', 'components/Movies.brs'],
          ['Home', 'Page', 'components/Page.brs'],
          ['Movies', 'Page', 'components/Movies.brs'],
          ['Page', 'Page', 'components/Page.brs'],
        ]);
        const out = tmp();
        instrument({ root: chan, out });
        for (const n of ['Page', 'Movies']) {
          const before = read(path.join(chan, `components/${n}.brs`));
          const after = read(path.join(out, `components/${n}.brs`));
          expect(after.split('\n')[0]).toBe(`sub init() : try : Everframe_Screen(m.top.subtype()) ' everframe:instrumented`);
          expect(after.split('\n')).toHaveLength(before.split('\n').length);
          expect(Parser.parse(after).diagnostics).toEqual([]);
        }
        for (const n of ['Home', 'DeepPage', 'Settings']) {
          expect(read(path.join(out, `components/${n}.brs`))).not.toContain('Everframe_Screen');
        }
      });

      const baseTree = () => {
        const chan = path.join(tmp(), 'chan');
        mkdirSync(path.join(chan, 'components'), { recursive: true });
        writeFileSync(path.join(chan, 'manifest'), 'title=t\n');
        const comps: Array<[string, string, boolean]> = [['Base', 'Group', true], ['DetailsScreen', 'Base', false], ['Widget', 'Base', false]];
        for (const [n, e, init] of comps) {
          writeFileSync(path.join(chan, 'components', `${n}.xml`), xml(n, e));
          writeFileSync(path.join(chan, 'components', `${n}.brs`), init ? `' base\nsub init()\n  m.top.visible = true\nend sub\n` : `sub helper()\n  print 1\nend sub\n`);
        }
        return chan;
      };

      it('a screen inheriting init from a non-screen base: guarded call in the base, listing only screens', () => {
        const chan = baseTree();
        const out = tmp();
        const r = instrument({ root: chan, out });
        expect(r.screens).toEqual([{ component: 'DetailsScreen', via: 'DetailsScreen', file: 'components/Base.brs' }]);
        const before = read(path.join(chan, 'components/Base.brs'));
        const after = read(path.join(out, 'components/Base.brs'));
        expect(after.split('\n')[1]).toBe(`sub init() : try : Everframe_ScreenIf(m.top.subtype(), "DetailsScreen") ' everframe:instrumented`);
        expect(after.split('\n')).toHaveLength(before.split('\n').length);
        expect(Parser.parse(after).diagnostics).toEqual([]);
        expect(after).not.toContain('Widget');
        for (const n of ['DetailsScreen', 'Widget']) expect(read(path.join(out, `components/${n}.brs`))).not.toContain('Everframe_Screen');
        // Base.xml imports the hook (its script now calls it).
        expect(read(path.join(out, 'components/Base.xml'))).toContain('pkg:/components/everframe_hook/everframe_hook.brs');
      });

      it('runtime: the guarded base init sets the screen for the listed subtype only', async () => {
        const chan = baseTree();
        const out = tmp();
        instrument({ root: chan, out });
        const dir = tmp();
        const baseFile = path.join(dir, 'Base.brs');
        writeFileSync(baseFile, read(path.join(out, 'components/Base.brs')));
        const stubs = path.join(dir, 'stubs2.brs');
        writeFileSync(stubs, 'sub Everframe_ScreenIf(name as dynamic, names as dynamic)\n  if Instr(1, "," + names + ",", "," + name + ",") > 0 then m.seen.Push(name)\nend sub\nsub Everframe_OnError(e as dynamic, entry as string, isTask as boolean)\nend sub\n');
        const { lines } = await runBrs([], `
          m.seen = []
          m.top = { kind: "Widget", subtype: function() as string
            return m.kind
          end function }
          init()
          m.top.kind = "DetailsScreen"
          init()
          print "EFTEST:" + FormatJson(m.seen)
        `, { extraFiles: [baseFile, stubs] });
        expect(lines[0]).toEqual(['DetailsScreen']);
      });

      it('runtime: the emitted line passes the concrete subtype, so base + subclass init both firing is harmless', async () => {
        const chan = inherited();
        const out = tmp();
        instrument({ root: chan, out });
        const after = read(path.join(out, 'components/Page.brs'));
        const dir = tmp();
        const pageFile = path.join(dir, 'Page.brs');
        writeFileSync(pageFile, after);
        // SceneGraph is off: stand in for m.top with an AA that has subtype().
        const { lines } = await runBrs([], `
          m.seen = []
          m.top = { subtype: function() as string
            return "Home"
          end function }
          init()
          init()
          print "EFTEST:" + FormatJson(m.seen)
        `, { extraFiles: [pageFile, STUBS(dir)] });
        expect(lines[0]).toEqual(['Home', 'Home']);
      });
    });
  });
});
