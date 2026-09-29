// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverEntryPoints, matchesScreen, parseScreens, DEFAULT_SCREENS, ALL_MECHANISMS, type Mechanism } from '../src/entry-points.js';

const comp = (name: string, ext: string, script: string) =>
  `<?xml version="1.0" encoding="utf-8" ?>\n<component name="${name}" extends="${ext}">\n  <script type="text/brightscript" uri="${script}" />\n</component>\n`;

function channel(components: Array<[name: string, ext: string, script?: string]>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'efep-'));
  mkdirSync(path.join(root, 'components'), { recursive: true });
  for (const [name, ext, script = `${name}.brs`] of components) {
    writeFileSync(path.join(root, 'components', `${name}.xml`), comp(name, ext, script));
    writeFileSync(path.join(root, 'components', script), 'sub init()\n  print 1\nend sub\n');
  }
  return root;
}
const all = new Set<Mechanism>(ALL_MECHANISMS);
const initOf = (plan: ReturnType<typeof discoverEntryPoints>, file: string) => plan.files.get(file)?.get('init');

describe('screen patterns', () => {
  it('defaults to *Screen, *View, *Page', () => {
    expect(DEFAULT_SCREENS).toEqual(['*Screen', '*View', '*Page']);
    expect(parseScreens(undefined)).toEqual(DEFAULT_SCREENS);
  });

  it('parses a comma list, trims, drops empties; "none" disables', () => {
    expect(parseScreens(' Home* , ,*Details ')).toEqual(['Home*', '*Details']);
    expect(parseScreens('none')).toEqual([]);
    expect(parseScreens('NONE')).toEqual([]);
  });

  it('matches the whole component name, case-insensitively, with * and ?', () => {
    expect(matchesScreen('DetailsScreen', DEFAULT_SCREENS)).toBe(true);
    expect(matchesScreen('detailsscreen', DEFAULT_SCREENS)).toBe(true);
    expect(matchesScreen('GridVIEW', DEFAULT_SCREENS)).toBe(true);
    expect(matchesScreen('Page', DEFAULT_SCREENS)).toBe(true);
    expect(matchesScreen('ScreenSaver', DEFAULT_SCREENS)).toBe(false);
    expect(matchesScreen('Loader', DEFAULT_SCREENS)).toBe(false);
    expect(matchesScreen('Home1', ['Home?'])).toBe(true);
    expect(matchesScreen('a.b', ['a.b'])).toBe(true);
    expect(matchesScreen('axb', ['a.b'])).toBe(false); // regex metacharacters are literal
    expect(matchesScreen('Anything', [])).toBe(false);
  });
});

describe('discoverEntryPoints: screens', () => {
  it('marks init of matching components with their name; others and Scenes keep their usual targets', () => {
    const root = channel([['DetailsScreen', 'Group'], ['homeview', 'Group'], ['Loader', 'Task'], ['MainScene', 'Scene']]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    expect(initOf(plan, 'components/DetailsScreen.brs')).toMatchObject({ entry: 'DetailsScreen', screen: 'm.top.subtype()', screenVia: 'DetailsScreen' });
    expect(initOf(plan, 'components/homeview.brs')).toMatchObject({ screen: 'm.top.subtype()', screenVia: 'homeview' });
    expect(initOf(plan, 'components/Loader.brs')?.screen).toBeUndefined();
    expect(initOf(plan, 'components/MainScene.brs')).toMatchObject({ crumb: 'init' });
    expect(initOf(plan, 'components/MainScene.brs')?.screen).toBeUndefined();
  });

  it('screens: [] (--screens none) marks nothing', () => {
    const root = channel([['DetailsScreen', 'Group']]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: [] });
    expect(initOf(plan, 'components/DetailsScreen.brs')?.screen).toBeUndefined();
  });

  it('a matching Scene gets both the lifecycle crumb and the screen', () => {
    const root = channel([['HomePage', 'Scene']]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    expect(initOf(plan, 'components/HomePage.brs')).toMatchObject({ crumb: 'init', screen: 'm.top.subtype()' });
  });

  it('a script shared by two screens keeps the screen (subtype is the same for both)', () => {
    const root = channel([['AScreen', 'Group', 'Shared.brs'], ['BScreen', 'Group', 'Shared.brs']]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    const t = initOf(plan, 'components/Shared.brs');
    expect(t?.screen).toBe('m.top.subtype()');
    expect(t?.screenConflict).toBeUndefined();
  });

  it('a script shared by a screen and a non-screen gets no automatic screen', () => {
    const root = channel([['AScreen', 'Group', 'Shared.brs'], ['Loader', 'Group', 'Shared.brs']]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    const t = initOf(plan, 'components/Shared.brs');
    expect(t?.screen).toBeUndefined();
    expect(t?.screenConflict).toEqual(['AScreen', 'Loader']);
  });

  it('no screen when the init mechanism is off', () => {
    const root = channel([['DetailsScreen', 'Group']]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: new Set<Mechanism>(['key']), screens: DEFAULT_SCREENS });
    expect(initOf(plan, 'components/DetailsScreen.brs')).toBeUndefined();
  });
});

describe('screen inheritance', () => {
  function tree(comps: Array<[name: string, ext: string, init: boolean]>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'efinh-'));
    mkdirSync(path.join(root, 'components'), { recursive: true });
    for (const [name, ext, init] of comps) {
      writeFileSync(path.join(root, 'components', `${name}.xml`), comp(name, ext, `${name}.brs`));
      writeFileSync(path.join(root, 'components', `${name}.brs`), init ? 'sub init()\n  print 1\nend sub\n' : 'sub other()\n  print 1\nend sub\n');
    }
    return root;
  }
  const fixture = () => tree([
    ['Page', 'Group', true], ['Home', 'Page', false], ['Movies', 'Page', true],
    ['Settings', 'Group', true], ['DeepPage', 'Movies', false],
  ]);

  it('a component is a screen when its own name or any ancestor matches', () => {
    const plan = discoverEntryPoints(fixture(), { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    const byName = Object.fromEntries(plan.screens.map((s) => [s.component, s.via]));
    expect(byName).toEqual({ Page: 'Page', Home: 'Page', Movies: 'Page', DeepPage: 'DeepPage' });
    expect(plan.screens.some((s) => s.component === 'Settings')).toBe(false);
  });

  it('via is the first match walking up: a grandchild of Page via Page when its own name does not match', () => {
    const root = tree([['Page', 'Group', true], ['Movies', 'Page', true], ['Deep', 'Movies', true]]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: ['Page'] });
    expect(plan.screens).toEqual(expect.arrayContaining([{ component: 'Deep', via: 'Page' }, { component: 'Movies', via: 'Page' }]));
  });

  it('init targets use m.top.subtype() and only where an init is defined', () => {
    const plan = discoverEntryPoints(fixture(), { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    expect(initOf(plan, 'components/Page.brs')?.screen).toBe('m.top.subtype()');
    expect(initOf(plan, 'components/Movies.brs')?.screen).toBe('m.top.subtype()');
    expect(initOf(plan, 'components/Settings.brs')?.screen).toBeUndefined();
  });

  it('matching is case-insensitive on ancestors and parent lookup', () => {
    const root = tree([['Base', 'Group', true], ['Kid', 'base', true]]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: ['BASE'] });
    expect(plan.screens).toEqual([{ component: 'Base', via: 'Base' }, { component: 'Kid', via: 'base' }]);
  });

  it('survives inheritance cycles and missing parents', () => {
    const root = tree([['A', 'B', true], ['B', 'A', true], ['Orphan', 'DoesNotExist', true], ['Self', 'Self', true]]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    expect(plan.screens).toEqual([]);
    const plan2 = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: ['B'] });
    expect(plan2.screens.map((s) => s.component).sort()).toEqual(['A', 'B']);
  });

  it('no screens when the init mechanism is off', () => {
    const plan = discoverEntryPoints(fixture(), { exclude: [], mechanisms: new Set<Mechanism>(['key']), screens: DEFAULT_SCREENS });
    expect(plan.screens).toEqual([]);
  });
});
