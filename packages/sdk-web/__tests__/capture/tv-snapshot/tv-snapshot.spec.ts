// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/capture/tv-snapshot/serialize.js', () => ({ takeDomSnapshot: vi.fn() }));
vi.mock('../../../src/capture/tv-snapshot/render-client.js', () => ({ renderSnapshot: vi.fn() }));

import { takeDomSnapshot } from '../../../src/capture/tv-snapshot/serialize.js';
import { renderSnapshot } from '../../../src/capture/tv-snapshot/render-client.js';
import {
  MAX_DOM_SNAPSHOT_COMPRESSED_BYTES,
  MAX_DOM_SNAPSHOT_DECOMPRESSED_BYTES,
  MAX_DOM_SNAPSHOT_DEPTH,
  type DomSnapshotV1,
} from '@everframe/protocol';
import { captureTvShot, isWeakTvProfile, packSnapshot, WEAK_TV_SNAPSHOT_MAX_ELEMENTS, type TvShotDeps } from '../../../src/capture/tv-snapshot/tv-snapshot.js';

const WEBOS6 = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager';
const WEBOS4 = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36 WebAppManager';
const render = { platform: 'webos', viewport: { width: 1280, height: 720 }, dpr: 2, fontStatus: 'loaded' };
const taken = {
  doc: {
    v: 1,
    events: [
      { type: 4, timestamp: 1, data: { href: 'https://tv.example.test/', width: 1280, height: 720 } },
      { type: 2, timestamp: 1, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } },
    ],
    context: {},
  },
  masked: false,
  render,
};
const image = { blob: new Blob(['i'], { type: 'image/webp' }), width: 2560, height: 1440, sha256: 'c'.repeat(64) };

function deps(overrides: Partial<TvShotDeps> = {}): TvShotDeps {
  return {
    snapshot: { win: window, doc: document, sensitiveElements: () => [], isSensitive: () => false },
    render: { url: 'https://api.example.test/api/render', sdkKey: 'k', fetchImpl: vi.fn() as unknown as typeof fetch },
    fallbackCapture: vi.fn(async () => image),
    userAgent: WEBOS6,
    gzip: async (b) => b,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(takeDomSnapshot).mockReset().mockReturnValue(taken as never);
  vi.mocked(renderSnapshot).mockReset();
  document.body.innerHTML = '<p>hi</p>';
});

describe('captureTvShot', () => {
  it('takes the snapshot synchronously, before returning', () => {
    vi.mocked(renderSnapshot).mockResolvedValue({ ok: false, reason: 'render_failed' });
    const started = captureTvShot(deps());
    expect(takeDomSnapshot).toHaveBeenCalledTimes(1);
    return started.shot;
  });

  it('renders: image + snapshot + render context, sized from viewport×dpr fallback', async () => {
    vi.mocked(renderSnapshot).mockResolvedValue({ ok: true, blob: image.blob, width: 2560, height: 1440, meta: { blank: false, missingAssets: 0, missingAssetUrls: [], fontsSubstituted: false, renderMs: 1 } });
    const shot = await captureTvShot(deps()).shot;
    expect(shot.image).toMatchObject({ width: 2560, height: 1440 });
    expect(shot.snapshot?.byteLength).toBeGreaterThan(0);
    expect(shot.snapshot?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(shot.render).toEqual(render);
    expect(shot.degradedReason).toBeUndefined();
    expect(vi.mocked(renderSnapshot).mock.calls[0]![1].fallbackSize).toEqual({ width: 2560, height: 1440 });
  });

  it('flags a blank server render screenshot_blank but keeps the image', async () => {
    vi.mocked(renderSnapshot).mockResolvedValue({ ok: true, blob: image.blob, width: 10, height: 10, meta: { blank: true, missingAssets: 0, missingAssetUrls: [], fontsSubstituted: false, renderMs: 1 } });
    const shot = await captureTvShot(deps()).shot;
    expect(shot.degradedReason).toBe('screenshot_blank');
    expect(shot.image?.degradedReason).toBe('screenshot_blank');
  });

  it('render failure → the snapshot alone, screenshot_render_failed; no on-device fallback', async () => {
    vi.mocked(renderSnapshot).mockResolvedValue({ ok: false, reason: 'render_unavailable' });
    const d = deps();
    const shot = await captureTvShot(d).shot;
    expect(shot).toMatchObject({ degradedReason: 'screenshot_render_failed', render });
    expect(shot.image).toBeUndefined();
    expect(shot.snapshot).toBeDefined();
    expect(d.fallbackCapture).not.toHaveBeenCalled();
  });

  it('snapshot failure on a capable TV → on-device fallback image', async () => {
    vi.mocked(takeDomSnapshot).mockImplementation(() => { throw new Error('boom'); });
    const shot = await captureTvShot(deps()).shot;
    expect(shot).toEqual({ image });
    expect(renderSnapshot).not.toHaveBeenCalled();
  });

  it('snapshot failure on webOS 4 (Chrome 53) → unavailable; the fallback never runs', async () => {
    vi.mocked(takeDomSnapshot).mockImplementation(() => { throw new Error('boom'); });
    const d = deps({ userAgent: WEBOS4 });
    await expect(captureTvShot(d).shot).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
    expect(d.fallbackCapture).not.toHaveBeenCalled();
  });

  it('snapshot failure on a page over 3000 elements → unavailable', async () => {
    vi.mocked(takeDomSnapshot).mockImplementation(() => { throw new Error('boom'); });
    document.body.innerHTML = '<i></i>'.repeat(3001);
    const d = deps();
    await expect(captureTvShot(d).shot).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
    expect(d.fallbackCapture).not.toHaveBeenCalled();
  });

  it('a fallback placeholder (screenshot_failed) or a throwing fallback → unavailable, never a fake image', async () => {
    vi.mocked(takeDomSnapshot).mockImplementation(() => { throw new Error('boom'); });
    const placeholder = deps({ fallbackCapture: vi.fn(async () => ({ ...image, width: 1, height: 1, degradedReason: 'screenshot_failed' })) });
    await expect(captureTvShot(placeholder).shot).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
    const throwing = deps({ fallbackCapture: vi.fn(async () => { throw new Error('x'); }) });
    await expect(captureTvShot(throwing).shot).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
  });

  it('an oversized snapshot counts as a snapshot failure', async () => {
    const d = deps({ gzip: async () => new Uint8Array(MAX_DOM_SNAPSHOT_COMPRESSED_BYTES + 1) });
    const shot = await captureTvShot(d).shot;
    expect(shot).toEqual({ image });
    expect(renderSnapshot).not.toHaveBeenCalled();
  });

  it('a snapshot over the protocol node cap counts as a snapshot failure', async () => {
    const children = Array.from({ length: 50_001 }, (_, i) => ({ type: 3, id: i + 2, textContent: '' }));
    vi.mocked(takeDomSnapshot).mockReturnValue({
      ...taken,
      doc: { ...taken.doc, events: [taken.doc.events[0], { type: 2, timestamp: 1, data: { node: { type: 0, id: 1, childNodes: children }, initialOffset: { top: 0, left: 0 } } }] },
    } as never);
    const shot = await captureTvShot(deps()).shot;
    expect(shot).toEqual({ image });
    expect(renderSnapshot).not.toHaveBeenCalled();
  });

  it('a snapshot deeper than the protocol depth cap counts as a snapshot failure (ruling S8)', async () => {
    vi.mocked(takeDomSnapshot).mockReturnValue({ ...taken, doc: withRoot(nested(MAX_DOM_SNAPSHOT_DEPTH + 1)) } as never);
    const shot = await captureTvShot(deps()).shot;
    expect(shot).toEqual({ image });
    expect(renderSnapshot).not.toHaveBeenCalled();
  });

  it('a snapshot over the decompressed JSON byte cap counts as a snapshot failure', async () => {
    const big = { type: 3, id: 2, textContent: 'x'.repeat(MAX_DOM_SNAPSHOT_DECOMPRESSED_BYTES) };
    vi.mocked(takeDomSnapshot).mockReturnValue({ ...taken, doc: withRoot({ type: 0, id: 1, childNodes: [big] }) } as never);
    const gzip = vi.fn(async (b: Uint8Array) => b);
    const shot = await captureTvShot(deps({ gzip })).shot;
    expect(shot).toEqual({ image });
    expect(gzip).not.toHaveBeenCalled();
    expect(renderSnapshot).not.toHaveBeenCalled();
  });

  it('a RangeError from serializing an extremely deep live DOM → fallback, never a rejection', async () => {
    vi.mocked(takeDomSnapshot).mockImplementation(() => { throw new RangeError('Maximum call stack size exceeded'); });
    const d = deps();
    const started = captureTvShot(d);
    await expect(started.snapshotted).resolves.toBeUndefined();
    await expect(started.shot).resolves.toEqual({ image });
    expect(d.fallbackCapture).toHaveBeenCalledTimes(1);
  });

  it('a throwing gzip counts as a snapshot failure', async () => {
    const shot = await captureTvShot(deps({ gzip: async () => { throw new Error('no CompressionStream'); } })).shot;
    expect(shot).toEqual({ image });
    expect(renderSnapshot).not.toHaveBeenCalled();
  });

  describe('weak-profile freeze guard (1,000 elements)', () => {
    const page = (elements: number): void => {
      // html, head, body are 3 of them.
      document.body.innerHTML = '<i></i>'.repeat(elements - 3);
      expect(document.getElementsByTagName('*').length).toBe(elements);
    };

    it('exports the cap', () => {
      expect(WEAK_TV_SNAPSHOT_MAX_ELEMENTS).toBe(1000);
    });

    it('a weak profile above the cap takes no snapshot and no fallback: screenshot_unavailable', async () => {
      page(WEAK_TV_SNAPSHOT_MAX_ELEMENTS + 1);
      const d = deps({ userAgent: WEBOS4 });
      const shot = await captureTvShot(d).shot;
      expect(takeDomSnapshot).not.toHaveBeenCalled();
      expect(renderSnapshot).not.toHaveBeenCalled();
      expect(d.fallbackCapture).not.toHaveBeenCalled();
      expect(shot).toEqual({ degradedReason: 'screenshot_unavailable' });
    });

    it('a weak profile at the cap still snapshots', async () => {
      page(WEAK_TV_SNAPSHOT_MAX_ELEMENTS);
      vi.mocked(renderSnapshot).mockResolvedValue({ ok: false, reason: 'render_failed' });
      await captureTvShot(deps({ userAgent: WEBOS4 })).shot;
      expect(takeDomSnapshot).toHaveBeenCalledTimes(1);
    });

    it('a capable profile above the cap still snapshots', async () => {
      page(WEAK_TV_SNAPSHOT_MAX_ELEMENTS + 500);
      vi.mocked(renderSnapshot).mockResolvedValue({ ok: false, reason: 'render_failed' });
      await captureTvShot(deps({ userAgent: WEBOS6 })).shot;
      expect(takeDomSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  it('classifies weak profiles', () => {
    expect(isWeakTvProfile(WEBOS4)).toBe(true);
    expect(isWeakTvProfile(WEBOS6)).toBe(false);
    expect(isWeakTvProfile('Mozilla/5.0 (SMART-TV; Linux; Tizen 3.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/3.0 TV Safari/538.1')).toBe(true);
  });
});

/** `depth` nested elements under the document node (`<html>` = depth 1), built iteratively. */
function nested(depth: number): unknown {
  let node: Record<string, unknown> = { type: 3, id: depth + 2, textContent: 'leaf' };
  for (let d = depth; d >= 1; d--) node = { type: 2, id: d + 1, tagName: 'div', attributes: {}, childNodes: [node] };
  return { type: 0, id: 1, childNodes: [node] };
}

function withRoot(node: unknown): DomSnapshotV1 {
  return {
    ...taken.doc,
    events: [taken.doc.events[0], { type: 2, timestamp: 1, data: { node, initialOffset: { top: 0, left: 0 } } }],
  } as unknown as DomSnapshotV1;
}

describe('packSnapshot', () => {
  const identity = async (b: Uint8Array): Promise<Uint8Array> => b;

  it('packs a snapshot at exactly the depth cap and hashes the shipped bytes', async () => {
    const packed = await packSnapshot(withRoot(nested(MAX_DOM_SNAPSHOT_DEPTH)), identity);
    expect(packed.byteLength).toBe(packed.bytes.byteLength);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', packed.bytes as BufferSource));
    expect(packed.sha256).toBe([...digest].map((b) => b.toString(16).padStart(2, '0')).join(''));
  });

  it('rejects one level past the depth cap', async () => {
    await expect(packSnapshot(withRoot(nested(MAX_DOM_SNAPSHOT_DEPTH + 1)), identity)).rejects.toThrow('snapshot_too_deep');
  });

  it('rejects past the node cap, the JSON byte cap and the gzip byte cap', async () => {
    const many = Array.from({ length: 50_001 }, (_, i) => ({ type: 3, id: i + 2, textContent: '' }));
    await expect(packSnapshot(withRoot({ type: 0, id: 1, childNodes: many }), identity)).rejects.toThrow('snapshot_too_large');
    const big = { type: 3, id: 2, textContent: 'x'.repeat(MAX_DOM_SNAPSHOT_DECOMPRESSED_BYTES) };
    await expect(packSnapshot(withRoot({ type: 0, id: 1, childNodes: [big] }), identity)).rejects.toThrow('snapshot_too_large');
    await expect(
      packSnapshot(taken.doc as unknown as DomSnapshotV1, async () => new Uint8Array(MAX_DOM_SNAPSHOT_COMPRESSED_BYTES + 1)),
    ).rejects.toThrow('snapshot_too_large');
  });

  it('accepts a gzip body at exactly the compressed cap', async () => {
    const packed = await packSnapshot(taken.doc as unknown as DomSnapshotV1, async () => new Uint8Array(MAX_DOM_SNAPSHOT_COMPRESSED_BYTES));
    expect(packed.byteLength).toBe(MAX_DOM_SNAPSHOT_COMPRESSED_BYTES);
  });
});

describe('captureTvShot reporting ownership (kill)', () => {
  it('takes no snapshot and posts nothing when ownership already changed', async () => {
    const d = deps({ isCurrent: () => false });
    await expect(captureTvShot(d).shot).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
    expect(takeDomSnapshot).not.toHaveBeenCalled();
    expect(renderSnapshot).not.toHaveBeenCalled();
    expect(d.fallbackCapture).not.toHaveBeenCalled();
  });

  it('does not post the snapshot when ownership changes before the render request', async () => {
    let current = true;
    const d = deps({ isCurrent: () => current, gzip: async (b) => { current = false; return b; } });
    await expect(captureTvShot(d).shot).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
    expect(renderSnapshot).not.toHaveBeenCalled();
    expect(d.fallbackCapture).not.toHaveBeenCalled();
  });

  it('drops a render that completes after ownership changed', async () => {
    let current = true;
    vi.mocked(renderSnapshot).mockImplementation(async () => {
      current = false;
      return { ok: true, blob: image.blob, width: 1, height: 1, meta: { blank: false, missingAssets: 0, missingAssetUrls: [], fontsSubstituted: false, renderMs: 1 } };
    });
    await expect(captureTvShot(deps({ isCurrent: () => current })).shot).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
  });

  it('runs no on-device fallback after ownership changed', async () => {
    let current = true;
    vi.mocked(takeDomSnapshot).mockImplementation(() => {
      current = false;
      throw new Error('boom');
    });
    const d = deps({ isCurrent: () => current });
    await expect(captureTvShot(d).shot).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
    expect(d.fallbackCapture).not.toHaveBeenCalled();
  });
});
