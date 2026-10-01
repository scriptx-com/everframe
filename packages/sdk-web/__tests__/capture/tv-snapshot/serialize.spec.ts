// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDomSnapshot } from '@everframe/protocol';
import { SNAPSHOT_BLOCK_SELECTOR, takeDomSnapshot, type SnapshotDeps } from '../../../src/capture/tv-snapshot/serialize.js';
import { buildSnapshotContext, focusedSnapshotId, tvPlatformFamily } from '../../../src/capture/tv-snapshot/context.js';
import type { PruneRect } from '../../../src/capture/tv-snapshot/prune.js';
import { REDACTION_DISABLED } from '../../../src/capture/replay/mask-mapping.js';
import type { SnElement, SnNode } from '../../../src/capture/tv-snapshot/sn-types.js';
import { findLeaks } from './leak-assert.js';

const WEBOS_UA =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager';
const onScreen = (): PruneRect => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 });

function findEl(node: SnNode, pred: (e: SnElement) => boolean): SnElement | undefined {
  const stack: SnNode[] = [node];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (n.type === 2 && pred(n)) return n;
    if ('childNodes' in n) for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i] as SnNode);
  }
  return undefined;
}

function rootOf(taken: ReturnType<typeof takeDomSnapshot>): SnNode {
  return (taken.doc.events[1] as unknown as { data: { node: SnNode } }).data.node;
}

/** `a:b!important;c:d` → { a: 'b!important', c: 'd' }, whitespace-normalized. */
function decls(style: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(style).split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    out[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).replace(/\s+/g, ' ').replace(/\s*!\s*important/i, '!important').trim();
  }
  return out;
}

const imp = (css: string): Record<string, string> => decls(css.split(';').map((d) => `${d}!important`).join(';'));

function take(extra: Partial<SnapshotDeps> = {}) {
  return takeDomSnapshot({
    win: window,
    doc: document,
    // Mirrors sensitiveRegistry.snapshotElements(): the display:contents
    // wrapper is expanded (it has only text), so only #s is blocked.
    sensitiveElements: () => [document.getElementById('s')!],
    isSensitive: (el) => el.hasAttribute('data-everframe-sensitive'),
    now: () => 1000,
    measure: { rectOf: onScreen, sizeOf: () => ({ width: 100, height: 20 }) },
    ...extra,
  });
}

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WEBOS_UA);
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes('dark'), media: q })) as unknown as typeof window.matchMedia;
  window.history.replaceState(null, '', '/tv/home?access_token=SECRETTOKEN#code=SECRETCODE');
  document.head.innerHTML = '<style>#s::before{content:"Alice Smith"}body{color:#111}</style>';
  document.body.innerHTML = `
    <section id="s" data-everframe-sensitive>ALICESECRET 4111 1111 1111 1111</section>
    <input id="q" value="ALICETYPED">
    <textarea id="t">ALICENOTES</textarea>
    <p id="mail">write alice@example.test</p>
    <div data-everframe-skip-capture="true"><button id="sdk">REPORTERUI</button></div>
    <p id="acct">Account: <span id="wrap" data-everframe-sensitive style="display:contents">99887766</span></p>
    <button id="b" tabindex="0">Go</button>`;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('takeDomSnapshot', () => {
  it('masks with replay redaction disabled — snapshot masking is independent of REDACTION_DISABLED', () => {
    expect(REDACTION_DISABLED).toBe(true); // precondition: the kill switch is still on
    const taken = take();
    const json = JSON.stringify(taken.doc);
    expect(
      findLeaks(json, [
        'ALICESECRET', '4111', 'ALICETYPED', 'ALICENOTES', 'alice@example.test', 'REPORTERUI', '99887766',
        'Alice Smith', 'SECRETTOKEN', 'SECRETCODE',
      ]),
    ).toEqual([]);
    expect(taken.masked).toBe(true);
    const node = rootOf(taken);
    expect(findEl(node, (e) => e.attributes.id === 'q')!.attributes.value).toBe('***');
    // The page's stylesheet survives (scrubbed), so the render is styled.
    expect(json).toContain('body{color:rgb(17, 17, 17)}'); // jsdom's CSSOM normalizes the colour
  });

  it('restores the live DOM (no rr-block left behind), even when serialization throws', () => {
    take();
    expect(document.getElementById('s')!.classList.contains('rr-block')).toBe(false);
    expect(() => take({ doc: null as unknown as Document })).toThrow();
    expect(document.getElementById('s')!.classList.contains('rr-block')).toBe(false);
  });

  it('emits Meta + FullSnapshot with a sanitized href and the root scroll offset', () => {
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(12);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(240);
    const taken = take();
    const [meta, full] = taken.doc.events as unknown as Array<{ type: number; timestamp: number; data: Record<string, unknown> }>;
    expect(meta).toEqual({ type: 4, timestamp: 1000, data: { href: `${location.origin}/tv/home`, width: innerWidth, height: innerHeight } });
    expect(full).toMatchObject({ type: 2, timestamp: 1000, data: { initialOffset: { top: 240, left: 12 } } });
  });

  it('pattern-redacts the Meta href path and drops an oversize one to the origin', () => {
    window.history.replaceState(null, '', '/tv/user/alice@example.test/home');
    const href = (take().doc.events[0] as { data: { href: string } }).data.href;
    expect(findLeaks(href, ['alice@example.test'])).toEqual([]);
    expect(href.startsWith(`${location.origin}/tv/user/`)).toBe(true);

    window.history.replaceState(null, '', '/seg'.repeat(700));
    expect((take().doc.events[0] as { data: { href: string } }).data.href).toBe(`${location.origin}/`);
  });

  it('records context: platform, dpr, media, fonts, focused element — and no separate scroll', () => {
    document.getElementById('b')!.focus();
    const taken = take();
    const button = findEl(rootOf(taken), (e) => e.attributes.id === 'b')!;
    expect(taken.doc.context).toEqual({
      platform: 'webos',
      userAgent: WEBOS_UA,
      dpr: window.devicePixelRatio,
      focusedId: button.id,
      media: { prefersColorScheme: 'dark', prefersReducedMotion: 'no-preference', forcedColors: 'none' },
      viewport: { width: innerWidth, height: innerHeight },
      fonts: { status: 'loaded', loaded: [], failed: [] },
    });
    // Ruling S1: the root scroll offset lives only in FullSnapshot.initialOffset.
    expect('scroll' in taken.doc.context).toBe(false);
    expect(taken.render).toEqual({
      platform: 'webos',
      viewport: { width: innerWidth, height: innerHeight },
      dpr: window.devicePixelRatio,
      fontStatus: 'loaded',
    });
  });

  it('validates against the protocol DomSnapshotV1 schema (contract gate)', () => {
    const parsed = parseDomSnapshot(JSON.parse(JSON.stringify(take().doc)));
    expect(parsed).toMatchObject({ ok: true });
  });

  it('keeps the context inside the protocol bounds for out-of-range windows', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(0);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(9000);
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(12);
    const taken = take();
    expect(taken.doc.context.viewport).toEqual({ width: 1, height: 4096 });
    expect(taken.doc.context.dpr).toBe(8);
    expect(parseDomSnapshot(JSON.parse(JSON.stringify(taken.doc)))).toMatchObject({ ok: true });
  });

  it('never names a pruned, masked or SDK-chrome element as focused', () => {
    document.getElementById('s')!.setAttribute('tabindex', '0');
    document.getElementById('s')!.focus();
    expect(take().doc.context.focusedId).toBeNull();
    const chrome = document.querySelector<HTMLElement>(SNAPSHOT_BLOCK_SELECTOR)!;
    chrome.setAttribute('tabindex', '0');
    chrome.focus();
    expect(take().doc.context.focusedId).toBeNull();
    document.getElementById('sdk')!.focus();
    expect(take().doc.context.focusedId).toBeNull();
  });

  it('serializes a deep page without overflowing the stack (iterative prune and scrub)', () => {
    let html = '';
    for (let i = 0; i < 1500; i++) html += '<div>';
    html += 'deep';
    for (let i = 0; i < 1500; i++) html += '</div>';
    document.body.innerHTML = `<section id="s"></section>${html}`;
    const taken = take();
    expect(JSON.stringify(taken.doc)).toContain('deep');
    // Generous timeout: pruning reads computed style once per element, and
    // jsdom's getComputedStyle walks the whole ancestor chain (~2 s here
    // alone, past the 10 s default under a loaded full-suite run). Chromium
    // answers from its style tree; the real-browser deep-DOM e2e covers that.
  }, 30_000);
});

describe('sensitive content inside open shadow roots', () => {
  it('black-boxes a sensitive element the document-level registry scan cannot reach', () => {
    document.body.innerHTML = '<section id="s"></section><div id="host"></div>';
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<p>public</p><section id="inner" data-everframe-sensitive>SHADOW_PRIVATE_NAME</section>' +
      '<span id="wrap2" data-everframe-sensitive style="display:contents"><b>SHADOW_CONTENTS_CHILD</b>SHADOW_BARE</span>';
    const taken = take({ sensitiveElements: () => [] });
    const json = JSON.stringify(taken.doc);
    expect(findLeaks(json, ['SHADOW_PRIVATE_NAME', 'SHADOW_CONTENTS_CHILD', 'SHADOW_BARE'])).toEqual([]);
    expect(json).toContain('public');
    expect(taken.masked).toBe(true);
    const inner = findEl(rootOf(taken), (e) => e.tagName === 'section' && e.childNodes.length === 0 && decls(e.attributes.style).background === '#000!important');
    expect(inner).toBeDefined();
  });

  it('fails closed when the sensitivity check throws', () => {
    document.body.innerHTML = '<section id="s"></section><div id="host"></div>';
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<p id="x">THROWN_CHECK_TEXT</p>';
    const taken = take({
      sensitiveElements: () => [],
      isSensitive: (el) => {
        if (el.id === 'x') throw new Error('boom');
        return false;
      },
    });
    expect(findLeaks(JSON.stringify(taken.doc), ['THROWN_CHECK_TEXT'])).toEqual([]);
    expect(taken.masked).toBe(true);
  });
});

describe('off-screen inline content (viewport pruning)', () => {
  const offRect: PruneRect = { left: 2000, top: 0, right: 2120, bottom: 20, width: 120, height: 20 };
  const rectOf = (el: Element): PruneRect => (el.closest('#off, #offwrap') ? offRect : onScreen());

  it('drops the text of an inline element entirely outside the viewport, keeping its measured box', () => {
    document.body.innerHTML =
      '<section id="s"></section><p id="row" style="white-space:nowrap">Visible <span id="off" title="T_ATTR">OFFSCREEN_PRIVATE_NAME <b>NESTED_PRIVATE</b></span> tail</p>';
    const taken = take({ measure: { rectOf, sizeOf: () => ({ width: 100, height: 20 }) } });
    const json = JSON.stringify(taken.doc);
    expect(findLeaks(json, ['OFFSCREEN_PRIVATE_NAME', 'NESTED_PRIVATE', 'T_ATTR'])).toEqual([]);
    expect(json).toContain('Visible');
    expect(json).toContain('tail');
    const off = findEl(rootOf(taken), (e) => e.tagName === 'span' && e.childNodes.some((c) => c.type === 2))!;
    const box = off.childNodes[0] as SnElement;
    expect(decls(box.attributes.style)).toMatchObject({
      display: 'inline-block!important', width: '120px!important', height: '20px!important', visibility: 'hidden!important',
    });
    expect(parseDomSnapshot(JSON.parse(JSON.stringify(taken.doc)))).toMatchObject({ ok: true });
  });

  it('keeps one placeholder per line fragment of a wrapped inline element', () => {
    document.body.innerHTML = '<section id="s"></section><p>Visible <span id="off">WRAPPED_PRIVATE_TEXT</span></p>';
    const taken = take({
      measure: {
        rectOf,
        sizeOf: () => ({ width: 100, height: 20 }),
        fragmentsOf: () => [
          { left: 2000, top: 0, right: 2050, bottom: 20, width: 50, height: 20 },
          { left: 1100, top: 20, right: 1180, bottom: 40, width: 80, height: 20 },
        ],
      },
    });
    expect(findLeaks(JSON.stringify(taken.doc), ['WRAPPED_PRIVATE_TEXT'])).toEqual([]);
    const off = findEl(rootOf(taken), (e) => e.tagName === 'span' && e.childNodes.length === 3)!;
    expect(off.childNodes.map((c) => (c as SnElement).tagName)).toEqual(['span', 'br', 'span']);
    expect(decls((off.childNodes[2] as SnElement).attributes.style).width).toBe('80px!important');
  });

  it('drops off-screen bare text of a display:contents element', () => {
    document.body.innerHTML =
      '<section id="s"></section><p>Visible <span id="offwrap" style="display:contents">CONTENTS_PRIVATE_TEXT</span></p>';
    const taken = take({
      measure: { rectOf, sizeOf: () => ({ width: 100, height: 20 }), textRectsOf: () => [offRect] },
    });
    expect(findLeaks(JSON.stringify(taken.doc), ['CONTENTS_PRIVATE_TEXT'])).toEqual([]);
    expect(JSON.stringify(taken.doc)).toContain('Visible');
  });

  it('keeps on-screen bare text of a display:contents element', () => {
    document.body.innerHTML = '<section id="s"></section><p>Visible <span style="display:contents">SEEN_CONTENTS_TEXT</span></p>';
    const taken = take({ measure: { rectOf: onScreen, sizeOf: () => ({ width: 100, height: 20 }), textRectsOf: () => [onScreen()] } });
    expect(JSON.stringify(taken.doc)).toContain('SEEN_CONTENTS_TEXT');
  });
});

describe('placeholder styles survive the scrubber end to end (ruling S21)', () => {
  const OFF: PruneRect = { left: 0, top: 5000, right: 300, bottom: 5040, width: 300, height: 40 };
  const STYLES: Record<string, Partial<CSSStyleDeclaration>> = {
    main: { display: 'grid', position: 'static' },
    list: { display: 'block', position: 'static' },
    'li-off': { display: 'list-item', position: 'static', marginTop: '8px', marginRight: '0px', marginBottom: '8px', marginLeft: '0px' },
    s: { display: 'block', position: 'static', marginTop: '4px', marginRight: '0px', marginBottom: '4px', marginLeft: '0px' },
    'grid-off': { display: 'block', position: 'relative', gridRowStart: '2', gridRowEnd: 'span 2', top: '10px', left: '0px', zIndex: '3' },
    'abs-off': { display: 'block', position: 'absolute' },
    'icons-off': { display: 'block', position: 'static' },
  };
  const OFF_IDS = new Set(['li-off', 's', 'grid-off', 'abs-off', 'icons-off']);
  /** Off-screen: one of OFF_IDS or inside one (a child of an off-screen box is off-screen too). */
  const isOff = (el: Element): boolean => {
    for (let e: Element | null = el; e !== null; e = e.parentElement) if (OFF_IDS.has(e.id)) return true;
    return false;
  };

  function takePage() {
    document.head.innerHTML = '<style>.clipped{clip-path:url(#clip)}</style>';
    document.body.innerHTML = `
      <main id="main">
        <ul id="list"><li id="li-off">OFFSCREENITEM</li><li id="li-on">Visible item</li></ul>
        <section id="s" data-everframe-sensitive>SECRETBOX</section>
        <div id="grid-off">GRIDITEM</div>
        <div id="abs-off">ABSITEM</div>
        <section id="icons-off"><svg id="icon-svg" width="10" height="10"><defs><clipPath id="clip"><rect width="10" height="10"></rect></clipPath></defs><path d="M0 0h10"></path></svg><p>ICONSCREEN</p></section>
        <div id="uses" style="clip-path:url(#clip)">clipped</div>
      </main>`;
    return takeDomSnapshot({
      win: window,
      doc: document,
      sensitiveElements: () => [document.getElementById('s')!],
      isSensitive: (el) => el.hasAttribute('data-everframe-sensitive'),
      now: () => 1000,
      measure: {
        rectOf: (el) => (isOff(el) ? OFF : onScreen()),
        styleOf: (el) => ({ display: 'block', position: 'static', ...(STYLES[el.id] ?? {}) }) as CSSStyleDeclaration,
        sizeOf: (_el, r) => ({ width: r.width, height: r.height }),
      },
    });
  }

  const COMMON = 'box-sizing:border-box;width:300px;height:40px;min-width:0;min-height:0;max-width:none;max-height:none';

  it('keeps every placeholder declaration, !important, after the allowlist scrub', () => {
    const taken = takePage();
    const root = rootOf(taken);
    const styles = [] as Array<Record<string, string>>;
    const stack: SnNode[] = [root];
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      if (n.type === 2 && typeof n.attributes.style === 'string') styles.push(decls(n.attributes.style));
      if ('childNodes' in n) for (const c of n.childNodes) stack.push(c);
    }
    // In-flow list item: same box, collapsed margins, display:list-item, hidden.
    expect(styles).toContainEqual(
      imp(`display:list-item;position:static;${COMMON};margin:8px 0px 8px 0px;padding:0;border:0;flex:0 0 auto;visibility:hidden`),
    );
    // Blocked sensitive element: same box, painted black.
    expect(styles).toContainEqual(
      imp(`display:block;position:static;${COMMON};margin:4px 0px 4px 0px;padding:0;border:0;flex:0 0 auto;background:#000`),
    );
    // Grid item: grid placement and relative offsets survive.
    expect(styles).toContainEqual(
      imp(
        `display:block;position:relative;${COMMON};margin:0px 0px 0px 0px;padding:0;border:0;flex:0 0 auto;` +
          'grid-row:2 / span 2;top:10px;left:0px;z-index:3;visibility:hidden',
      ),
    );
    // Out of flow: takes no space.
    expect(styles).toContainEqual(imp('display:none'));
    // Pruned screen holding an icon definition: same box, hosting a zero-size SVG carrier.
    expect(styles).toContainEqual(
      imp(`display:block;position:static;${COMMON};margin:0px 0px 0px 0px;padding:0;border:0;flex:0 0 auto;visibility:hidden`),
    );
    const svg = findEl(root, (e) => e.tagName.toLowerCase() === 'svg')!;
    expect(svg.attributes).toMatchObject({ width: '0', height: '0' });
    expect(decls(svg.attributes.style)).toEqual(imp('position:absolute;width:0;height:0;overflow:hidden;visibility:visible'));
    expect(findEl(svg, (e) => e.tagName.toLowerCase() === 'clippath')!.attributes.id).toBe('clip');
    expect(decls(findEl(root, (e) => e.attributes.id === 'uses')!.attributes.style)).toEqual({ 'clip-path': 'url("#clip")' });
    // rrweb-snapshot absolutizes CSS url()s against the page; same-document
    // fragments come back as `#id` in both inline styles and stylesheets.
    expect(findEl(root, (e) => e.tagName === 'style')!.attributes._cssText).toContain('clip-path:url("#clip")');

    expect(findLeaks(JSON.stringify(taken.doc), ['OFFSCREENITEM', 'SECRETBOX', 'GRIDITEM', 'ABSITEM', 'ICONSCREEN'])).toEqual([]);
    expect(taken.masked).toBe(true);
    expect(parseDomSnapshot(JSON.parse(JSON.stringify(taken.doc)))).toMatchObject({ ok: true });
  });
});

describe('snapshot context helpers', () => {
  it('classifies TV platform families', () => {
    expect(tvPlatformFamily(WEBOS_UA)).toBe('webos');
    expect(tvPlatformFamily('Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36')).toBe('tizen');
    expect(tvPlatformFamily('Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0')).toBe('other');
  });

  it('returns null when nothing but the body is focused, or the element is not in the snapshot', () => {
    const mirror = { getId: (n: Node) => ((n as Element).id === 'b' ? 7 : -1) };
    (document.activeElement as HTMLElement | null)?.blur();
    expect(focusedSnapshotId(document, mirror, new Set())).toBeNull();
    document.getElementById('b')!.focus();
    expect(focusedSnapshotId(document, mirror, new Set())).toBe(7);
    expect(focusedSnapshotId(document, mirror, new Set([7]))).toBeNull();
    document.getElementById('q')!.focus();
    expect(focusedSnapshotId(document, mirror, new Set())).toBeNull();
  });

  it('summarizes page fonts within the protocol caps', () => {
    const faces = [
      { family: '"Museo Sans"', status: 'loaded' },
      { family: 'Broken', status: 'error' },
      { family: `'${'F'.repeat(400)}'`, status: 'loaded' },
      ...Array.from({ length: 100 }, (_, i) => ({ family: `Face${i}`, status: 'loaded' })),
    ];
    const fonts = { status: 'loading', forEach: (cb: (f: (typeof faces)[number]) => void) => faces.forEach(cb) };
    const fakeDoc = { fonts } as unknown as Document;
    const context = buildSnapshotContext(window, fakeDoc, null);
    expect(context.fonts.status).toBe('loading');
    expect(context.fonts.loaded[0]).toBe('Museo Sans');
    expect(context.fonts.failed).toEqual(['Broken']);
    expect(context.fonts.loaded.length).toBeLessThanOrEqual(32);
    for (const name of context.fonts.loaded) expect(name.length).toBeLessThanOrEqual(64);
  });

  it('stays linear on long page- and device-controlled strings (ruling S18)', () => {
    const nearMiss = 'W'.repeat(20_000) + 'eb0';
    const faces = [{ family: `"${"'".repeat(20_000)}`, status: 'loaded' }];
    const fakeDoc = { fonts: { status: 'loaded', forEach: (cb: (f: (typeof faces)[number]) => void) => faces.forEach(cb) } } as unknown as Document;
    const started = performance.now();
    expect(tvPlatformFamily(nearMiss)).toBe('other');
    buildSnapshotContext(window, fakeDoc, null);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
