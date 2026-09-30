// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SENSITIVE_ATTR } from '../../src/sensitive/registry.js';
import { createCloneMaskPlugin, expandMaskTargets } from '../../src/capture/renderers/clone-mask.js';
import { STAND_IN_ATTR } from '../../src/capture/video-frames.js';

/** snapDOM-style deep clone of `src` with its clone -> source nodeMap. */
function cloneWithMap(src: Element): { clone: Element; nodeMap: Map<Node, Node> } {
  const nodeMap = new Map<Node, Node>();
  const walk = (s: Element): Element => {
    const c = s.cloneNode(false) as Element;
    nodeMap.set(c, s);
    for (const k of Array.from(s.childNodes)) c.appendChild(k.nodeType === 1 ? walk(k as Element) : k.cloneNode(true));
    return c;
  };
  return { clone: walk(src), nodeMap };
}

/** Predicate for a fixed list of targets. */
const listed = (...els: Element[]): ((el: Element) => boolean) => {
  const set = new Set(els);
  return (el) => set.has(el);
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createCloneMaskPlugin', () => {
  it('replaces a target clone with a black box and drops everything inside it; non-targets untouched', () => {
    document.body.innerHTML = `
      <main>
        <p id="keep">public</p>
        <div id="secret" style="width:120px;height:30px;margin:4px"><b>4111</b> 1111<input type="checkbox" checked></div>
      </main>`;
    const main = document.querySelector('main')!;
    const secret = document.getElementById('secret')!;
    const ctx = cloneWithMap(main);
    const plugin = createCloneMaskPlugin(listed(secret));
    plugin.afterClone(ctx);

    expect(ctx.clone.querySelector('#keep')!.textContent).toBe('public');
    expect(ctx.clone.querySelector('#secret')).toBeNull();
    expect(ctx.clone.textContent).not.toContain('4111');
    expect(ctx.clone.querySelector('input')).toBeNull();
    const box = ctx.clone.lastElementChild as HTMLElement;
    expect(box.tagName).toBe('DIV');
    expect(box.childNodes).toHaveLength(0);
    expect(box.getAttribute('style')).toContain('background: rgb(0, 0, 0)');
    expect(box.style.marginTop).toBe('4px'); // geometry carried over from the source
    expect(secret.getAttribute('style')).toBe('width:120px;height:30px;margin:4px'); // live page untouched
  });

  it('a target nested inside another target is gone with its ancestor (no double replacement)', () => {
    document.body.innerHTML = '<main><section id="outer"><span id="inner">x</span></section></main>';
    const main = document.querySelector('main')!;
    const ctx = cloneWithMap(main);
    createCloneMaskPlugin(listed(document.getElementById('outer')!, document.getElementById('inner')!)).afterClone(ctx);
    expect(ctx.clone.children).toHaveLength(1);
    expect(ctx.clone.firstElementChild!.childNodes).toHaveLength(0);
  });

  it('removes the clone of a target that renders no box', () => {
    document.body.innerHTML = '<main><div id="hidden" style="display:none">secret</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    createCloneMaskPlugin(listed(document.getElementById('hidden')!)).afterClone(ctx);
    expect(ctx.clone.childElementCount).toBe(0);
  });

  it('keeps snapDOM\'s placement of a lifted fixed element', () => {
    document.body.innerHTML = '<main><div id="fab" style="position:fixed;right:0;bottom:0">x</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const fabClone = ctx.clone.firstElementChild as HTMLElement;
    fabClone.style.position = 'absolute'; // what snapDOM's freezeViewportPositioned does
    fabClone.style.left = '700px';
    fabClone.style.top = '500px';
    createCloneMaskPlugin(listed(document.getElementById('fab')!)).afterClone(ctx);
    const box = ctx.clone.firstElementChild as HTMLElement;
    expect(box.style.position).toBe('absolute');
    expect(box.style.left).toBe('700px');
    expect(box.style.top).toBe('500px');
  });

  it('masks the capture root itself by emptying it', () => {
    document.body.innerHTML = '<main id="root"><p>secret</p></main>';
    const main = document.querySelector('main')!;
    const ctx = cloneWithMap(main);
    createCloneMaskPlugin(listed(main)).afterClone(ctx);
    expect(ctx.clone.childNodes).toHaveLength(0);
    expect((ctx.clone as HTMLElement).style.background).toContain('rgb(0, 0, 0)');
  });

  it('beforeRender strips anything a later snapDOM pass added to a box', () => {
    document.body.innerHTML = '<main><div id="secret">s</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const plugin = createCloneMaskPlugin(listed(document.getElementById('secret')!));
    plugin.afterClone(ctx);
    const box = ctx.clone.firstElementChild as HTMLElement;
    const pristine = box.getAttribute('style');
    box.style.backgroundImage = 'url(data:image/png;base64,AAAA)';
    box.className = 'snap-class';
    box.appendChild(document.createElement('svg'));
    plugin.beforeRender();
    expect(box.childNodes).toHaveLength(0);
    expect(box.hasAttribute('class')).toBe(false);
    expect(box.getAttribute('style')).toBe(pristine);
  });

  it('masks a lifted (fixed) clone whose SOURCE ancestor is sensitive, wherever snapDOM moved it', () => {
    document.body.innerHTML =
      '<main><section id="vault"><p>vault</p><div id="fab" style="position:fixed;left:0;bottom:0">ACCT 1234</div></section></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    // What snapDOM's freezeViewportPositioned does before afterClone: lift the
    // fixed clone out of its section onto the capture root.
    const fabClone = ctx.clone.querySelector('#fab') as HTMLElement;
    fabClone.style.position = 'absolute';
    fabClone.style.left = '20px';
    fabClone.style.top = '600px';
    ctx.clone.appendChild(fabClone);
    createCloneMaskPlugin(listed(document.getElementById('vault')!)).afterClone(ctx);
    expect(ctx.clone.textContent).not.toContain('ACCT');
    expect(ctx.clone.children).toHaveLength(2); // the section box + the lifted FAB box
    const fabBox = ctx.clone.lastElementChild as HTMLElement;
    expect(fabBox.style.left).toBe('20px');
    expect(fabBox.style.top).toBe('600px');
  });

  it('judges sensitivity at mask time: nothing listed up front, source marked by then -> masked', () => {
    document.body.innerHTML = '<main><div id="late">secret</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const plugin = createCloneMaskPlugin((el) => el.hasAttribute(SENSITIVE_ATTR));
    // The app marks (or replaces in) the element after the capture started.
    document.getElementById('late')!.setAttribute(SENSITIVE_ATTR, '');
    plugin.afterClone(ctx);
    expect(ctx.clone.textContent).not.toContain('secret');
  });

  it('crosses shadow roots: a node inside a sensitive host\'s shadow tree is masked', () => {
    document.body.innerHTML = '<main><div id="host"></div></main>';
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    inner.textContent = 'shadow secret';
    shadow.appendChild(inner);
    // A snapDOM-style clone that flattened the shadow content, with the inner
    // clone lifted to the root so only source ancestry links it to the host.
    const main = document.querySelector('main')!;
    const clone = main.cloneNode(false) as Element;
    const innerClone = inner.cloneNode(true) as Element;
    clone.appendChild(innerClone);
    const nodeMap = new Map<Node, Node>([[clone, main], [innerClone, inner]]);
    createCloneMaskPlugin(listed(host)).afterClone({ clone, nodeMap });
    expect(clone.textContent).not.toContain('shadow secret');
  });

  it('follows assignedSlot: light-DOM content slotted into a sensitive <slot> is masked', () => {
    document.body.innerHTML = '<main><div id="host"><span id="slotted">slotted secret</span></div></main>';
    const host = document.getElementById('host')!;
    const slotted = document.getElementById('slotted')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="frame"><slot></slot></div>';
    const slot = shadow.querySelector('slot')!;
    expect(slotted.assignedSlot).toBe(slot);
    // snapDOM flattens the slot: the slotted clone sits where the slot was.
    const main = document.querySelector('main')!;
    const clone = main.cloneNode(false) as Element;
    const slottedClone = slotted.cloneNode(true) as Element;
    clone.appendChild(slottedClone);
    const nodeMap = new Map<Node, Node>([[clone, main], [slottedClone, slotted]]);
    // The slot itself, and (separately) a shadow-tree element around it.
    createCloneMaskPlugin(listed(slot)).afterClone({ clone, nodeMap });
    expect(clone.textContent).not.toContain('slotted secret');
    const clone2 = main.cloneNode(false) as Element;
    const slottedClone2 = slotted.cloneNode(true) as Element;
    clone2.appendChild(slottedClone2);
    const frame = shadow.getElementById('frame')!;
    createCloneMaskPlugin(listed(frame)).afterClone({ clone: clone2, nodeMap: new Map<Node, Node>([[clone2, main], [slottedClone2, slotted]]) });
    expect(clone2.textContent).not.toContain('slotted secret');
  });

  it('masks bare light-DOM text snapDOM copied (unmapped) into a host whose slot is sensitive', () => {
    document.body.innerHTML = '<main><div id="host">SECRET 8877</div><div id="open">public</div></main>';
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = '<slot data-everframe-sensitive></slot>';
    const open = document.getElementById('open')!;
    open.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
    // snapDOM-style: host clones mapped, the flattened text clones NOT mapped.
    const main = document.querySelector('main')!;
    const clone = main.cloneNode(false) as Element;
    const hostClone = host.cloneNode(false) as Element;
    hostClone.appendChild(document.createTextNode('SECRET 8877'));
    const openClone = open.cloneNode(false) as Element;
    openClone.appendChild(document.createTextNode('public'));
    clone.append(hostClone, openClone);
    const nodeMap = new Map<Node, Node>([[clone, main], [hostClone, host], [openClone, open]]);
    const isSlotAttr = (el: Element): boolean => el.hasAttribute('data-everframe-sensitive');
    createCloneMaskPlugin(isSlotAttr).afterClone({ clone, nodeMap });
    const wrap = hostClone.firstChild as HTMLElement;
    expect(wrap.nodeType).toBe(1);
    expect(wrap.style.color).toBe('transparent');
    expect(wrap.getAttribute('style')).toContain('text-shadow: none');
    expect(openClone.firstChild!.nodeType).toBe(3); // a non-sensitive slot's text is left alone
  });

  it('beforeRender masks what became sensitive after afterClone', () => {
    document.body.innerHTML = '<main><div id="a">alpha</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const plugin = createCloneMaskPlugin((el) => el.hasAttribute(SENSITIVE_ATTR));
    plugin.afterClone(ctx);
    expect(ctx.clone.textContent).toContain('alpha');
    document.getElementById('a')!.setAttribute(SENSITIVE_ATTR, '');
    plugin.beforeRender(ctx);
    expect(ctx.clone.textContent).not.toContain('alpha');
  });

  it('a lifted element keeps snapDOM\'s frozen transform instead of re-applying the live one', () => {
    document.body.innerHTML =
      '<main><div id="modal" style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:200px;height:80px">m</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const modalClone = ctx.clone.firstElementChild as HTMLElement;
    // snapDOM baked the translation into left/top and cleared the transform.
    modalClone.style.position = 'absolute';
    modalClone.style.left = '300px';
    modalClone.style.top = '260px';
    modalClone.style.transform = 'none';
    modalClone.style.width = '202px';
    modalClone.style.height = '80px';
    createCloneMaskPlugin(listed(document.getElementById('modal')!)).afterClone(ctx);
    const box = ctx.clone.firstElementChild as HTMLElement;
    expect(box.style.left).toBe('300px');
    expect(box.style.top).toBe('260px');
    expect(box.style.transform).toBe('none');
    expect(box.style.width).toBe('202px');
  });

  it('a sensitive display:contents wrapper masks its children individually (no layout collapse)', () => {
    document.body.innerHTML = '<main><div id="w" style="display:contents"><p id="c1">one</p><p id="c2">two</p></div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    createCloneMaskPlugin(listed(document.getElementById('w')!)).afterClone(ctx);
    const wrapper = ctx.clone.firstElementChild!;
    expect(wrapper.children).toHaveLength(2);
    expect(ctx.clone.textContent).not.toMatch(/one|two/);
  });

  it('a source the app detached after it was copied keeps the clone\'s snapshotted geometry, blacked out', () => {
    document.body.innerHTML = '<main><div id="gone" class="snap-a">secret</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const goneClone = ctx.clone.firstElementChild as HTMLElement;
    goneClone.setAttribute('style', 'width: 200px; height: 40px');
    const gone = document.getElementById('gone')!;
    gone.remove(); // replaced by the app while snapDOM's clone yielded
    createCloneMaskPlugin(listed(gone)).afterClone(ctx);
    const box = ctx.clone.firstElementChild as HTMLElement;
    expect(box.textContent).toBe('');
    expect(box.getAttribute('class')).toBe('snap-a');
    expect(box.style.width).toBe('200px');
    expect(box.style.height).toBe('40px');
    expect(box.getAttribute('style')).toContain('background: rgb(0, 0, 0)');
  });

  it('a sensitive display:contents wrapper hides its DIRECT text and drops generated children', () => {
    document.body.innerHTML = '<main><p>Account: <span id="w" style="display:contents">99887766</span> end</p></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const wrapperClone = ctx.clone.querySelector('#w')!;
    // What snapDOM does for a ::before pseudo-element: a real, unmapped child.
    const generated = document.createElement('span');
    generated.textContent = 'pseudo secret';
    wrapperClone.prepend(generated);
    const plugin = createCloneMaskPlugin(listed(document.getElementById('w')!));
    plugin.afterClone(ctx);
    expect(wrapperClone.contains(generated)).toBe(false);
    const span = wrapperClone.firstElementChild as HTMLElement;
    expect(span.textContent).toBe('99887766'); // kept in place for identical line layout ...
    expect(span.getAttribute('style')).toContain('color: transparent'); // ... but never painted
    expect(span.getAttribute('style')).toContain('background: rgb(0, 0, 0)');
    // Text outside the wrapper is untouched.
    expect(ctx.clone.querySelector('p')!.firstChild!.textContent).toBe('Account: ');
    // A second pass (beforeRender) keeps its own span and does not double-wrap.
    plugin.beforeRender(ctx);
    expect(wrapperClone.children).toHaveLength(1);
    expect(wrapperClone.firstElementChild).toBe(span);
    expect(span.children).toHaveLength(0);
  });

  it('carries the source\'s zoom so a zoomed element is covered at its zoomed size', () => {
    document.body.innerHTML = '<main><div id="z" style="zoom:2;width:200px;height:40px">z</div></main>';
    const z = document.getElementById('z')!;
    Object.defineProperty(z, 'offsetWidth', { value: 200, configurable: true });
    Object.defineProperty(z, 'offsetHeight', { value: 40, configurable: true });
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      const cs = real(el, pseudo);
      if (el !== z) return cs;
      return new Proxy(cs, { get: (t, k) => (k === 'zoom' ? '2' : (t as unknown as Record<string | symbol, unknown>)[k]) });
    });
    const ctx = cloneWithMap(document.querySelector('main')!);
    createCloneMaskPlugin(listed(z)).afterClone(ctx);
    spy.mockRestore();
    const box = ctx.clone.firstElementChild as HTMLElement;
    expect(box.style.width).toBe('200px');
    expect(box.getAttribute('style')).toContain('zoom: 2');
  });

  it('a throwing predicate masks (never unmasks on error)', () => {
    document.body.innerHTML = '<main><div id="x">secret</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    createCloneMaskPlugin((el) => {
      if (el.id === 'x') throw new Error('registry');
      return false;
    }).afterClone(ctx);
    expect(ctx.clone.textContent).not.toContain('secret');
  });

  it('is inert without targets or without a nodeMap', () => {
    document.body.innerHTML = '<main><div id="secret">s</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    createCloneMaskPlugin(() => false).afterClone(ctx);
    createCloneMaskPlugin(listed(document.getElementById('secret')!)).afterClone({ clone: ctx.clone });
    expect(ctx.clone.querySelector('#secret')).not.toBeNull();
  });
});

describe('expandMaskTargets', () => {
  it('adds the stand-in of a sensitive video', () => {
    document.body.innerHTML = `<video></video><div ${STAND_IN_ATTR}="1"></div><p></p>`;
    const video = document.querySelector('video')!;
    const standIn = document.querySelector(`[${STAND_IN_ATTR}]`)!;
    const p = document.querySelector('p')!;
    expect(expandMaskTargets([video, p])).toEqual([video, p, standIn]);
    expect(expandMaskTargets([p])).toEqual([p]);
  });
});

describe('sensitiveRegistry.isSensitive', () => {
  it('matches the snapshotElements rules: refs, the attribute, password inputs', async () => {
    const { sensitiveRegistry } = await import('../../src/sensitive/registry.js');
    document.body.innerHTML = `<div id="attr" ${SENSITIVE_ATTR}></div><input id="pw" type="password"><input id="txt"><p id="ref"></p>`;
    const ref = document.getElementById('ref')!;
    sensitiveRegistry.addRef(ref);
    try {
      expect(sensitiveRegistry.isSensitive(document.getElementById('attr')!)).toBe(true);
      expect(sensitiveRegistry.isSensitive(document.getElementById('pw')!)).toBe(true);
      expect(sensitiveRegistry.isSensitive(ref)).toBe(true);
      expect(sensitiveRegistry.isSensitive(document.getElementById('txt')!)).toBe(false);
    } finally {
      sensitiveRegistry.removeRef(ref);
    }
    expect(sensitiveRegistry.isSensitive(ref)).toBe(false);
  });
});

describe('clone masking on engines without Element.replaceChildren (webOS 6 / Chrome 79)', () => {
  const saved = Object.getOwnPropertyDescriptor(Element.prototype, 'replaceChildren');
  beforeEach(() => {
    delete (Element.prototype as unknown as Record<string, unknown>).replaceChildren;
  });
  afterEach(() => {
    if (saved) Object.defineProperty(Element.prototype, 'replaceChildren', saved);
    document.body.innerHTML = '';
  });

  it('masks a sensitive capture root, before and after beforeRender', () => {
    expect('replaceChildren' in Element.prototype).toBe(false);
    document.body.innerHTML = '<main id="root"><p>secret</p></main>';
    const main = document.querySelector('main')!;
    const ctx = cloneWithMap(main);
    const plugin = createCloneMaskPlugin(listed(main));
    plugin.afterClone(ctx);
    expect(ctx.clone.childNodes).toHaveLength(0);
    ctx.clone.appendChild(document.createElement('span'));
    plugin.beforeRender(ctx);
    expect(ctx.clone.childNodes).toHaveLength(0);
    expect((ctx.clone as HTMLElement).style.background).toContain('rgb(0, 0, 0)');
  });

  it('beforeRender still strips what a later pass added to a mask box', () => {
    document.body.innerHTML = '<main><div id="secret">s</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const plugin = createCloneMaskPlugin(listed(document.getElementById('secret')!));
    plugin.afterClone(ctx);
    const box = ctx.clone.firstElementChild as HTMLElement;
    box.appendChild(document.createElement('svg'));
    box.appendChild(document.createTextNode('late'));
    plugin.beforeRender(ctx);
    expect(box.childNodes).toHaveLength(0);
    expect(ctx.clone.textContent).not.toContain('s');
  });
});
