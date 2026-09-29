// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
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
    const plugin = createCloneMaskPlugin([secret]);
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
    createCloneMaskPlugin([document.getElementById('outer')!, document.getElementById('inner')!]).afterClone(ctx);
    expect(ctx.clone.children).toHaveLength(1);
    expect(ctx.clone.firstElementChild!.childNodes).toHaveLength(0);
  });

  it('removes the clone of a target that renders no box', () => {
    document.body.innerHTML = '<main><div id="hidden" style="display:none">secret</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    createCloneMaskPlugin([document.getElementById('hidden')!]).afterClone(ctx);
    expect(ctx.clone.childElementCount).toBe(0);
  });

  it('keeps snapDOM\'s placement of a lifted fixed element', () => {
    document.body.innerHTML = '<main><div id="fab" style="position:fixed;right:0;bottom:0">x</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const fabClone = ctx.clone.firstElementChild as HTMLElement;
    fabClone.style.position = 'absolute'; // what snapDOM's freezeViewportPositioned does
    fabClone.style.left = '700px';
    fabClone.style.top = '500px';
    createCloneMaskPlugin([document.getElementById('fab')!]).afterClone(ctx);
    const box = ctx.clone.firstElementChild as HTMLElement;
    expect(box.style.position).toBe('absolute');
    expect(box.style.left).toBe('700px');
    expect(box.style.top).toBe('500px');
  });

  it('masks the capture root itself by emptying it', () => {
    document.body.innerHTML = '<main id="root"><p>secret</p></main>';
    const main = document.querySelector('main')!;
    const ctx = cloneWithMap(main);
    createCloneMaskPlugin([main]).afterClone(ctx);
    expect(ctx.clone.childNodes).toHaveLength(0);
    expect((ctx.clone as HTMLElement).style.background).toContain('rgb(0, 0, 0)');
  });

  it('beforeRender strips anything a later snapDOM pass added to a box', () => {
    document.body.innerHTML = '<main><div id="secret">s</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    const plugin = createCloneMaskPlugin([document.getElementById('secret')!]);
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

  it('is inert without targets or without a nodeMap', () => {
    document.body.innerHTML = '<main><div id="secret">s</div></main>';
    const ctx = cloneWithMap(document.querySelector('main')!);
    createCloneMaskPlugin([]).afterClone(ctx);
    createCloneMaskPlugin([document.getElementById('secret')!]).afterClone({ clone: ctx.clone });
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
