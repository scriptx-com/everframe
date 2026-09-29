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
    expect(initOf(plan, 'components/DetailsScreen.brs')).toMatchObject({ entry: 'DetailsScreen', screen: 'DetailsScreen' });
    expect(initOf(plan, 'components/homeview.brs')).toMatchObject({ screen: 'homeview' });
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
    expect(initOf(plan, 'components/HomePage.brs')).toMatchObject({ crumb: 'init', screen: 'HomePage' });
  });

  it('a script shared by components with different screen names gets no automatic screen', () => {
    const root = channel([['AScreen', 'Group', 'Shared.brs'], ['BScreen', 'Group', 'Shared.brs']]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    const t = initOf(plan, 'components/Shared.brs');
    expect(t?.screen).toBeUndefined();
    expect(t?.screenConflict).toEqual(['AScreen', 'BScreen']);
  });

  it('no screen when the init mechanism is off', () => {
    const root = channel([['DetailsScreen', 'Group']]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: new Set<Mechanism>(['key']), screens: DEFAULT_SCREENS });
    expect(initOf(plan, 'components/DetailsScreen.brs')).toBeUndefined();
  });
});
