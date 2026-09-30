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

  it('a screen without its own init gets a guarded call in the nearest non-screen ancestor that defines init', () => {
    const root = tree([
      ['Base', 'Group', true], ['DetailsScreen', 'Base', false], ['Widget', 'Base', false],
      ['MidView', 'Base', false], ['DeepScreen', 'MidView', false], ['OwnScreen', 'Base', true],
    ]);
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    const base = initOf(plan, 'components/Base.brs');
    expect(base?.screen).toBeUndefined();
    // Every screen that inherits Base's init, and no non-screen (Widget) nor one with its own init (OwnScreen).
    expect(base?.screenIf).toEqual({ expr: 'm.top.subtype()', names: ['DeepScreen', 'DetailsScreen', 'MidView'] });
    expect(initOf(plan, 'components/OwnScreen.brs')?.screen).toBe('m.top.subtype()');
  });

  it('no guarded call when the ancestor already sets the screen, or its init script is excluded / shared with a conflict', () => {
    // Page matches: its unconditional call already covers Home.
    const plan = discoverEntryPoints(fixture(), { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    expect(initOf(plan, 'components/Page.brs')?.screenIf).toBeUndefined();

    const root = tree([['Base', 'Group', true], ['DetailsScreen', 'Base', false]]);
    const excl = discoverEntryPoints(root, { exclude: ['components/Base.brs'], mechanisms: all, screens: DEFAULT_SCREENS });
    expect(excl.files.has('components/Base.brs')).toBe(false);

    // Base.brs is also FooScreen's own script: a screen and a non-screen disagree, keep the conflict.
    writeFileSync(path.join(root, 'components', 'FooScreen.xml'), comp('FooScreen', 'Group', 'Base.brs'));
    const shared = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: DEFAULT_SCREENS });
    const t = initOf(shared, 'components/Base.brs');
    expect(t?.screenConflict).toEqual(['Base', 'FooScreen']);
    expect(t?.screenIf).toBeUndefined();
  });
});

describe('inherited callbacks', () => {
  const xml = (name: string, ext: string, script: string, iface = '') =>
    `<?xml version="1.0" encoding="utf-8" ?>\n<component name="${name}" extends="${ext}">\n${iface}  <script type="text/brightscript" uri="${script}" />\n</component>\n`;
  function chan(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'efcb-'));
    mkdirSync(path.join(root, 'components'), { recursive: true });
    for (const [f, t] of Object.entries(files)) writeFileSync(path.join(root, 'components', f), t);
    return root;
  }

  it('a derived Task gets the functionName / observer / interface callbacks its ancestors declare', () => {
    const root = chan({
      'BaseTask.xml': xml('BaseTask', 'Task', 'BaseTask.brs',
        '  <interface>\n    <field id="req" type="string" onChange="onReq" />\n    <function name="doIt" />\n  </interface>\n'),
      'BaseTask.brs': 'sub init()\n  m.top.functionName = "runTask"\n  m.top.observeField("x", "onX")\nend sub\n',
      'Mid.xml': xml('Mid', 'BaseTask', 'Mid.brs'),
      'Mid.brs': 'sub other()\n  print 1\nend sub\n',
      'MyTask.xml': xml('MyTask', 'Mid', 'MyTask.brs'),
      'MyTask.brs': 'sub runTask()\n  print 1\nend sub\n',
    });
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: [] });
    const own = plan.files.get('components/MyTask.brs')!;
    expect(own.get('runtask')).toMatchObject({ isTask: true, entry: 'runTask (components/MyTask.brs)' });
    expect(own.get('onx')).toMatchObject({ isTask: false });
    expect(own.get('onreq')).toMatchObject({ isTask: false });
    expect(own.get('doit')).toMatchObject({ isTask: false });
    // Only callbacks are inherited: init / screen targets stay per component.
    expect(own.get('init')).toMatchObject({ entry: 'MyTask' });
  });

  it('an excluded ancestor still contributes callbacks; cycles and unknown parents end the walk', () => {
    const root = chan({
      'A.xml': xml('A', 'B', 'A.brs'),
      'A.brs': 'sub init()\n  m.top.functionName = "fromA"\nend sub\n',
      'B.xml': xml('B', 'A', 'B.brs'),
      'B.brs': 'sub fromA()\n  print 1\nend sub\n',
      'Base.xml': xml('Base', 'Nope', 'Base.brs'),
      'Base.brs': 'sub init()\n  m.top.functionName = "go"\nend sub\n',
      'Kid.xml': xml('Kid', 'Base', 'Kid.brs'),
      'Kid.brs': 'sub go()\n  print 1\nend sub\n',
    });
    const plan = discoverEntryPoints(root, { exclude: ['components/Base.*'], mechanisms: all, screens: [] });
    expect(plan.files.get('components/B.brs')?.get('froma')).toMatchObject({ isTask: true });
    expect(plan.files.get('components/Kid.brs')?.get('go')).toMatchObject({ isTask: true });
    expect(plan.files.has('components/Base.brs')).toBe(false);
  });

  it('a callback a derived component wires up is wrapped where an ancestor implements it', () => {
    const root = chan({
      'BaseTask.xml': xml('BaseTask', 'Task', 'BaseTask.brs'),
      'BaseTask.brs': 'sub work()\n  print 1\nend sub\nsub onDone()\n  print 1\nend sub\nsub doIt()\n  print 1\nend sub\n',
      'Mid.xml': xml('Mid', 'BaseTask', 'Mid.brs'),
      'Mid.brs': 'sub other()\n  print 1\nend sub\n',
      'ChildTask.xml': xml('ChildTask', 'Mid', 'ChildTask.brs',
        '  <interface>\n    <field id="req" type="string" onChange="onReq" />\n    <function name="doIt" />\n  </interface>\n'),
      'ChildTask.brs': 'sub init()\n  m.top.functionName = "work"\n  m.top.observeField("state", "onDone")\nend sub\n',
    });
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all, screens: [] });
    const base = plan.files.get('components/BaseTask.brs')!;
    expect(base.get('work')).toMatchObject({ isTask: true, entry: 'work (components/BaseTask.brs)' });
    expect(base.get('ondone')).toMatchObject({ isTask: false, entry: 'onDone (components/BaseTask.brs)' });
    expect(base.get('onreq')).toMatchObject({ isTask: false });
    expect(base.get('doit')).toMatchObject({ isTask: false });
    // The whole chain, not just the direct parent.
    expect(plan.files.get('components/Mid.brs')?.get('work')).toMatchObject({ isTask: true });
    // init / screen targets are never pushed up: the base keeps its own init entry.
    expect(base.get('init')).toMatchObject({ entry: 'BaseTask' });
    expect(base.get('init')?.screen).toBeUndefined();
    // An inherited onKeyEvent is covered by the ancestor's own key target.
    expect(base.get('onkeyevent')).toMatchObject({ crumb: 'key' });
  });

  it('pushed-up callbacks skip excluded ancestors / scripts, ignore excluded descendants, respect --mechanisms, survive cycles', () => {
    const root = chan({
      'Base.xml': xml('Base', 'Task', 'Base.brs'),
      'Base.brs': 'sub work()\n  print 1\nend sub\n',
      'Kid.xml': xml('Kid', 'Base', 'Kid.brs'),
      'Kid.brs': 'sub init()\n  m.top.functionName = "work"\nend sub\n',
      'Gone.xml': xml('Gone', 'Base', 'Gone.brs'),
      'Gone.brs': 'sub init()\n  m.top.functionName = "fromGone"\nend sub\n',
      'A.xml': xml('A', 'B', 'A.brs'),
      'A.brs': 'sub init()\n  m.top.functionName = "loopA"\nend sub\n',
      'B.xml': xml('B', 'A', 'B.brs'),
      'B.brs': 'sub init()\n  m.top.functionName = "loopB"\nend sub\n',
      'Orphan.xml': xml('Orphan', 'Nope', 'Orphan.brs'),
      'Orphan.brs': 'sub init()\n  m.top.functionName = "o"\nend sub\n',
    });
    const plan = discoverEntryPoints(root, { exclude: ['components/Gone.xml'], mechanisms: all, screens: [] });
    expect(plan.files.get('components/Base.brs')?.get('work')).toMatchObject({ isTask: true });
    // An excluded component's callbacks run in that component: nothing is wrapped for them.
    expect(plan.files.get('components/Base.brs')?.has('fromgone')).toBe(false);
    expect(plan.files.get('components/B.brs')?.get('loopa')).toMatchObject({ isTask: true });
    expect(plan.files.get('components/A.brs')?.get('loopb')).toMatchObject({ isTask: true });

    const noBase = discoverEntryPoints(root, { exclude: ['components/Base.xml'], mechanisms: all, screens: [] });
    expect(noBase.files.has('components/Base.brs')).toBe(false);
    const noScript = discoverEntryPoints(root, { exclude: ['components/Base.brs'], mechanisms: all, screens: [] });
    expect(noScript.files.has('components/Base.brs')).toBe(false);
    const initOnly = discoverEntryPoints(root, { exclude: [], mechanisms: new Set<Mechanism>(['init']), screens: [] });
    expect(initOnly.files.get('components/Base.brs')?.has('work')).toBe(false);
  });

  it('respects --mechanisms for inherited callbacks', () => {
    const root = chan({
      'BaseTask.xml': xml('BaseTask', 'Task', 'BaseTask.brs'),
      'BaseTask.brs': 'sub init()\n  m.top.functionName = "runTask"\nend sub\n',
      'MyTask.xml': xml('MyTask', 'BaseTask', 'MyTask.brs'),
      'MyTask.brs': 'sub runTask()\n  print 1\nend sub\n',
    });
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: new Set<Mechanism>(['init']), screens: [] });
    expect(plan.files.get('components/MyTask.brs')?.has('runtask')).toBe(false);
  });
});

describe('excluded components', () => {
  it('are listed with excluded: true and their resolved scripts, but get no targets of their own', () => {
    const root = channel([['Keep', 'Group', 'Shared.brs'], ['Drop', 'Group', 'Shared.brs'], ['Solo', 'Group', 'Solo.brs']]);
    const plan = discoverEntryPoints(root, { exclude: ['components/Drop.xml', 'components/Solo.xml'], mechanisms: all, screens: [] });
    const byName = Object.fromEntries(plan.components.map((c) => [c.name, c]));
    expect(byName.Keep).toMatchObject({ xml: 'components/Keep.xml', scripts: ['components/Shared.brs'], excluded: false });
    expect(byName.Drop).toMatchObject({ xml: 'components/Drop.xml', scripts: ['components/Shared.brs'], excluded: true });
    expect(byName.Solo).toMatchObject({ excluded: true });
    expect(plan.files.has('components/Solo.brs')).toBe(false);
    expect(initOf(plan, 'components/Shared.brs')?.entry).toBe('Keep');
  });
});

describe('externally selected Task functions', () => {
  it('a functionName set on a Task by another component (or Main) targets every Task component\'s scripts', () => {
    const root = channel([['MainScene', 'Scene'], ['Loader', 'Task'], ['BaseTask', 'Task'], ['Worker', 'BaseTask'], ['Widget', 'Group']]);
    writeFileSync(path.join(root, 'components', 'MainScene.brs'), 'sub init()\n  m.loader = CreateObject("roSGNode", "Loader")\n  m.loader.functionName = "loadContent"\n  m.loader.control = "RUN"\nend sub\n');
    mkdirSync(path.join(root, 'source'), { recursive: true });
    writeFileSync(path.join(root, 'source', 'main.brs'), 'sub Main()\n  t = CreateObject("roSGNode", "Worker")\n  t.functionName = "crunch"\nend sub\n');
    const plan = discoverEntryPoints(root, { exclude: [], mechanisms: all });
    for (const file of ['components/Loader.brs', 'components/Worker.brs', 'components/BaseTask.brs']) {
      expect(plan.files.get(file)?.get('loadcontent'), file).toMatchObject({ isTask: true });
      expect(plan.files.get(file)?.get('crunch'), file).toMatchObject({ isTask: true });
    }
    expect(plan.files.get('components/Widget.brs')?.get('loadcontent')).toBeUndefined();
    const off = discoverEntryPoints(root, { exclude: ['components/Loader.brs'], mechanisms: new Set<Mechanism>(['init']) });
    expect(off.files.get('components/Worker.brs')?.get('loadcontent')).toBeUndefined();
    const ex = discoverEntryPoints(root, { exclude: ['components/Loader.brs'], mechanisms: all });
    expect(ex.files.get('components/Loader.brs')).toBeUndefined();
  });
});
